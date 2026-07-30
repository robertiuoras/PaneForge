// Does the Stash stay under the pointer while it is being dragged?
//
//   npm run try -- --keep --minimized --remote-debugging-port=9333
//   npm run test:stashdrag
//
// Why this exists. The overlay is `focusable: false`, so it cannot be moved by
// `-webkit-app-region: drag`; the page reports the pointer and main puts the window
// there. On Windows that is too slow to do per frame (~27ms a setPosition on a
// transparent always-on-top window), so the drag expands the window over the whole
// desktop once and slides the CONTENT inside it with a transform - and that transform is
// arithmetic on where the big window is, which is where the bug lived: AppKit refuses to
// put a window's frame under the menu bar, so asking for the desktop at y=0 landed the
// window at y=33 and the content sat 33px from the hand holding it. macOS now moves the
// window itself instead, and either way the invariant is the same and is what is checked
// here: the thing you grabbed stays exactly where the pointer is, mid-gesture, not only
// once it is let go.
//
// Real input, not synthesised events: `setPointerCapture` throws for a pointer id no
// physical pointer owns, and this drag is built on capture, so a hand-made PointerEvent
// would test nothing. CDP's Input domain drives the same pipeline the mouse does.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const port = process.env.PF_PORT ?? '9333'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
  if (!ok) failed++
}

async function findShelf() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url ?? '').includes('shelf')
      )
      // Same trap probe.mjs guards: every lane's test copy is told to use this port, so a
      // "verified" fix can be measured against another checkout's build entirely.
      if (page && !(page.url ?? '').toLowerCase().startsWith(rootUrl))
        throw new Error(
          `port ${port} belongs to another checkout's test copy:\n  ${page.url}\n` +
            `expected a window loaded from ${root}`
        )
      if (page) return page
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `no Stash overlay on port ${port}. Start one with:\n` +
      `  npm run try -- --keep --minimized --remote-debugging-port=${port}`
  )
}

const page = await findShelf()
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

async function evaluate(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails)
    throw new Error(out.exceptionDetails.exception?.description ?? 'evaluate failed')
  return out.result?.value
}

/**
 * Where the grip is ON THE SCREEN, and where it is in the page. getBoundingClientRect
 * carries the transform the Windows path slides the content with, and screenX/screenY are
 * the window's own position, so the sum is the truth under either implementation.
 */
const probeGrip = `(() => {
  const g = document.querySelector('.pill-grip') || document.querySelector('.grip')
  if (!g) return null
  const r = g.getBoundingClientRect()
  return {
    page: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    screen: { x: window.screenX + r.left + r.width / 2, y: window.screenY + r.top + r.height / 2 },
    win: { x: window.screenX, y: window.screenY },
    grip: { w: r.width, h: r.height }
  }
})()`

const before = await evaluate(probeGrip)
check('the collapsed pill has a grip to drag by', !!before, 'no .pill-grip in the overlay')
if (!before) {
  ws.close()
  process.exit(1)
}

// The handle has to be big enough to hit without aiming: 22px of drawn lines is not, and
// missing it left of the lines lands on the pill, which opens the list instead of moving
// it. The hit box is a pseudo element, so ask elementFromPoint rather than the geometry.
const reach = await evaluate(`(() => {
  const g = document.querySelector('.pill-grip')
  const r = g.getBoundingClientRect()
  const y = r.top + r.height / 2
  let x = r.left
  // Walk left until the pill answers instead of the grip.
  while (x > 0 && document.elementFromPoint(x - 1, y)?.closest?.('.pill-grip')) x -= 1
  return { width: r.right - x, height: r.height }
})()`)
check(
  'the grip is grabbable without aiming (>= 50px of pill answers to it)',
  reach.width >= 50,
  `only ${Math.round(reach.width)}px wide - a press left of the lines opens the list instead`
)

const DX = 140
const DY = -90
const steps = 12

async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse',
    ...extra
  })
}

await mouse('mousePressed', before.page.x, before.page.y)
let mid = null
for (let i = 1; i <= steps; i++) {
  const x = before.page.x + (DX * i) / steps
  const y = before.page.y + (DY * i) / steps
  await mouse('mouseMoved', x, y)
  // Two frames: one for the window move to land, one for the page to see its new position.
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  if (i === steps - 2) mid = await evaluate(probeGrip)
}

// Mid-gesture, still holding it: this is the measurement the old code failed.
const wantX = before.screen.x + (DX * (steps - 2)) / steps
const wantY = before.screen.y + (DY * (steps - 2)) / steps
const offX = mid ? mid.screen.x - wantX : NaN
const offY = mid ? mid.screen.y - wantY : NaN
check(
  'mid-drag the grip is still under the pointer',
  Math.abs(offX) <= 2 && Math.abs(offY) <= 2,
  `off by (${offX}, ${offY}) px - the Stash is that far from the hand holding it`
)

await mouse('mouseMoved', before.page.x + DX, before.page.y + DY)
await mouse('mouseReleased', before.page.x + DX, before.page.y + DY)
await new Promise((r) => setTimeout(r, 500))

const after = await evaluate(probeGrip)
check(
  'let go, the window kept the whole distance it was dragged',
  Math.abs(after.screen.x - (before.screen.x + DX)) <= 2 &&
    Math.abs(after.screen.y - (before.screen.y + DY)) <= 2,
  `moved to (${after.screen.x}, ${after.screen.y}), asked for ` +
    `(${before.screen.x + DX}, ${before.screen.y + DY})`
)
check(
  'the window is back at content size, not still covering the desktop',
  after.grip.h <= 60,
  `the grip is ${after.grip.h}px tall - the overlay is still the lifted ghost`
)
const opened = await evaluate(`!!document.querySelector('.card')`)
check('dragging it did not open the list', opened === false)

// Put it back where it was found, so a test run is not a rearrangement.
await mouse('mousePressed', after.page.x, after.page.y)
for (let i = 1; i <= 6; i++) {
  await mouse('mouseMoved', after.page.x - (DX * i) / 6, after.page.y - (DY * i) / 6)
  await evaluate('new Promise(r => requestAnimationFrame(r))')
}
await mouse('mouseReleased', after.page.x - DX, after.page.y - DY)
await new Promise((r) => setTimeout(r, 400))

ws.close()
if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nstash drag: all checks passed')
