// Can the hand-off box still be ANSWERED once real names are in it?
//
// Hand off used to be a ghost button on the third row of a card inside Devices, and the
// screen it lived on carries pairing codes, a QR, a tunnel switch and a mirror list. It
// is its own box now, and the failure mode of its own box is the one confirm-fit-test
// already caught once for the confirm dialog: a sticky footer sitting ON the last row,
// a primary button drifting away from the cancel beside it, or a device name squeezed to
// nothing by the chip next to it. Every one of those looks fine in a diff.
//
// So this measures the shipped stylesheet in a real headless Chrome, with the markup
// HandoffDialog.tsx really renders - a long machine name, a long address, an offline row
// with a Connect button, and the mid-turn note that only appears sometimes - at the
// smallest window the app is used in as well as a big one.
//
//   node scripts/handoff-fit-test.mjs

import { spawn } from 'node:child_process'
import { closeTestChrome } from './close-test-chrome.mjs'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')

let failures = 0
let checks = 0
const ok = (cond, what, detail = '') => {
  checks++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` - ${detail}` : ''}`)
  if (!cond) failures++
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p))

if (!CHROME) {
  console.log('handoff fit: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

const dev = (name, address, panes, picked) => `
  <button class="ho-dev${picked ? ' picked' : ''}">
    <span class="dev-glyph small online"><svg viewBox="0 0 16 16" width="100%" height="100%"></svg></span>
    <span class="ho-dev-text">
      <span class="ho-dev-name">${name}</span>
      <span class="ho-dev-sub"><span class="dot online"></span>${address} · ${panes} panes there</span>
    </span>
    <span class="ho-tick">${picked ? '✓' : ''}</span>
  </button>`

const offline = (name, why) => `
  <div class="ho-dev off">
    <span class="dev-glyph small off"><svg viewBox="0 0 16 16" width="100%" height="100%"></svg></span>
    <span class="ho-dev-text">
      <span class="ho-dev-name">${name}</span>
      <span class="ho-dev-sub"><span class="dot off"></span>${why}</span>
    </span>
    <button class="ghost small">Connect</button>
  </div>`

const NOTE = `<p class="ho-note">This pane is mid-turn. Nothing is interrupted: it is queued and moves the moment the turn ends, with the answer intact.</p>`

function page({ note, devices, title }) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}
  ${css}
  </style>
  <div class="overlay"><div class="dialog handoff-dialog">
    <div class="dialog-head"><strong>Hand off ${title}</strong><button class="x">×</button></div>
    <p class="ho-lead">The work moves to another machine and keeps going there. The pty cannot travel, so everything that outlives it does: uncommitted code is pushed as an <code>auto-sync</code> commit, the conversation and the screen go over the link, and any dev server this pane had running is started again over there. The pane closes here and comes straight back as a mirror, so you keep watching it.</p>
    ${note ? NOTE : ''}
    <div class="ho-list">${devices}</div>
    <div class="dialog-foot ho-foot">
      <button class="ghost">Pair a device</button>
      <span class="ho-spacer"></span>
      <button class="ghost">Cancel</button>
      <button class="primary">Queue for DESKTOP-CMSUCM1</button>
    </div>
  </div></div>`
}

const CASES = [
  {
    name: 'one machine, idle pane',
    sizes: [[900, 700]],
    html: page({ title: 'PaneForge', devices: dev('DESKTOP-CMSUCM1', '100.78.1.77', 3, true) })
  },
  {
    name: 'mid-turn, two machines, one offline',
    sizes: [[900, 700], [820, 560]],
    html: page({
      title: 'lane a',
      note: true,
      devices:
        dev('DESKTOP-CMSUCM1', '100.78.1.77', 12, true) +
        dev('Roberts-MacBook-Pro-14-inch-M1', '192.168.1.144', 0, false) +
        offline('OLD-TOWER-IN-THE-CUPBOARD', 'Nothing is listening on 192.168.1.9:7311')
    })
  },
  {
    // The case the dialog has to survive rather than look good in: more machines than fit,
    // so the list scrolls and the footer must still be reachable.
    name: 'six machines in a short window',
    sizes: [[900, 560]],
    html: page({
      title: 'a pane with a rather long name somebody typed',
      note: true,
      devices:
        Array.from({ length: 6 }, (_, i) => dev(`DESKTOP-NUMBER-${i + 1}`, `100.78.1.${i + 10}`, i, i === 0)).join('')
    })
  }
]

