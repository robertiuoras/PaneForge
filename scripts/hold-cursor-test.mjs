// Does the session card show the grab cursor only once the press is HELD?
//
//   npm run try -- --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:holdcursor
//
// Why this exists. A card in the session list is two controls in one place: click it to
// select the pane, press and drag it to reorder the list. The cursor was the app's only
// answer to "which one am I doing", and it used to answer on `:active` - so EVERY click,
// including the ones that only selected a pane, flashed a grabbing hand for as long as
// the button was down. A hand that appears on a plain click says the click was a drag,
// and the one thing a hand must never do is lie about which gesture is running.
//
// So the hand is now armed by TIME (HOLD_CURSOR_MS in App.tsx), not by the press. The
// three things that can regress are all invisible in a unit test - they are computed
// style under real mouse input - and each has a check below:
//
//   * a short press must never paint the hand (the bug this fixes),
//   * a held press must paint it (the affordance this keeps),
//   * a fast drag must not wait for the hold - the drag still starts on DRAG_SLOP of
//     movement, and `body.dragging` paints the hand from there.
//
// Real input, via Input.dispatchMouseEvent: the timer is started from a React pointerdown
// and a hand-made PointerEvent would never reach the same code path with a live pointer id.

const port = process.env.PF_PORT ?? '9333'
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Every lane's test copy is told to use this port, so the first one up owns it and a
      // "verified" fix can be measured against another checkout's build entirely.
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
  npm run try -- --remote-debugging-port=${port}`)
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Page.screencastFrame') {
    ws.send(
      JSON.stringify({
        id: ++seq,
        method: 'Page.screencastFrameAck',
        params: { sessionId: m.params.sessionId }
      })
    )
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

// The test copy is minimized, and a minimized window renders no frames - which is where
// Chromium delivers deferred mouse input. A tiny screencast makes it produce frames for a
// window nobody is looking at, so presses and moves land on a schedule again.
await send('Page.enable')
await send('Page.startScreencast', {
  format: 'jpeg',
  quality: 1,
  maxWidth: 64,
  maxHeight: 64,
  everyNthFrame: 1
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function mouse(type, x, y) {
  const params = {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse'
  }
  if (type === 'mouseMoved') {
    // A minimized window never acks a move; awaiting one hangs the run.
    send('Input.dispatchMouseEvent', params).catch(() => {})
    await sleep(60)
    return
  }
  await send('Input.dispatchMouseEvent', params)
}

// Two cards, so there is something to reorder and a second card to press.
await evaluate(`(async () => {
  if (document.querySelectorAll('.row[data-id]').length >= 2) return
  const b = Array.from(document.querySelectorAll('.overlay button')).find((x) => /Start fresh/.test(x.textContent))
  if (b) b.click()
  await new Promise((r) => setTimeout(r, 300))
  const cwd = ${JSON.stringify(process.cwd().replace(/\\/g, '/'))}
  while (document.querySelectorAll('.row[data-id]').length < 2) {
    await window.api.startSession({ cwd, agent: 'shell' })
    await new Promise((r) => setTimeout(r, 1200))
  }
})()`)
await sleep(600)

const results = []
const check = (name, got, want) => results.push({ name, got, want, ok: got === want })

const rowBox = (i) =>
  evaluate(`(() => {
    const el = document.querySelectorAll('.row[data-id]')[${i}]
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width * 0.35, y: b.top + b.height / 2 }
  })()`)
// 0.35 across, not dead centre: the right of a card is its close/restart buttons, and
// beginDrag hands a press on those back to the button, correctly.
const cursor = (i) =>
  evaluate(`getComputedStyle(document.querySelectorAll('.row[data-id]')[${i}]).cursor`)
const bodyDragging = () => evaluate(`document.body.classList.contains('dragging')`)

const a = await rowBox(0)
const b = await rowBox(1)
if (!a || !b) throw new Error('no session cards in the list')

// 1. A click: press, sample well inside the hold window, release.
await mouse('mouseMoved', a.x, a.y)
await mouse('mousePressed', a.x, a.y)
await sleep(90)
check('cursor 90ms into a press (a click)', await cursor(0), 'pointer')
// 2. The same press, now held past HOLD_CURSOR_MS.
await sleep(320)
check('cursor after holding the press', await cursor(0), 'grabbing')
await mouse('mouseReleased', a.x, a.y)
await sleep(120)
check('cursor after the release', await cursor(0), 'pointer')
check('the click still selected the card', await evaluate(`
  document.querySelectorAll('.row[data-id]')[0].classList.contains('active')`), true)

// 3. A fast drag must not wait out the hold: press and move straight away.
await mouse('mouseMoved', b.x, b.y)
await mouse('mousePressed', b.x, b.y)
await mouse('mouseMoved', b.x, b.y - 30)
check('a fast drag starts without the hold', await bodyDragging(), true)
check('the dragging card shows the hand', await cursor(1), 'grabbing')
await mouse('mouseReleased', b.x, b.y - 30)
await sleep(200)
check('drag over, body is clean', await bodyDragging(), false)
check('cursor back to a click cursor', await cursor(0), 'pointer')

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.got}`)
const bad = results.filter((r) => !r.ok)
console.log(bad.length ? `\n${bad.length} failed` : `\nall ${results.length} checks passed`)
ws.close()
process.exit(bad.length ? 1 : 0)
