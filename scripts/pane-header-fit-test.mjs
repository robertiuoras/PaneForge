// Can a pane's header still be USED once the pane is narrow?
//
// Measured on this desk 2026-08-28, seven panes in a 900px window: each pane 198px wide,
// its header wanting 297-357px of the 196px it had, and `.pt-close` drawn 100-160px PAST
// the pane's own right edge. That is Robert's "the header is cut off in a small window -
// I can't reach the x". A control drawn off the edge of a pane is worse than one in a
// menu: it cannot be pressed, and nothing on screen says it is there.
//
// So this is the measurement, in a real browser, over the SHIPPED stylesheet - the same
// trick scripts/card-fit-test.mjs uses, and for the same reason: a comment saying
// "measured at 198px" is a memory of a measurement, not one.
//
// The last case is the CONTROL: the same header with the two rules this test exists for
// put back the way they were, which must NOT fit. A fit test that cannot fail is a test
// that passes over a broken header.
//
//   node scripts/pane-header-fit-test.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  console.log('pane header fit: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

/**
 * The pane header as App.tsx draws it, in a pane of the given width.
 *
 * The controls are the ones a desk pane really carries; the widths that matter are the
 * agent picker (the fat one) and the three the container queries leave on the line.
 */
function page(width, undo = '') {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}
  ${css}
  ${undo}
  </style>
  <div class="app"><div class="panes grid" style="width:${width}px">
    <div class="pane" style="width:${width}px">
      <div class="pane-title">
        <span class="dot idle"></span>
        <span class="agent-logo"><svg viewBox="0 0 14 14" width="14" height="14"></svg></span>
        <span class="pt-name">manic-s-auction-house</span>
        <button class="git-badge pressable">master</button>
        <span class="elapsed pt-open">20h 44m</span>
        <span class="elapsed done pt-clock">11s</span>
        <span class="pt-path">/Users/robertiuoras/Projects/manic-s-auction-house</span>
        <span class="pt-actions">
          <button class="icon pt-find">&#8981;</button>
          <span class="agent-pick small">Claude Code</span>
          <button class="icon danger pt-clear">C</button>
          <button class="icon pt-restart">&#10227;</button>
          <button class="icon fix">Fix</button>
          <button class="icon desk-only pt-reveal">F</button>
          <button class="icon desk-only">E</button>
          <button class="icon pt-zoom">Z</button>
          <button class="ghost small desk-only pt-handoff">Remote</button>
          <button class="icon pt-more">&#8943;</button>
          <button class="icon pt-close">&#215;</button>
        </span>
      </div>
      <div style="height:40px"></div>
    </div>
  </div></div>`
}

// Every width a pane really gets on this desk. 198px is seven panes in a 900px window,
// which is the shape that was reported; 465px is three in 1700px; 900px is one.
const CASES = [
  { name: 'one pane in a wide window', width: 900 },
  { name: 'three panes in a 1700px window', width: 465 },
  { name: 'just above the narrow step', width: 400 },
  { name: 'just below it', width: 370 },
  { name: 'seven panes in a 900px window', width: 198 },
  // The control. Both halves of the fix undone: the picker back on the line at every
  // width, and the name refusing to give any of its width up. This must FAIL to fit.
  {
    name: 'CONTROL - the header as it was',
    width: 198,
    control: true,
    undo: `@container pane (max-width: 380px) { .pane-title .agent-pick { display: flex } }
           @container pane (max-width: 300px) { .pane-title .agent-logo { display: inline-flex } }
           .pt-name { flex: none; overflow: visible; text-overflow: clip; min-width: auto }`
  }
]

const profile = mkdtempSync(join(tmpdir(), 'pf-headerfit-'))

/**
 * A port the OS says is free, not a number written into the file.
 *
 * Two lane worktrees running `npm test` at once is the ordinary case here, and a fixed port
 * means the second one gets a Chrome that never binds and then "Chrome never opened its
 * debugging port" - which reads as a broken card, not as a busy port. Same as
 * scripts/confirm-fit-test.mjs; `PF_HEADERFIT_PORT` pins it when something outside needs to
 * attach.
 */
async function freePort() {
  const fixed = Number(process.env.PF_HEADERFIT_PORT)
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

// `existsSync` above proves the file is there, not that it can be RUN. A binary with no
// execute bit fails asynchronously, and an unhandled 'error' event kills this process with
// no line saying so.
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
    await send(
      'Page.navigate',
      { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(c.width, c.undo ?? '')) },
      sessionId
    )
    await evaluate('document.fonts.ready.then(() => 1)')
    const m = await evaluate(`(() => {
      const pane = document.querySelector('.pane')
      const bar = document.querySelector('.pane-title')
      const pr = pane.getBoundingClientRect()
      const seen = (sel) => {
        const el = bar.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: r.width, right: r.right, inside: r.width > 0 && r.right <= pr.right + 0.5 }
      }
      return {
        pane: pr.width,
        paneRight: pr.right,
        wants: bar.scrollWidth,
        has: bar.clientWidth,
        close: seen('.pt-close'),
        more: seen('.pt-more'),
        find: seen('.pt-find'),
        name: (() => { const n = bar.querySelector('.pt-name'); const r = n.getBoundingClientRect(); return { w: r.width, want: n.scrollWidth } })()
      }
    })()`)

    // 1px of slack: a fractional layout rounds `scrollWidth` up to a whole pixel.
    const fitted = m.wants <= m.has + 1
    const reach = (x) => Boolean(x && x.inside)
    const detail = `pane ${m.pane.toFixed(0)}px, header wants ${m.wants}px of ${m.has}px, close ends at ${m.close ? m.close.right.toFixed(0) : '-'} of ${m.paneRight.toFixed(0)}`
    if (c.control) {
      // The red-proof, asserted the only honest way round: with the fix undone the close
      // button really is drawn off the pane, so a green run here means the test cannot see
      // the bug it exists for.
      ok(!fitted, `${c.name}: still overflows, so the assertions above can fail`, detail)
      ok(!reach(m.close), `${c.name}: and the close button is off the pane`, detail)
    } else {
      ok(fitted, `${c.name}: the header fits the pane`, detail)
      ok(reach(m.close), `${c.name}: the close button can be pressed`, detail)
      // Everything else is one press away behind the ⋯; those two never may be.
      ok(reach(m.find) || m.pane < 200, `${c.name}: find is on the line`, detail)
      ok(
        m.pane > 460 ? true : reach(m.more),
        `${c.name}: the ⋯ that holds the rest is on the line`,
        detail
      )
      // A name squeezed to nothing is the other half of the reported bug: the header
      // "fits" by drawing no name at all.
      ok(m.name.w >= 30, `${c.name}: the pane still says which pane it is`, `name ${m.name.w.toFixed(1)}px of ${m.name.want}px`)
    }
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  chrome.kill()
  await sleep(300)
  // A killed Chrome keeps writing its profile for a moment after the signal, so a plain
  // rmSync throws ENOTEMPTY and fails a run whose every assertion passed - which is a
  // test that reports a tidy-up race as a broken card. Retry, and never let the cleanup
  // decide the result: what this test measures is above, in `failures`.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    /* a temp dir the OS will collect; it is not this test's verdict */
  }
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} pane-header-fit checks passed`)
process.exit(failures ? 1 : 0)
