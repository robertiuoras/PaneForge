// Does a drag survive the mouse button being let go where the app cannot see it?
//
//   npm run try -- --keep --minimized --remote-debugging-port=9333
//   npm run test:drag
//
// Why this exists. Both grid gestures - moving a pane by its title, and dragging the line
// between two panes - are hand-rolled: pointerdown adds a `pointermove` and a `pointerup`
// to `window`, and `pointerup` is the only thing that ever takes them off again. A button
// released outside the window delivers no pointerup, so that teardown never runs, and what
// is left behind is not a cosmetic glitch:
//
//   * `body.dragging` paints `cursor: grabbing !important` over every element, and
//     `body.sizing` paints `user-select: none` over every element;
//   * the moved pane keeps `.moving` at 0.45 opacity;
//   * the `pointermove` listener lives on for the rest of the session, running a hit test
//     across every pane and a React render on EVERY mouse move.
//
// The app then looks like it has stopped answering the mouse, with nothing on screen to
// say why, and only a reload clears it. The session list solved this long ago by taking
// pointer capture, which makes the browser deliver that pointerup to the capturing element
// no matter where on the screen the button comes up. This checks the two grid gestures
// learned the same trick, because the failure is invisible until somebody's app is stuck.
//
// The capture check needs REAL input: setPointerCapture throws NotFoundError for a pointer
// id that no physical pointer owns, so a hand-made PointerEvent can never take capture and
// a test built on one passes against code that has no capture at all.

const port = process.env.PF_PORT ?? '9333'
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Same trap probe.mjs guards: every lane's test copy is told to use this port, so the
      // first one up owns it, and a "verified" fix can be measured against another
      // checkout's build entirely.
      if (page && !(page.url ?? '').toLowerCase().startsWith(root)) {
        throw new Error(`port ${port} belongs to another checkout: ${page.url}`)
      }
      if (page) return page
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no debuggable window on port ${port}. Start one with:
  npm run try -- --keep --minimized --remote-debugging-port=${port}`)
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  // Every screencast frame has to be acked or Chromium stops sending them after a few, and
  // stopping them is the thing this test cannot afford - see startScreencast below.
  if (m.method === 'Page.screencastFrame') {
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }))
    return
  }
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

// The test window is minimized, and a minimized window produces no frames. Chromium defers
// mouse moves to the next frame, so against a minimized window they arrive late, in bursts,
// or not at all - which made every assertion here pass and fail on the same build. A
// screencast makes the compositor produce frames for a window nobody can see, so input is
// delivered on a schedule again. Cheap: the smallest, lowest quality frame it will encode.
await send('Page.enable')
await send('Page.startScreencast', {
  format: 'jpeg', quality: 1, maxWidth: 64, maxHeight: 64, everyNthFrame: 1
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The test window is minimized on purpose, and a minimized Electron window never acks a
// mouseMoved: Chromium defers it to a frame that will never be rendered. Awaiting one hangs
// the run, so moves are fired and given a moment instead. Presses and releases ack normally.
async function mouse(type, x, y) {
  const params = {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, pointerType: 'mouse'
  }
  if (type === 'mouseMoved') {
    send('Input.dispatchMouseEvent', params).catch(() => {})
    await sleep(60)
    return
  }
  await send('Input.dispatchMouseEvent', params)
}

// Two panes, so there is a divider between them to grab.
await evaluate(`(async () => {
  if (document.querySelectorAll('.pane').length >= 2) return
  const b = Array.from(document.querySelectorAll('.overlay button')).find((x) => /Start fresh/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 300))
  const cwd = 'C:/Users/Gamer/Desktop/Projects/jarvis'
  while (document.querySelectorAll('.pane').length < 2) {
    await window.api.startSession({ cwd, agent: 'shell' })
    await new Promise((r) => setTimeout(r, 1200))
  }
})()`)
// Track widths a previous run dragged and saved would put the divider somewhere this run
// did not choose, so every run starts from equal shares.
await evaluate(`window.api.setConfig({ gridSizes: {} })`)
await sleep(600)

const results = []
const check = (name, got, want) => {
  results.push({ name, got, want, ok: got === want })
}

// Poll rather than sleep a fixed time. A minimized window renders no frames, so the pointer
// event that flushes a pending capture change arrives when Chromium gets round to it and
// not on any schedule this script can predict. A fixed wait here does not test the app, it
// tests the guess - it passed and failed on the same build. Still a real assertion: if the
// state never settles, this returns the wrong answer and the check fails.
async function settles(expression, want, ms = 3000) {
  const until = Date.now() + ms
  let last = await evaluate(expression)
  while (last !== want && Date.now() < until) {
    await sleep(100)
    last = await evaluate(expression)
  }
  return last
}

const box = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: b.left, top: b.top }
  })()`)

