// The two copy icons beside a turn, in a real window.
//
// `npm run test:turncopy` proves the arithmetic that decides WHERE a pair goes. It cannot
// prove the three things that were actually wrong with the feature, because none of them
// are arithmetic:
//
//  - what the prompt button puts on the clipboard. It handed back `mark.text`, which is
//    the RAIL's label - one line, flattened, `.slice(0, 400)` - so a long ask came back
//    cut mid-word with its line breaks gone, and nothing said so. Measured before the
//    fix: a 492-character prompt copied as exactly 400 characters.
//  - whether the icons can be seen. 17px at 0.22 opacity over the agent's own output, and
//    0.6 with the pointer in the pane, is not something anybody can tell is a button.
//  - whether a pair survives being reached for: keyed on the buffer ROW, it unmounted
//    whenever scrollback trimmed and took the hover and the half-made click with it.
//
// Needs a test copy up, which is never the app hosting this session:
//   npm run build && npm run try -- --keep --minimized --remote-debugging-port=9333
//   node scripts/turn-copy-view-test.mjs
//   npm run try -- --close
//
// The port is per checkout; a second lane uses PF_PORT=9334 and the matching flag. The
// window may be minimized: `Emulation.setFocusEmulationEnabled` is what lets the clipboard
// be read from a window nobody is looking at, which is the whole point of probing rather
// than screenshotting.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.env.PF_PORT ?? '9333'

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      if (page) return page
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no debuggable window on port ${port}. Start one with:
  npm run build && npm run try -- --keep --minimized --remote-debugging-port=${port}`)
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
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((res) => ws.addEventListener('open', res, { once: true }))

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
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A minimized window has no focus, and `navigator.clipboard.readText` refuses to run in a
// document that is not focused. This is the flag that lets the check be made anyway.
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

// --------------------------------------------------------------- a desk to measure

const dir = mkdtempSync(join(tmpdir(), 'pf-turn-copy-view-')).replace(/\\/g, '/')

const id = await evaluate(`(async () => {
  for (const s of (await window.api.listSessions()).map((s) => s.id)) await window.api.killSession(s)
  await new Promise((r) => setTimeout(r, 400))
  await window.api.setConfig({ grid: false })
  const s = await window.api.startSession({ cwd: ${JSON.stringify(dir)}, agent: 'shell' })
  await new Promise((r) => setTimeout(r, 2000))
  return s.id
})()`)
ok('a pane opened to type into', Boolean(id), id)

// Long enough to be cut by the rail label's 400-character cap, and split into words so a
// cut shows up as a missing tail rather than as a missing character.
const PROMPT = `echo ${'A'.repeat(120)} ${'B'.repeat(120)} ${'C'.repeat(120)} ${'D'.repeat(120)} END`

// Through xterm's own input handler, because the prompt marks are rebuilt from keystrokes:
// writing to the pty instead proves nothing about the reconstruction.
const type = (text) => `(async () => {
  const t = window.__pf[${JSON.stringify(id)}].term
  for (const ch of ${JSON.stringify(text)}) {
    t._core.coreService.triggerDataEvent(ch, true)
    await new Promise((r) => setTimeout(r, 1))
  }
})()`

await evaluate(type(PROMPT))
await sleep(400)
await evaluate(type('\r'))
await sleep(1500)
await evaluate(type('echo a second turn, so the first one has an end\r'))
await sleep(1500)

// --------------------------------------------------------------- drawn, and reachable

const pairs = await evaluate(`document.querySelectorAll('.turn-copy').length`)
ok('a pair is drawn for each prompt on screen', pairs === 2, `pairs: ${pairs}`)

const box = await evaluate(`(() => {
  const b = document.querySelector('.turn-copy button')
  const r = b.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height) }
})()`)
ok('the buttons are big enough to aim at', box.w >= 22 && box.h >= 22, JSON.stringify(box))

// The pointer arriving in the pane is the whole reveal now: there is no middle step where
// a control somebody is reaching for is still half transparent.
const opacity = await evaluate(`(() => {
  const e = document.querySelector('.turn-copy')
  const r = e.getBoundingClientRect()
  const pane = document.querySelector('.pane')
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }
  pane.dispatchEvent(new MouseEvent('mouseover', at))
  pane.dispatchEvent(new MouseEvent('mousemove', at))
  return { idle: getComputedStyle(e).opacity, hovered: getComputedStyle(pane.querySelector('.turn-copy')).opacity }
})()`)
ok(
  'and they are faint only while nothing is pointing at the pane',
  Number(opacity.idle) > 0.3 && Number(opacity.idle) < 1,
  JSON.stringify(opacity)
)

// The element under the middle of the button has to BE the button: it is drawn over an
// xterm canvas and beside the scrollbar, both of which have taken clicks off it before.
const hit = await evaluate(`(() => {
  const b = document.querySelector('.turn-copy button')
  const r = b.getBoundingClientRect()
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return b === el || b.contains(el)
})()`)
ok('nothing is drawn on top of them', hit === true)

// --------------------------------------------------------------- what it copies

const copied = await evaluate(`(async () => {
  const pairs = [...document.querySelectorAll('.turn-copy')]
  // Newest first, so the pair for the long prompt is the second one.
  pairs[1].querySelectorAll('button')[0].click()
  await new Promise((r) => setTimeout(r, 250))
  return await navigator.clipboard.readText()
})()`)
ok(
  'Copy this prompt hands back the WHOLE prompt, not the rail label',
  copied === PROMPT,
  `${copied.length} of ${PROMPT.length} characters, ends "${copied.slice(-14)}"`
)

const reply = await evaluate(`(async () => {
  const pairs = [...document.querySelectorAll('.turn-copy')]
  pairs[1].querySelectorAll('button')[1].click()
  await new Promise((r) => setTimeout(r, 250))
  return await navigator.clipboard.readText()
})()`)
ok(
  'and Copy the reply hands back what that prompt produced, to its end',
  reply.includes('A'.repeat(120)) && reply.trimEnd().endsWith('END'),
  `${reply.length} characters, ends "${reply.trimEnd().slice(-14)}"`
)

// --------------------------------------------------------------- and it stays put

// Keyed on the mark rather than on the buffer row: the same DOM node has to survive the
// pane scrolling under it, or the button somebody is pressing is replaced mid-press.
const survived = await evaluate(`(async () => {
  const first = document.querySelector('.turn-copy')
  const t = window.__pf[${JSON.stringify(id)}].term
  t.scrollLines(-1)
  await new Promise((r) => setTimeout(r, 500))
  t.scrollToBottom()
  await new Promise((r) => setTimeout(r, 500))
  return document.querySelector('.turn-copy') === first
})()`)
ok('a pair is the same element after the pane scrolls', survived === true)

await evaluate(`window.api.killSession(${JSON.stringify(id)})`)
await send('Emulation.setFocusEmulationEnabled', { enabled: false })

console.log(failed ? `\nFAILED ${failed}` : '\nall good')
process.exit(failed ? 1 : 0)
