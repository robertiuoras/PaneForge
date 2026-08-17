// What the app's own yes/no box looks like once a real question is in it.
//
// The question this exists for is the offload one - "Start this pane on <the other
// machine>?" - which is the confirm carrying the most: a title with a device name in it, a
// four-line body, a tick box, and two buttons whose labels are both sentences. Three things
// were wrong on it at once and every one of them came from the dialog SHELL rather than
// from anything written for confirms, which is why nobody looking at the confirm rules
// could see them:
//
//   - the button row is `position: sticky; bottom: 0` so a scrolling dialog keeps its
//     buttons, and sticky pins to the scrollport's bottom EDGE - inside the dialog's own
//     16px of padding. Measured: the primary button's top sat 2px ABOVE the tick box's
//     bottom, on a dialog that was not scrolling at all (scrollHeight 248 === clientHeight
//     248). The `margin-bottom: -16px` beside it was written to prevent exactly this and
//     does not, because it moves the following content and not the pinned box.
//   - `.dialog-row .primary { margin-left: auto }` is right for a footer whose cancel
//     belongs on the far left, and it silently beats the `justify-content: flex-end` the
//     confirm rules ask for: measured 88.6px of automatic margin and a 99px hole between
//     "Keep it here" and "Start on DESKTOP-CMSUCM1".
//   - `.ghost` and `.primary` carry different padding, so the two answers to one question
//     were 34.8px and 38.8px tall and each stuck 2px out of the other.
//
// All three are arithmetic over the SHIPPED stylesheet, so all three are measurable, and a
// comment recording the numbers is a memory of a measurement rather than one. Same shape as
// scripts/card-fit-test.mjs: system Chrome over raw CDP, no window, no server, and it SKIPS
// out loud with no Chrome rather than passing.
//
// The long case is the control. Making the row static would fix the overlap and quietly
// take the pinning with it, so a confirm whose body outgrows the window would scroll its
// buttons off the bottom - which is the bug the sticky was added for. It is asserted here
// so that fix cannot be applied by accident.
//
//   node scripts/confirm-fit-test.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  console.log('confirm fit: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

const DEVICE = 'DESKTOP-CMSUCM1'
// Word for word what App.tsx puts in the offload question, so this measures the real one.
const OFFLOAD_BODY =
  `This machine is out of memory - panes here hold about 1250 MB and another one costs ` +
  `about 190 MB. ${DEVICE} has the same project and can run it; you keep watching it from ` +
  `here. Keeping it here is fine if this is the checkout you are working in - it will just ` +
  `be slower.`

/** ConfirmDialog.tsx's own markup, at the width it really has. */
function page({ body, check = true }) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}
  ${css}
  </style>
  <div class="app"><div class="overlay confirm-overlay">
    <div class="dialog confirm">
      <div class="dialog-head"><strong>Start this pane on ${DEVICE}?</strong></div>
      <div class="confirm-body">${body}</div>
      ${check ? '<label class="confirm-check"><input type="checkbox"><span>Remember for 10 minutes</span></label>' : ''}
      <div class="dialog-row">
        <button class="ghost">Keep it here</button>
        <button class="primary">Start on ${DEVICE}</button>
      </div>
    </div>
  </div></div>`
}

const CASES = [
  { name: 'the offload question', body: OFFLOAD_BODY },
  { name: 'a one-line question', body: 'Close this pane?' },
  { name: 'no tick box', body: OFFLOAD_BODY, check: false },
  // The control: a body far taller than the window, so the dialog really scrolls.
  { name: 'a body taller than the window', body: OFFLOAD_BODY.repeat(14), scrolls: true }
]

const profile = mkdtempSync(join(tmpdir(), 'pf-confirmfit-'))
const cdpPort = 9447
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1200,900',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browserSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome never opened its debugging port')
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
      { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(c)) },
      sessionId
    )
    await evaluate('document.fonts.ready.then(() => 1)')
    const m = await evaluate(`(() => {
      const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null }
      const d = r('.dialog.confirm'), g = r('.ghost'), p = r('.primary')
      const above = r('.confirm-check') || r('.confirm-body')
      const el = document.querySelector('.dialog.confirm')
      // Scrolled to the very top is the worst case for a pinned footer: everything the
      // sticky is for happens there, and nowhere else.
      el.scrollTop = 0
      const pTop = document.querySelector('.primary').getBoundingClientRect()
      return {
        dialogH: Math.round(d.height),
        dialogBottom: Math.round(d.bottom),
        scrolls: el.scrollHeight > el.clientHeight,
        gapAbove: Math.round(p.top - above.bottom),
        gapBetween: Math.round(p.left - g.right),
        ghostH: Math.round(g.height * 10) / 10,
        primaryH: Math.round(p.height * 10) / 10,
        sameRow: Math.round(g.top) === Math.round(p.top),
        insideAtTop: Math.round(pTop.bottom) <= Math.round(d.bottom) + 1,
        onScreen: Math.round(p.bottom) <= innerHeight && Math.round(d.top) >= 0
      }
    })()`)

    // 14px is the dialog's own flex gap. Anything under it is the button row eating into
    // the line above it, and a negative number is the overlap this test was written for.
    //
    // Asked only of a dialog that is NOT scrolling. Once it is, the row is doing its job -
    // pinned over content that has scrolled underneath it - and the distance to whatever
    // happens to be above it at that scroll position says nothing about the layout. The
    // scrolling case is covered by `insideAtTop` instead.
    if (!m.scrolls)
      ok(
        m.gapAbove >= 14,
        `${c.name}: the buttons clear the line above them`,
        `${m.gapAbove}px (the dialog's gap is 14px)`
      )
    ok(
      m.gapBetween >= 6 && m.gapBetween <= 16,
      `${c.name}: the two answers sit beside each other`,
      `${m.gapBetween}px apart`
    )
    ok(
      m.ghostH === m.primaryH,
      `${c.name}: both buttons are the same height`,
      `${m.ghostH}px and ${m.primaryH}px`
    )
    ok(m.sameRow, `${c.name}: both buttons are on one line`)
    ok(
      m.onScreen,
      `${c.name}: the dialog and its buttons are on screen`,
      `dialog ${m.dialogH}px, bottom ${m.dialogBottom} of ${900}`
    )
    if (c.scrolls) {
      ok(m.scrolls, `${c.name}: the dialog really does scroll`, 'without this the case below is never exercised')
      ok(
        m.insideAtTop,
        `${c.name}: the buttons stay pinned when it is scrolled to the top`,
        'a static row would scroll them off the bottom'
      )
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
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    /* a temp dir the OS will collect; it is not this test's verdict */
  }
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} confirm-fit checks passed`)
process.exit(failures ? 1 : 0)
