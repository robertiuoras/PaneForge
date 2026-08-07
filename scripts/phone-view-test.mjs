// The phone client in a REAL browser, against a REAL running copy of the app.
//
// `npm run test:phone` proves the server: what it refuses, what it routes, what survives
// the wire. It cannot prove the thing that actually matters here - that the renderer boots
// at the far end - because the renderer needs a browser and the handlers need a desk.
// Nothing about "it builds" or "the diff looks right" catches a client that loads and then
// sits blank, which is the failure this whole feature would have.
//
// So: system Chrome, headless, driven over CDP with no dependency (the same raw-CDP trick
// `scripts/probe.mjs` uses on the Electron window). It types the code into the pairing
// page like a person would - the cookie is HttpOnly, so there is no way to shortcut it -
// and then reads the mounted DOM.
//
//   npm run build && npm run try -- --keep --show
//   node scripts/phone-view-test.mjs --port 7399 --code PF2345
//
// Out of `npm test` on purpose: it needs a window up and a port bound.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', 7399))
const code = String(arg('code', 'PF2345'))
const base = `http://127.0.0.1:${port}`

let failures = 0
let checks = 0
const ok = (cond, what, detail = '') => {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p))

if (!CHROME) {
  console.log('phone view: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

// Is the desk even up? A connection refused here is not a failing test, it is a missing
// precondition, and saying so out loud beats 12 mystery failures.
const alive = await fetch(base + '/', { redirect: 'manual' }).catch(() => null)
if (!alive) {
  console.log(`phone view: SKIPPED - nothing is serving on ${base}`)
  console.log('  start it with: npm run build && npm run try -- --keep --show')
  process.exit(0)
}

const profile = mkdtempSync(join(tmpdir(), 'pf-chrome-'))
const cdpPort = 9444
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // A phone-sized viewport, because that is what this client is for.
    '--window-size=414,896',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browserSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      const info = await res.json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome never opened its debugging port')
}

/** Minimal CDP client: one socket, ids, and flattened target sessions. */
function client(ws) {
  let next = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 20_000)
    })
}

const wsUrl = await browserSocket()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
const send = client(ws)

const { targetId } = await send('Target.createTarget', { url: base + '/' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const evaluate = async (expression) => {
  const res = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  )
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'threw')
  return res.result.value
}

