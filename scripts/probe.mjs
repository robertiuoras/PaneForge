// Ask the running test copy a question about itself, and print the answer as JSON.
//
//   npm run try -- --keep --minimized --remote-debugging-port=9333
//   node scripts/probe.mjs "document.querySelectorAll('.mark').length"
//   node scripts/probe.mjs --height 560 "getComputedStyle(document.querySelector('.dialog')).maxHeight"
//   node scripts/probe.mjs --file checks/dialogs.js
//
// Why this exists: almost every layout bug this app has had only appears at a window
// size, and the way to check one used to be a screenshot. A screenshot cannot tell you
// whether the last row of a list is reachable, and a session that takes ten of them
// costs more than the fix did. This asks the real window for real numbers instead.
//
// The expression is evaluated in the renderer with awaitPromise on, so an async
// arrow that clicks through a dialog and measures the result works as one argument.
// --height/--width drive Chromium's device metrics override rather than resizing the
// OS window, so a short-window check needs no window manager and restores itself.

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function flag(name, fallback) {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  return args.splice(i, 2)[1]
}
const port = flag('--port', process.env.PF_PORT ?? '9333')
const height = Number(flag('--height', 0))
const width = Number(flag('--width', 0))
const file = flag('--file', '')
const urlMatch = flag('--url', '')
const expression = file ? readFileSync(file, 'utf8') : args.join(' ')

if (!expression.trim()) {
  console.error('nothing to evaluate. pass an expression, or --file <path>.')
  process.exit(2)
}

// The window can be mid-launch, so give it a few seconds rather than failing the run.
async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      // The app has more than one window (the Stash overlay is its own page), so a probe
      // aimed at one of them needs to say which: `--url shelf` picks the first whose URL
      // contains that. With no flag it is the main window - which is NOT simply the first
      // page in the list: with the Stash open, DevTools lists the Stash first, and a probe
      // that asked the main window a question got an empty document and no window.api.
      const page = list.find(
        (t) =>
          t.type === 'page' &&
          t.webSocketDebuggerUrl &&
          (urlMatch ? (t.url ?? '').includes(urlMatch) : !(t.url ?? '').includes('shelf'))
      )
      if (page) return page
    } catch {
      /* devtools endpoint not listening yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `no debuggable window on port ${port}. Start one with:\n` +
      `  npm run try -- --keep --minimized --remote-debugging-port=${port}`
  )
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
function send(method, params) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((res) => ws.addEventListener('open', res, { once: true }))

if (height || width) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: width || 1000,
    height: height || 700,
    deviceScaleFactor: 0,
    mobile: false
  })
  // React has to lay out against the new size before anything is worth measuring.
  await new Promise((r) => setTimeout(r, 500))
}

const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
// Always put the metrics back: a left-over override makes the next person's window
// look broken in a way nothing in the app explains.
if (height || width) await send('Emulation.clearDeviceMetricsOverride')

if (out.exceptionDetails) {
  console.error(out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails))
  ws.close()
  process.exit(1)
}
console.log(JSON.stringify(out.result?.value ?? out.result, null, 2))
ws.close()
process.exit(0)