// A pane title is mostly buttons - the agent badge sits dead centre - and beginPaneMove
// ignores a press that lands on one, correctly. The draggable part is the name at the left.
const grip = async () => {
  const b = await box('.pane-title.draggable')
  return { x: b.left + 20, y: b.y }
}

// What is actually under a point. A press that lands on the wrong element fails every
// assertion after it and reads exactly like broken code, so the aim is checked first and
// says what it hit instead.
const at = (x, y) =>
  evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y})
    return el ? el.tagName + '.' + el.className : 'nothing'
  })()`)
async function aimAt(x, y, sel, what) {
  const hit = await at(x, y)
  const ok = await evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y})
    return !!(el && el.closest(${JSON.stringify(sel)}))
  })()`)
  if (!ok) throw new Error(`${what}: the press at ${Math.round(x)},${Math.round(y)} lands on ${hit}, not ${sel}`)
}

// ---------------------------------------------------------------- divider resize
{
  const b = await box('.grid-divider')
  if (!b) throw new Error('no .grid-divider on screen - the grid needs two panes')
  await aimAt(b.x, b.y, '.grid-divider', 'divider')
  await mouse('mousePressed', b.x, b.y)
  await mouse('mouseMoved', b.x + 40, b.y + 40)
  await sleep(120)
  check('divider: gesture started', await evaluate(`document.body.classList.contains('sizing')`), true)
  check(
    'divider: pointer captured (a release outside the window still ends it)',
    await evaluate(`(() => {
      const d = document.querySelector('.grid-divider')
      for (let id = 1; id < 40; id++) if (d.hasPointerCapture(id)) return true
      return false
    })()`),
    true
  )
  await mouse('mouseReleased', b.x + 40, b.y + 40)
  check(
    'divider: released cleanly',
    await settles(`document.body.classList.contains('sizing')`, false),
    false
  )
}

// ---------------------------------------------------------------- pane move
{
  const b = await grip()
  await aimAt(b.x, b.y, '.pane-title.draggable', 'pane title')
  await mouse('mousePressed', b.x, b.y)
  await mouse('mouseMoved', b.x + 120, b.y + 160)
  await sleep(120)
  check('pane: gesture started', await evaluate(`document.body.classList.contains('dragging')`), true)
  check(
    'pane: pointer captured (a release outside the window still ends it)',
    await evaluate(`(() => {
      for (const el of document.querySelectorAll('*')) {
        for (let id = 1; id < 40; id++) { try { if (el.hasPointerCapture(id)) return true } catch {} }
      }
      return false
    })()`),
    true
  )
  await mouse('mouseReleased', b.x + 120, b.y + 160)
  check(
    'pane: released cleanly',
    await settles(`document.body.classList.contains('dragging')`, false),
    false
  )
  check(
    'pane: no pane left dimmed',
    await settles(`document.querySelectorAll('.pane.moving').length`, 0),
    0
  )
}

// -------------------------------------------------- the capture-lost escape hatch
// What the browser fires when a capture ends without a pointerup of its own: the window
// going to the background mid-gesture, or the pointer being cancelled under it.
{
  const b = await box('.grid-divider')
  await mouse('mousePressed', b.x, b.y)
  await mouse('mouseMoved', b.x + 30, b.y + 30)
  await sleep(120)
  await evaluate(`(() => {
    const d = document.querySelector('.grid-divider')
    for (let id = 1; id < 40; id++) if (d.hasPointerCapture(id)) d.releasePointerCapture(id)
  })()`)
  // Pointer capture changes are "pending" until the next pointer event is dispatched, so
  // lostpointercapture does not fire on the release itself - it fires on the move after it.
  // Without this the check reads the state before the browser has told anyone anything.
  await mouse('mouseMoved', b.x + 34, b.y + 34)
  check(
    'divider: capture lost mid-drag cleans up',
    await settles(`document.body.classList.contains('sizing')`, false),
    false
  )
  await mouse('mouseReleased', b.x + 30, b.y + 30)
  await sleep(100)
}

// --------------------------------------------- a plain click must still select a pane
{
  const b = await grip()
  await mouse('mousePressed', b.x, b.y)
  await mouse('mouseReleased', b.x, b.y)
  check(
    'click: still selects a pane',
    await settles(`document.querySelectorAll('.pane.focused').length`, 1),
    1
  )
  check(
    'click: leaves no drag state behind',
    await evaluate(`document.body.classList.contains('dragging') || document.body.classList.contains('sizing')`),
    false
  )
}

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `   (got ${r.got}, want ${r.want})`}`)
}
ws.close()
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
