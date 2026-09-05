// A highlight that appears with no button held down, and then follows the pointer.
//
// Reported as "I'm not even holding down mouse and somehow the highlighting field pops
// up". It is not xterm misbehaving and it is not the copy chip: it is this app swallowing
// the mouseup.
//
// The click-to-move handlers (`moveAlongLine` in TerminalPane.tsx) run in the CAPTURE
// phase on the pane's host element, so they see the event before xterm does. They called
// `stopPropagation` to keep a CLI with mouse reporting on from acting on the same click.
// But xterm's selection service registers its `mousemove` and `mouseup` on the DOCUMENT
// when a mousedown starts a selection, and removes them again from that `mouseup` - which
// is a BUBBLE listener on the document, so a capture-phase stop above it means the removal
// never runs. The mousemove listener then stays attached for the life of the pane and
// every later movement of the mouse extends a selection nobody is dragging.
//
// The fix is that the stop is only needed in the one case where it costs nothing: a pane
// whose CLI has mouse reporting on. There, xterm has disabled its own selection service,
// so the mousedown registered nothing and there is nothing to leak. This drives both
// halves against a real xterm in a real browser, and the control - the unconditional stop
// this app used to do - has to FAIL to leak-free, or the test proves nothing.
//
// System Chrome over raw CDP, same as scripts/card-fit-test.mjs. SKIPS out loud with no
// Chrome; nothing is downloaded.
//
//   node scripts/sticky-select-test.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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
  console.log('sticky select: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

// The real terminal, bundled for the page. Nothing of ours is bundled: the behaviour under
// test is xterm's listener bookkeeping against a capture-phase stop, and the page below
// puts each of the two stop policies in front of it by hand.
const tmp = mkdtempSync(join(tmpdir(), 'pf-sticky-'))
const bundle = join(tmp, 'xterm.js')
buildSync({
  stdin: {
    contents: "export { Terminal } from '@xterm/xterm'",
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'iife',
  globalName: 'X',
  platform: 'browser',
  outfile: bundle
})
const xtermJs = readFileSync(bundle, 'utf8')
const xtermCss = readFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8')
const paneSource = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const stopBody = paneSource.match(/const stopForAgent = \(e: MouseEvent\): void => \{([\s\S]*?)\n    \}/)?.[1]
if (!stopBody) throw new Error('could not read the shipped mouseup policy')

function page() {
  return `<!doctype html><meta charset="utf-8">
  <style>${xtermCss}
  html,body{margin:0;background:#000}
  #host{width:800px;height:400px}
  </style>
  <div id="host"></div>
  <script>${xtermJs}<\/script>
  <script>
  const host = document.getElementById('host')
  const term = new X.Terminal({ cols: 80, rows: 24, fontSize: 14, allowProposedApi: true })
  term.open(host)
  term.write('the quick brown fox jumps over the lazy dog and keeps going for a while\\r\\n')
  term.write('0123456789abcdefghijklmnop\\r\\n')

  // The two policies, applied to the pane's HOST in the capture phase, which is where
  // TerminalPane registers moveAlongLine.
  let policy = 'none'
  const mouseGrabbed = () => term.element.classList.contains('enable-mouse-events')
  const mouseSelectRef = { current: true }
  const stopForAgent = (e) => { ${stopBody} }
  host.addEventListener('mouseup', (e) => {
    if (policy === 'always') e.stopPropagation()
    if (policy === 'pane') stopForAgent(e)
  }, true)
  const FORCE_KEYS = { altKey: true }
  host.addEventListener('mousedown', e => {
    if (policy !== 'pane') return
    for (const [key, value] of Object.entries(FORCE_KEYS)) Object.defineProperty(e, key, { value })
  }, true)
  window.grabMouse = () => new Promise(resolve => {
    term.options.macOptionClickForcesSelection = true
    term.write('\\x1b[?1000h', resolve)
  })

  const screen = () => host.querySelector('.xterm-screen')
  const at = (col, row) => {
    const r = screen().getBoundingClientRect()
    return { clientX: r.left + (r.width / term.cols) * (col + 0.5), clientY: r.top + (r.height / term.rows) * (row + 0.5) }
  }
  const fire = (target, type, col, row, buttons) => {
    const p = at(col, row)
    // \`detail\` is not decoration: xterm's mousedown branches on it to tell a single click
    // from a double and a triple, and a synthetic event defaults it to 0 - which matches
    // none of them, so the drag silently selects nothing.
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, detail: 1, ...p }))
  }

  // One drag, released, then a bare move with no button down. A terminal that let go of
  // the mouse answers the same string twice.
  window.run = (which) => {
    policy = which
    term.clearSelection()
    fire(screen(), 'mousedown', 2, 0, 1)
    fire(document, 'mousemove', 20, 0, 1)
    const dragged = term.getSelection()
    fire(screen(), 'mouseup', 20, 0, 0)
    fire(document, 'mousemove', 60, 0, 0)
    const after = term.getSelection()
    return { dragged, after, grew: after.length > dragged.length }
  }
  window.multiline = () => {
    term.clearSelection()
    fire(screen(), 'mousedown', 2, 0, 1)
    fire(document, 'mousemove', 4, 1, 1)
    const selected = term.getSelection()
    fire(screen(), 'mouseup', 4, 1, 0)
    return selected
  }
  window.ready = 1
  <\/script>`
}

const profile = mkdtempSync(join(tmpdir(), 'pf-sticky-profile-'))
const cdpPort = 9448
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

  await send('Page.enable', {}, sessionId)
  await send(
    'Page.navigate',
    { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page()) },
    sessionId
  )
  for (let i = 0; i < 50 && !(await evaluate('window.ready === 1')); i++) await sleep(100)
  ok(await evaluate('window.ready === 1'), 'a real xterm is up in the page')

  // The control. Without this failing to be leak-free the test below proves nothing: it
  // would pass just as happily against a build that never had the bug.
  const bug = await evaluate('JSON.stringify(window.run("always"))').then(JSON.parse)
  ok(bug.dragged.length > 0, 'the drag selected something to begin with', JSON.stringify(bug.dragged))
  ok(
    bug.grew,
    'CONTROL: swallowing every mouseup leaves the selection following the pointer',
    `${bug.dragged.length} chars dragged, ${bug.after.length} after letting go`
  )

  const fixed = await evaluate('JSON.stringify(window.run("none"))').then(JSON.parse)
  ok(fixed.dragged.length > 0, 'the same drag still selects', JSON.stringify(fixed.dragged))
  ok(
    !fixed.grew,
    'letting xterm see the mouseup stops the highlight moving once the button is up',
    `${fixed.dragged.length} chars dragged, ${fixed.after.length} after letting go`
  )
  await evaluate('window.grabMouse()')
  const forced = await evaluate('window.run("pane")')
  ok(forced.dragged.length > 0, 'forced selection works while the CLI holds the mouse')
  ok(!forced.grew, 'the shipped policy releases forced selection after mouseup', JSON.stringify(forced))
  const multiline = await evaluate('window.multiline()')
  ok(
    multiline.includes(
      'e quick brown fox jumps over the lazy dog and keeps going for a while' +
        String.fromCharCode(10) +
        '0123'
    ),
    'a forced multi-line drag is normal text selection, not a rectangular column',
    JSON.stringify(multiline)
  )
} finally {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  chrome.kill()
  await sleep(300)
  // Chrome keeps writing its profile for a moment after the kill, so a single rm races it
  // and throws ENOTEMPTY - which failed the whole run AFTER its one assertion had passed.
  // A tidy-up may never be the reason a test reports red.
  for (const dir of [profile, tmp]) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await sleep(200)
      }
    }
  }
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} sticky-select checks passed`)
process.exit(failures ? 1 : 0)