const profile = mkdtempSync(join(tmpdir(), 'pf-hofit-'))

async function freePort() {
  const fixed = Number(process.env.PF_HOFIT_PORT)
  if (Number.isFinite(fixed) && fixed > 0) return fixed
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const cdpPort = await freePort()
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=900,700',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

let spawnFailed = null
chrome.on('error', (err) => {
  spawnFailed = err
})
let chromeExit = null
chrome.on('exit', (code, signal) => {
  chromeExit = signal ? `killed by ${signal}` : `exited with code ${code}`
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browserSocket() {
  for (let i = 0; i < 40; i++) {
    if (spawnFailed) throw new Error(`Chrome could not be started: ${spawnFailed.message}`)
    try {
      const info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error(
    `Chrome never opened its debugging port ${cdpPort}` +
      (chromeExit ? ` - it ${chromeExit}` : ' - it is still running, so the port is likely in use')
  )
}

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
      setTimeout(
        () => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))),
        20_000
      )
    })
}

let ws
try {
  ws = new WebSocket(await browserSocket())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = client(ws)
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw')
    return r.result.value
  }

  for (const c of CASES) {
    for (const [width, height] of c.sizes) {
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId
      )
      await send(
        'Page.navigate',
        { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(c.html) },
        sessionId
      )
      await evaluate('document.fonts.ready.then(() => 1)')
      const m = await evaluate(`(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height } }
        const dlg = document.querySelector('.dialog.handoff-dialog')
        const foot = document.querySelector('.ho-foot')
        const primary = document.querySelector('.ho-foot .primary')
        const cancel = [...document.querySelectorAll('.ho-foot .ghost')].pop()
        const list = document.querySelector('.ho-list')
        // The TEXT's own width, measured with a Range, not scrollWidth: these spans are
        // flex children that stretch to the row, so scrollWidth answers about the box and
        // reports every name as 1-2px over. A Range says how wide the glyphs really are,
        // which is the only thing that can be cut off.
        const textWidth = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width }
        const names = [...document.querySelectorAll('.ho-dev-name')].map((el) => ({ w: el.getBoundingClientRect().width, want: textWidth(el), text: el.textContent }))
        const subs = [...document.querySelectorAll('.ho-dev-sub')].map((el) => ({ w: el.getBoundingClientRect().width, want: el.scrollWidth }))
        const hit = (el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at === el || el.contains(at) }
        return {
          dlg: box(dlg), foot: box(foot), primary: box(primary), cancel: box(cancel), list: box(list),
          names, subs,
          primaryHit: hit(primary), cancelHit: hit(cancel),
          // The gap the confirm dialog once grew between its two answers, because a
          // margin-left:auto on the primary beat the row's own justification.
          gap: box(primary).left - box(cancel).right,
          listScrolls: list.scrollHeight > list.clientHeight + 1,
          h: innerHeight, w: innerWidth
        }
      })()`)

      const at = `${c.name} @ ${width}x${height}`
      ok(m.dlg.bottom <= m.h + 1, `${at}: the box fits the window`, `bottom ${m.dlg.bottom.toFixed(0)} of ${m.h}`)
      ok(m.primaryHit, `${at}: the hand-off button can be pressed`, `${m.primary.w.toFixed(0)}x${m.primary.h.toFixed(0)}`)
      ok(m.cancelHit, `${at}: Cancel can be pressed`)
      ok(m.primary.h >= 28, `${at}: the answers are big enough to hit`, `${m.primary.h.toFixed(1)}px tall`)
      ok(m.gap >= 0 && m.gap <= 24, `${at}: the two answers sit together`, `${m.gap.toFixed(1)}px apart`)
      // The failure this file exists for: a device NAME is what you are choosing between,
      // so it is the one string that may never be the thing that gets cut.
      for (const n of m.names)
        ok(n.want <= n.w + 1, `${at}: "${n.text}" is whole`, `${n.want.toFixed(1)}px of text in ${n.w.toFixed(1)}px`)
      console.log(
        `      dialog ${m.dlg.h.toFixed(0)}px, list ${m.list.h.toFixed(0)}px${m.listScrolls ? ' (scrolls)' : ''}, foot at ${m.foot.top.toFixed(0)}`
      )
    }
  }
} finally {
  await closeTestChrome(chrome, profile, ws)
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} handoff-fit checks passed`)
process.exit(failures ? 1 : 0)
