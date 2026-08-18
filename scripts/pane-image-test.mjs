// A dropped image really does reach the agent AS an image, in a real window.
//
// The half that arithmetic cannot answer. `drop-image-test.mjs` pins the DECISION - which
// drops paste and which type a path - but the decision is worthless if the mechanism
// under it does not work, and the mechanism is Chromium's image decoder and the OS
// clipboard, neither of which exists outside a real Electron process. What is proved
// here, end to end through the same IPC the pane calls:
//
//   bytes -> clipboard -> readable image  (a browser drag, a mirrored pane, a phone)
//   path  -> clipboard -> readable image  (a Finder drag, a screenshot thumbnail)
//   a non-image answers false, so the pane falls back to typing the path instead of
//   sending a ^V that would paste whatever was on the clipboard BEFORE the drop
//
// It also reads the browser tab's icon out of the page that ships, because the white ring
// this session fixed was in the same drop of work.
//
// The clipboard here is the PROBE'S, not the user's: --clipboard-test points the app at a
// private fixture file and the image path fails closed if that fixture is not healthy, so
// running this never touches what is on the real clipboard.
//
//   npm run build
//   npm run try -- --keep --show --clipboard-test --remote-debugging-port=9334
//   PF_PORT=9334 node scripts/pane-image-test.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const port = process.env.PF_PORT ?? '9334'
const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function page() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const found = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Every lane's test copy is told to use this port, so the first one up owns it and a
      // "verified" fix can be measured against another checkout's build entirely.
      if (found && !(found.url ?? '').toLowerCase().startsWith(root))
        throw new Error(`port ${port} belongs to another checkout: ${found.url}`)
      if (found) return found
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await sleep(250)
  }
  throw new Error(
    `no debuggable PaneForge window on port ${port}. Start one with:\n` +
      `  npm run build && npm run try -- --keep --show --clipboard-test --remote-debugging-port=${port}`
  )
}

const target = await page()
const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

// The fixture has to be live or this probe would be writing to the real clipboard, and a
// green run would mean the user's clipboard was thrown away rather than that the code
// works. Refuse rather than measure the wrong thing.
const fixture = await evaluate('window.api.clipboardFixtureActive()')
if (!fixture) {
  console.error(
    'the private clipboard fixture is not active - relaunch with --clipboard-test:\n' +
      `  npm run try -- --keep --show --clipboard-test --remote-debugging-port=${port}`
  )
  process.exit(1)
}

const imagePath = join(repo, 'src', 'renderer', 'public', 'favicon-32.png')
const imageB64 = readFileSync(imagePath).toString('base64')

/** Put something on the clipboard, then take it back off the way a pane's ^V would. */
const roundTrip = async (src) =>
  evaluate(`(async () => {
    const wrote = await window.api.putImageOnClipboard(${JSON.stringify(src)})
    if (!wrote) return { wrote: false }
    const back = await window.api.attachClipboardImage('pane-image-probe')
    return { wrote: true, back }
  })()`)

// --- bytes, the shape a browser drag and a phone arrive in ----------------------------
const fromBytes = await roundTrip({ data: imageB64 })
ok('bytes are accepted', fromBytes.wrote === true, JSON.stringify(fromBytes))
ok(
  'and come back as a saved image',
  fromBytes.back?.paths?.length === 1 && !fromBytes.back.error,
  JSON.stringify(fromBytes.back)
)
if (fromBytes.back?.paths?.length) {
  const saved = readFileSync(fromBytes.back.paths[0])
  // Chromium re-encodes, so the bytes are not the bytes. The IHDR is: 32x32 means the
  // decoder read a real image rather than saving whatever it was handed.
  ok('the saved file is a PNG', saved.subarray(1, 4).toString('latin1') === 'PNG', String(saved.length))
  ok(
    'at the size that went in',
    saved.readUInt32BE(16) === 32 && saved.readUInt32BE(20) === 32,
    `${saved.readUInt32BE(16)}x${saved.readUInt32BE(20)}`
  )
}

// --- a path, the shape a Finder drag arrives in ---------------------------------------
const fromPath = await roundTrip({ path: imagePath })
ok('a path on this disk is accepted', fromPath.wrote === true, JSON.stringify(fromPath))
ok(
  'and comes back as a saved image',
  fromPath.back?.paths?.length === 1 && !fromPath.back.error,
  JSON.stringify(fromPath.back)
)

// --- what must NOT be pasted ----------------------------------------------------------
// Each of these has to answer false, because the pane treats false as "type the path
// instead". Answering true would send a ^V that pastes the PREVIOUS clipboard image - a
// drop that silently attaches the wrong picture, which is worse than one that does
// nothing.
const notAnImage = await evaluate(
  `window.api.putImageOnClipboard(${JSON.stringify({ path: join(repo, 'package.json') })})`
)
ok('a text file is refused', notAnImage === false, String(notAnImage))
const missing = await evaluate(
  `window.api.putImageOnClipboard(${JSON.stringify({ path: join(repo, 'no-such-file.png') })})`
)
ok('a missing file is refused', missing === false, String(missing))
const nothing = await evaluate(`window.api.putImageOnClipboard({})`)
ok('an empty request is refused', nothing === false, String(nothing))
const junk = await evaluate(
  `window.api.putImageOnClipboard({ data: ${JSON.stringify(Buffer.from('not an image').toString('base64'))} })`
)
ok('undecodable bytes are refused', junk === false, String(junk))

// --- the tab icon the same page ships -------------------------------------------------
const icon = await evaluate(`(async () => {
  const link = document.querySelector('link[rel="icon"]')
  if (!link) return { linked: false }
  const res = await fetch(link.href)
  return { linked: true, ok: res.ok, type: res.headers.get('content-type'), body: await res.text() }
})()`)
ok('the page links a tab icon', icon.linked === true)
ok('and it is fetchable', icon.ok === true, JSON.stringify(icon.type))
ok('it is the bare mark: three panes', (icon.body?.match(/<rect /g) ?? []).length === 3, icon.body)
// The plate is the bug: its transparent rounded corners are what Chrome's near-white tab
// strip shows through as a ring around the icon.
ok('with no plate behind them', !/<rect width="1024"/.test(icon.body ?? ''), icon.body)

// Not tested here: the DRAG GESTURE itself.
//
// It was tried, both with a synthetic DragEvent and with a real `Input.dispatchDragEvent`
// over the pane's own coordinates, and neither reaches the app's handler: the raw event
// arrives at `.xterm-wrap` (a plain listener added beside React's sees it, files and all)
// but React's delegated `onDrop` never runs for it, because the drop lands on xterm's own
// `.xterm-link-layer`, which React does not manage. A test that fails for that reason
// measures the harness, not the app - and the delegation itself is untouched by this
// change: it is the same path that types a file's name at the prompt today, which is the
// behaviour being replaced for images.
//
ws.close()
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('pane-image: ok')