try {
  await send('Runtime.enable', {}, sessionId)
  await sleep(700)

  // ---- 1. an unpaired browser gets the pairing page, and only that -------------
  const first = await evaluate(`({
    title: document.title,
    hasInput: !!document.querySelector('#c'),
    hasApp: !!document.querySelector('#root'),
    api: typeof window.api
  })`)
  ok(first.hasInput, 'the pairing page is what a new browser loads', JSON.stringify(first))
  ok(!first.hasApp, 'and the app itself is not in that document')
  ok(first.api === 'undefined', 'nothing has put an api on the page yet')

  // ---- 2. type the code, the way a person does --------------------------------
  await evaluate(`(() => {
    document.querySelector('#c').value = ${JSON.stringify(code)}
    document.querySelector('#f').dispatchEvent(new Event('submit'))
    return true
  })()`)
  // The page reloads itself once the cookie is set.
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const has = await evaluate(`!!document.querySelector('#root')`).catch(() => false)
    if (has) break
  }

  // A desk with no panes proves nothing about a client that draws panes, so the browser
  // opens one itself - through the link, which is also the first half of "full control".
  const opened = await evaluate(`(async () => {
    const have = await window.api.listSessions()
    if (have.length) return 'already ' + have.length
    const s = await window.api.startSession({ cwd: ${JSON.stringify(process.cwd())}, agent: 'shell' })
    return 'started ' + s.id
  })()`).catch((e) => `failed: ${e.message}`)
  ok(!String(opened).startsWith('failed'), 'a pane can be opened from the phone', String(opened))
  await sleep(1200)

  // ---- 3. the renderer boots, over HTTP, with the HTTP transport ---------------
  let mounted = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    mounted = await evaluate(`({
      api: typeof window.api,
      sidebar: !!document.querySelector('.sidebar'),
      cards: document.querySelectorAll('.sidebar .list .row').length,
      panes: document.querySelectorAll('.xterm-screen').length,
      errors: (window.__pfErrors ?? []).length
    })`).catch(() => null)
    if (mounted?.sidebar) break
  }
  ok(!!mounted, 'the page answers after pairing')
  ok(mounted?.api === 'object', 'window.api exists in the browser', String(mounted?.api))
  ok(!!mounted?.sidebar, 'the app mounted - the sidebar is on screen')
  ok((mounted?.cards ?? 0) >= 1, 'and the desk arrived: at least one pane card', String(mounted?.cards))
  ok((mounted?.panes ?? 0) >= 1, 'a terminal is rendered', String(mounted?.panes))

  // ---- 4. it is live, not a snapshot ------------------------------------------
  // Type into the pane over the link and read the pty's answer back out of the DOM.
  const typed = `echo phone-was-here-${Date.now() % 100000}`
  const marker = typed.split(' ')[1]
  const wrote = await evaluate(`(async () => {
    const list = await window.api.listSessions()
    const id = list[0]?.id
    if (!id) return 'no pane'
    window.api.write(id, ${JSON.stringify(typed)} + '\\r')
    return id
  })()`)
  ok(typeof wrote === 'string' && wrote !== 'no pane', 'a keystroke went up the link', String(wrote))

  // The pane's text is NOT in the DOM - xterm draws to a canvas - so this reads the
  // terminal's own buffer through the handle TerminalPane puts on `window.__pf`. Looking
  // for it in innerText finds nothing and would fail against a perfectly live pane.
  let echoed = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    echoed = await evaluate(`(() => {
      const pane = window.__pf?.[${JSON.stringify(wrote)}]
      const term = pane?.term
      if (!term) return false
      const buf = term.buffer.active
      let text = ''
      for (let y = 0; y < buf.length; y++) text += buf.getLine(y)?.translateToString(true) + '\\n'
      return text.includes(${JSON.stringify(marker)})
    })()`).catch(() => false)
    if (echoed) break
  }
  ok(echoed, 'and the pty answered on the phone - the stream is live both ways')

  // ---- 5. the count on the desk knows about this browser ----------------------
  const seen = await evaluate(`(async () => (await window.api.phoneState()).clients)()`)
  ok(seen >= 1, 'the desk counts this browser as watching', String(seen))

  // ---- 6. a phone is not a small desktop --------------------------------------
  // The numbers, not the look: at 414px the desktop layout leaves a pane 132px wide, and
  // a screenshot of that reads as "narrow" rather than as "unusable".
  const box = (sel) => `(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), shown: getComputedStyle(el).display !== 'none' }
  })()`

  const list = await evaluate(`({
    width: innerWidth,
    handheld: document.documentElement.classList.contains('handheld'),
    listing: document.documentElement.classList.contains('handheld-list'),
    sidebar: ${box('.sidebar')},
    panes: ${box('.panes')}
  })`)
  ok(list.width <= 720, 'the viewport really is phone-sized', String(list.width))
  ok(list.handheld, 'the layout knows it is on a handheld')

  // Back to the list, since opening a pane above left it on the pane.
  await evaluate(`document.querySelector('.handheld-back')?.click()`)
  await sleep(400)
  const home = await evaluate(`({
    sidebar: ${box('.sidebar')},
    panes: ${box('.panes')}
  })`)
  ok(home.sidebar?.shown === true, 'the list is the home screen')
  ok(
    home.sidebar?.w >= list.width - 2,
    'and it has the whole width, not 282px of it',
    String(home.sidebar?.w)
  )
  ok(home.panes?.shown === false, 'the panes are not sharing the screen with it')

  // Tap a pane the way a finger would.
  await evaluate(`document.querySelector('.sidebar .list .row')?.click()`)
  await sleep(600)
  const pane = await evaluate(`({
    sidebar: ${box('.sidebar')},
    panes: ${box('.panes')},
    back: ${box('.handheld-back')},
    cols: Object.values(window.__pf ?? {})[0]?.term?.cols ?? 0,
    hit: (() => {
      const b = document.querySelector('.handheld-back')
      if (!b) return 'no chip'
      const r = b.getBoundingClientRect()
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return el === b || b.contains(el) ? 'chip' : (el?.className ?? 'something else')
    })()
  })`)
  ok(pane.sidebar?.shown === false, 'a tapped pane takes the screen')
  ok(pane.panes?.w >= list.width - 12, 'the pane has the width', String(pane.panes?.w))
  ok(pane.cols >= 40, 'which is a usable terminal, not 16 columns', `${pane.cols} cols`)
  ok(pane.back?.shown === true && pane.back.h >= 34, 'the way back is a finger-sized chip', JSON.stringify(pane.back))
  ok(pane.hit === 'chip', 'and nothing is drawn over it', String(pane.hit))
} finally {
  // A CDP browser left open against a live server is the 17 GB mistake; close it.
  await send('Target.closeTarget', { targetId }).catch(() => {})
  ws.close()
  chrome.kill()
  // Chrome is still flushing its profile as it dies, so a removal here races it and
  // throws ENOTEMPTY - which would fail a passing run over a temp folder nobody reads.
  await sleep(400)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* the OS clears its own temp dir */
  }
}

console.log(`phone view: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
