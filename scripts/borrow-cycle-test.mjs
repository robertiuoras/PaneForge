// The borrow CYCLE, across both windows at once.
//
// `npm run test:panesize` pins the main process's half of this - a phone bends the pty, a
// desk resize during the borrow is remembered, a return puts back what the desk chose
// last. It cannot see the half that broke: what the DESK'S TERMINAL is drawing while all
// that happens. Both windows have to be real, so this one needs a running copy and a
// system Chrome, and skips out loud without them:
//
//   npm run build && npm run try -- --keep --remote-debugging-port=9333
//   node scripts/borrow-cycle-test.mjs
//
// The case it exists for is the one an adversarial review found and a probe then
// reproduced: on RELEASE, the font effect returned early because the derived font size
// happened to equal the setting (a 50-column grid in a wide pane at 13pt asks for 13pt),
// so `reshape` never ran and the desk was left drawing 67 columns against a 157-column
// pty. Every line wrapped a third of the way across, and nothing was there to notice -
// the resize observer watches pixels and no pixel had moved. Measured with the guard
// removed: deskTerm 67x40, pty 157x56.
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', 7399))
const code = String(arg('code', 'DEVTESTCODE12A'))
const cdp = Number(arg('cdp', 9333))
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const ok = (cond, what, detail = '') => {
  console.log((cond ? 'ok   ' : 'FAIL ') + what + (detail ? ` - ${detail}` : ''))
  if (!cond) failures++
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p))
if (!CHROME) {
  console.log('borrow cycle: SKIPPED - no system Chrome (nothing was downloaded)')
  process.exit(0)
}
const alive = await fetch(base + '/', { redirect: 'manual' }).catch(() => null)
if (!alive) {
  console.log(`borrow cycle: SKIPPED - nothing is serving on ${base}`)
  console.log(`  start it with: npm run build && npm run try -- --keep --remote-debugging-port=${cdp}`)
  process.exit(0)
}

function client(ws) {
  let next = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  })
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(
        () => pending.has(id) && (pending.delete(id), reject(new Error(method + ' timed out'))),
        30_000
      )
    })
}
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  return { ws, send: client(ws) }
}

// ---- the desk --------------------------------------------------------------------
let deskUrl
for (let i = 0; i < 40 && !deskUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json()
    deskUrl = list.find((t) => t.type === 'page' && t.url.includes('index.html'))?.webSocketDebuggerUrl
  } catch {
    /* not up yet */
  }
  if (!deskUrl) await sleep(300)
}
if (!deskUrl) {
  console.log(`borrow cycle: SKIPPED - no window on the debugging port ${cdp}`)
  console.log(`  relaunch it with: npm run try -- --keep --remote-debugging-port=${cdp}`)
  process.exit(0)
}
const desk = await connect(deskUrl)
await desk.send('Runtime.enable')
const deskEval = async (expression) => {
  const res = await desk.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'threw')
  return res.result.value
}

const id = await deskEval(`(async () => {
  const s = await window.api.listSessions()
  if (s.length) return s[0].id
  const started = await window.api.startSession({ cwd: ${JSON.stringify(process.cwd())}, agent: 'shell' })
  return typeof started === 'string' ? started : started.id
})()`)
await sleep(2500)
const shape = async (label) => {
  const v = await deskEval(`(async () => {
    const s = (await window.api.listSessions()).find(x => x.id === ${JSON.stringify(id)})
    const t = window.__pf?.[${JSON.stringify(id)}]?.term
    return { pty: s?.cols + 'x' + s?.rows, borrowed: !!s?.borrowed, deskTerm: t ? t.cols + 'x' + t.rows : 'none' }
  })()`)
  console.log(' ', label, JSON.stringify(v))
  return v
}
// Whatever an earlier run left behind: this test is about a transition, so it starts from
// a known side of it rather than from whatever the profile happens to be holding.
await deskEval(`window.api.returnSize()`)
await sleep(1200)

// ---- the phone -------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'pf-chrome-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=9456',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=414,896'
  ],
  { stdio: 'ignore' }
)
let phoneUrl
for (let i = 0; i < 60 && !phoneUrl; i++) {
  try {
    phoneUrl = (await (await fetch('http://127.0.0.1:9456/json/version')).json()).webSocketDebuggerUrl
  } catch {
    /* not up yet */
  }
  if (!phoneUrl) await sleep(200)
}
const phone = await connect(phoneUrl)
const { targetId } = await phone.send('Target.createTarget', { url: base + '/#' + code })
const { sessionId } = await phone.send('Target.attachToTarget', { targetId, flatten: true })
await phone.send('Runtime.enable', {}, sessionId)
await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, sessionId)
await phone.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] }, sessionId)
const phoneEval = async (expression) => {
  const res = await phone.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'threw')
  return res.result.value
}
await sleep(2500)

try {
  const before = await shape('before any phone:')
  ok(before.borrowed === false, 'nothing is borrowed to begin with')
  ok(before.deskTerm === before.pty, 'and the desk is drawing its own pty', before.deskTerm + ' vs ' + before.pty)

  // A tap on the session's own row in the list. `.row` is the row itself, and the tap is
  // a pointerup that did not travel - the gesture the list really answers.
  const opened = await phoneEval(`(() => {
    const el = document.querySelector('.row')
    if (!el) return 'no row in the list'
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }))
    el.click?.()
    // Read AFTER React has re-rendered, not in the tick the click was dispatched in -
    // the class is still handheld-list at that point and the check reads as a failure
    // while the pane is opening perfectly well.
    return new Promise((r) => setTimeout(() => r(document.documentElement.className), 800))
  })()`)
  ok(
    typeof opened === 'string' && opened.includes('handheld') && !opened.includes('handheld-list'),
    'the phone opened a pane and the pane has the screen',
    String(opened)
  )
  await sleep(3000)
  const during = await shape('while the phone holds it:')
  ok(during.borrowed === true, 'the phone is on record as holding the size')
  ok(during.pty !== before.pty, 'the pty bent to the phone', before.pty + ' -> ' + during.pty)
  ok(during.deskTerm === during.pty, 'and the DESK draws that grid rather than its own width', during.deskTerm)

  // The Back chip, which is what a phone presses when it looks away.
  await phoneEval(`window.api.returnSize()`)
  await sleep(2500)
  const after = await shape('after the phone let go:')
  ok(after.borrowed === false, 'letting go clears the borrow')
  ok(after.pty === before.pty, 'the pty is the desk shape again', after.pty)
  // The one the review found. With the release guard removed this reads 67x40 vs 157x56.
  ok(after.deskTerm === after.pty, 'and the desk TERMINAL came back with it', after.deskTerm + ' vs pty ' + after.pty)
} finally {
  phone.ws.close()
  chrome.kill()
  desk.ws.close()
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
