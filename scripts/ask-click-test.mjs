// Does a click on a pane holding a live QUESTION type anything into the pty?
//
//   npm run build && npm run try -- --keep --minimized --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:askclick
//
// Why this exists. "I see a question from Claude, I click on it, and it disappears and
// breaks my whole terminal." Clicking a pane is not a passive act here: a bare click is
// turned into left and right arrows (`keysAlongLine`), an Alt-click into up and down, and
// a selection delete into a run of backspaces, because a pty has no caret to place. That
// is right at a composer and catastrophic at a chooser, and both were measured against a
// real `claude` in a pty on 2026-08-19:
//
//   * 15 right arrows sent while its `/model` chooser was up moved it from Medium effort
//     to `max effort` - left and right are not "no-ops" in a chooser, they are an action;
//   * 2 down arrows moved the selection and left a torn partial repaint behind;
//   * and Claude Code turns mouse reporting OFF (no `?1000h` anywhere in its boot), so
//     `mouseGrabbed()` is false, nothing is swallowed, and the pane's own handlers run.
//
// The check is a PAIR, and the control is the half that matters: without proving the same
// click DOES type when there is no question, "nothing was typed" is equally well explained
// by a synthetic event that never reached the handler at all - which is exactly what a
// hand-made MouseEvent does here, and is how this test was nearly written green and blind.
// Hence Input.dispatchMouseEvent, and hence the second half.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from './ui-lab.mjs'

const port = process.env.PF_PORT ?? '9333'

const link = await connect(port)
const ws = link.ws
// CDP acks a screencast frame on its own message, not a response to a request this side
// sent - so it needs a listener beside the one ui-lab's Link already owns, not instead of
// it. `link.send` still fires the ack (untracked, nobody awaits it); Link's own listener
// ignores it since no pending request carries its id.
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Page.screencastFrame') {
    link.send('Page.screencastFrameAck', { sessionId: m.params.sessionId })
  }
})
const send = (method, params) => link.send(method, params)

// A minimized window renders no frames, and deferred mouse input is delivered where the
// frames are. The 64px screencast is what makes a press land on a schedule.
await send('Page.enable')
await send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 })

const evaluate = (expression) => link.evaluate(expression)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function mouse(type, x, y) {
  const params = { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }
  if (type === 'mouseMoved') {
    send('Input.dispatchMouseEvent', params).catch(() => {})
    await sleep(60)
    return
  }
  await send('Input.dispatchMouseEvent', params)
}
async function click(x, y) {
  await mouse('mouseMoved', x, y)
  await mouse('mousePressed', x, y)
  await sleep(60)
  await mouse('mouseReleased', x, y)
  await sleep(300)
}

const results = []
const check = (name, got, want) => results.push({ name, got: JSON.stringify(got), want: JSON.stringify(want), ok: JSON.stringify(got) === JSON.stringify(want) })

// A folder `claude` has never been trusted in, so its own trust prompt is the chooser -
// a real question from a real CLI, with no model call and no network.
const dir = mkdtempSync(join(tmpdir(), 'pf-askclick-'))
// Answering for the user must be OFF, or the question this test needs is pressed away
// underneath it.
await evaluate(`window.api.setConfig({
  autoAnswer: { enabled: false, anyQuestion: false, waitMs: 1200, maxRun: 12 },
  clickMovesCursor: true
})`)
const id = await evaluate(
  `window.api.startSession({ cwd: ${JSON.stringify(dir)}, agent: 'claude' }).then((s) => s.id)`
)

let ask = null
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  ask = await evaluate(`window.api.listSessions().then((ss) => ss.find((s) => s.id === ${JSON.stringify(id)})?.ask ?? null)`)
  if (ask) break
}
if (!ask) throw new Error('the CLI never put a question on screen - is `claude` on PATH?')

// Where the second option is drawn, in page pixels. Clicking an option row is what a
// person does, and it is the worst case: it is rows away from wherever the widget parked
// the cursor, so it is the click that used to emit vertical arrows.
const spot = await evaluate(`(() => {
  const t = window.__pf[${JSON.stringify(id)}].term
  const b = t.buffer.active
  const el = t.element.querySelector('.xterm-screen')
  const r = el.getBoundingClientRect()
  const cw = r.width / t.cols, ch = r.height / t.rows
  let row = -1
  for (let y = 0; y < t.rows; y++) {
    const line = b.getLine(b.viewportY + y)?.translateToString(true) ?? ''
    if (/^\\s*2\\.\\s+\\S/.test(line)) row = y
  }
  return row < 0
    ? null
    : {
        x: r.left + cw * 8,
        y: r.top + ch * (row + 0.5),
        cursorRowY: r.top + ch * (b.cursorY + 0.5),
        row,
        cursorY: b.cursorY
      }
})()`)
if (!spot) throw new Error('could not find the second option on screen')

// What the pane's mouse handlers have typed, read off the pane itself: `window.api` is
// frozen by the context bridge, so wrapping `write` from here assigns nothing and reports
// an empty list for every click, typed or not.
const typed = () => evaluate(`window.__pf[${JSON.stringify(id)}].clickKeys()`)

const beforeAsk = (await typed()).length
// Two clicks, because they are two different code paths and both used to type: an option
// row (rows away from the cursor - the vertical-arrow path through a drawn box) and the
// cursor's own row (the horizontal path, which is what a chooser reads as "adjust").
await click(spot.x, spot.y)
await click(spot.x, spot.cursorRowY)
const duringAsk = (await typed()).slice(beforeAsk)
check('a click on a live question types nothing', duringAsk, [])
const after = await evaluate(`window.api.listSessions().then((ss) => ss.find((s) => s.id === ${JSON.stringify(id)})?.ask ?? null)`)
check('...and the question is still there, on the same option', after && after.selected, ask.selected)

// THE CONTROL. Answer the question, get the CLI to an ordinary composer with something
// typed in it, and click to the left of the cursor: the same gesture must now really send
// arrows, or the check above only proved the click never arrived.
await evaluate(`window.api.chooseOption(${JSON.stringify(id)}, 1)`)
await sleep(9000)
await evaluate(`window.api.write(${JSON.stringify(id)}, 'hello world one two three')`)
await sleep(2500)
const at = await evaluate(`(() => {
  const t = window.__pf[${JSON.stringify(id)}].term
  const b = t.buffer.active
  const el = t.element.querySelector('.xterm-screen')
  const r = el.getBoundingClientRect()
  const cw = r.width / t.cols, ch = r.height / t.rows
  const col = Math.max(0, b.cursorX - 5)
  return { x: r.left + cw * (col + 0.5), y: r.top + ch * (b.cursorY + 0.5), cursorX: b.cursorX }
})()`)
const beforeIdle = (await typed()).length
await click(at.x, at.y)
const noAsk = (await typed()).slice(beforeIdle)
check('CONTROL: the same click with no question sends the arrows', noAsk.join(''), '\x1b[D'.repeat(5))

await evaluate(`window.api.killSession(${JSON.stringify(id)})`).catch(() => {})
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.got}${r.ok ? '' : ` (wanted ${r.want})`}`)
const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} failed` : `\nall ${results.length} checks passed`)
ws.close()
process.exit(bad.length ? 1 : 0)
