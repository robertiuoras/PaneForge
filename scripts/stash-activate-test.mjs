// When an app activation is allowed to put the main window on screen.
//
//   node scripts/stash-activate-test.mjs
//
// This is a rule about milliseconds on a platform this repo is mostly not developed on,
// which is the exact shape of a rule nobody re-checks. What it is protecting is the whole
// point of the Stash: copy in the overlay, press Cmd-V in the app you were already in. On
// macOS a click on any window activates the APP, PaneForge answers activation by revealing
// its main window, and so clicking a row - or grabbing the grip to move the overlay -
// pulled PaneForge over the thing being pasted into and took the focus with it.
//
// The load-bearing assertion is the ordering one. The press and the activation are one
// gesture arriving by two routes, and on a real click the press is timestamped AFTER the
// activation lands. A guard written the way it reads ("was the Stash touched before this?")
// passes every test anyone would think to write and fixes nothing at all.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-activate-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'activation.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/activation.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { revealOnActivation, SHELF_TOUCH_MS, SHELF_DRAG_MS, ACTIVATION_SETTLE_MS } = createRequire(
  import.meta.url
)(out)

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}

const T = 1_000_000

// --- the reveal that has to keep working ------------------------------------
// Everything below refuses a reveal, so the first thing to pin is that a reveal still
// happens at all: a Dock click or a Cmd-Tab with nothing else going on.
ok(
  'a plain activation reveals the window',
  revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: 0 })
)
ok(
  'an activation long after the last Stash press still reveals',
  revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T - 5000 })
)

// --- the launch's own activation --------------------------------------------
ok(
  'the activation macOS emits for the launch itself is ignored',
  !revealOnActivation({ activatedAt: T, quietUntil: T + 1, shelfTouchedAt: 0 })
)
ok(
  'once the quiet window has passed, the same activation reveals',
  revealOnActivation({ activatedAt: T, quietUntil: T, shelfTouchedAt: 0 })
)

// --- the Stash --------------------------------------------------------------
ok(
  'a press on the Stash just before the activation explains it',
  !revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T - 5 })
)
// The one that matters. On a real click the app is activated by the mouse-down and the
// input event is routed to the overlay a moment later, so the press timestamp is HIGHER
// than the activation's. `activatedAt - shelfTouchedAt` is negative there, and a guard
// that only looked for a positive, recent gap would let every real click through.
ok(
  'a press timestamped AFTER the activation explains it too',
  !revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T + 40 })
)
ok(
  'a press within the settle the handler waits still explains it',
  !revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T + ACTIVATION_SETTLE_MS })
)
ok(
  'a press exactly at the edge of the window still explains it',
  !revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T - SHELF_TOUCH_MS })
)
ok(
  'a press one millisecond older than the window does not',
  revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: T - SHELF_TOUCH_MS - 1 })
)

// --- dragging the overlay, which is the case the touch window cannot reach ----
//
// These four numbers are not invented. They come off a real Mac, from
// `scripts/stash-activate-probe.mjs` posting CGEvents at the HID tap so the window sees
// hardware-identical input, with the decision logged on the other side:
//
//   click  mouseDown → mouseUp 32ms later → activation  107ms after the press
//   drag   mouseDown → 1.6s of movement  → activation 2882ms after the drop
//
// That gap is the whole bug. It was reported three times and fixed twice, both times by
// reasoning about AppKit rather than timing it, and both times the fix covered the click and
// left the drag exactly as it was. So the measured numbers are the assertions.

const MEASURED_CLICK_LAG = 107
const MEASURED_DRAG_LAG = 2882

ok(
  'the measured CLICK lag is suppressed by the touch window alone',
  !revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: T - MEASURED_CLICK_LAG,
    shelfDraggedAt: 0
  })
)
ok(
  'the measured DRAG lag is NOT covered by the touch window - this is the bug',
  MEASURED_DRAG_LAG > SHELF_TOUCH_MS
)
ok(
  'the measured DRAG lag IS suppressed once the drag is known about',
  !revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: T - MEASURED_DRAG_LAG,
    shelfDraggedAt: T - MEASURED_DRAG_LAG
  })
)
ok(
  'the drag window has headroom over what was measured',
  SHELF_DRAG_MS > MEASURED_DRAG_LAG
)

// A drag still in flight explains an activation however long it is held. Without this a
// slow, careful drag outlives any fixed window there could be.
ok(
  'an activation during a drag never reveals, however long the drag has run',
  !revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: T - 60_000,
    shelfDraggedAt: T - 60_000,
    shelfDragging: true
  })
)

// The ordering case again, for the drag: the drop can be stamped after the activation.
ok(
  'a drop stamped after the activation still suppresses it',
  !revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: 0,
    shelfDraggedAt: T + 40
  })
)

// And the reveal that must survive all of it: long enough after a drag, a deliberate
// Cmd-Tab still brings the window. A suppression window that never lets go is a window
// nobody can get back to.
ok(
  'a deliberate activation well after a drag still reveals',
  revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: T - SHELF_DRAG_MS - 1,
    shelfDraggedAt: T - SHELF_DRAG_MS - 1
  })
)

// A press that never travelled must not borrow the drag's much longer window - that is what
// would start swallowing the Cmd-Tabs the short window exists to protect.
ok(
  'a plain click is still judged on the short window',
  revealOnActivation({
    activatedAt: T,
    quietUntil: 0,
    shelfTouchedAt: T - SHELF_TOUCH_MS - 1,
    shelfDraggedAt: T - SHELF_DRAG_MS - 1
  })
)
// A Stash that has never been pressed must not read as "pressed at the epoch" and, worse,
// must not read as a press 1970ms ago on a machine whose clock says something odd.
ok(
  'never touched is not a touch',
  revealOnActivation({ activatedAt: T, quietUntil: 0, shelfTouchedAt: 0 })
)

// --- the numbers themselves --------------------------------------------------
// Both are held against the gesture they describe rather than left free: a settle longer
// than the touch window would decide before the press it is waiting for could arrive, and
// a touch window of seconds would eat a deliberate Cmd-Tab that followed a copy.
ok('the settle is shorter than the touch window', ACTIVATION_SETTLE_MS < SHELF_TOUCH_MS)
ok('the touch window is under a second', SHELF_TOUCH_MS <= 1000)

// --- the window options, at the call site -----------------------------------
// The pure rule above is the belt. The braces is the overlay never activating the app in
// the first place, and that is one word in an options object - the kind of thing a later
// edit drops without noticing, on a platform this repo is not usually run on.
const shelfSrc = readFileSync(join(root, 'src/main/shelfWindow.ts'), 'utf8')
ok(
  "the overlay is an NSPanel on darwin (focusable:false does not stop app activation)",
  /darwin'\s*\?\s*\{\s*type:\s*'panel'\s*\}/.test(shelfSrc)
)
ok(
  'a pointer press on the overlay is recorded from main, not from an IPC message',
  /webContents\.on\('input-event'[\s\S]{0,220}mouseDown/.test(shelfSrc)
)

// A non-activating macOS panel can deliver a physical press to AppKit without delivering
// Electron's webContents input-event. The renderer's capture listener is the fallback for
// that path; the activation decision already waits long enough for this one-way IPC.
const preloadSrc = readFileSync(join(root, 'src/preload/shelf.ts'), 'utf8')
const rendererSrc = readFileSync(join(root, 'src/renderer/src/shelf.tsx'), 'utf8')
const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok(
  'the overlay reports a physical press through the preload fallback',
  /touch:\s*\(\)\s*=>\s*ipcRenderer\.send\('shelf:touch'\)/.test(preloadSrc)
)
ok(
  'the renderer reports every pointer press before component handlers run',
  /addEventListener\('pointerdown',\s*\(\)\s*=>\s*shelf\.touch\(\),\s*\{\s*capture:\s*true\s*\}\)/.test(
    rendererSrc
  )
)
ok(
  'main records the preload fallback through the same Stash touch state',
  /ipcMain\.on\('shelf:touch',\s*\(\)\s*=>\s*noteShelfTouch\(\)\)/.test(mainSrc)
)

// --- Electron still delivers what the recorder listens for -------------------
// `input-event` carrying mouse events to a focusable:false window is the one assumption
// here that an Electron upgrade could take away silently: the guard would then never fire
// and every click would raise the app again, exactly as before.
const electron = createRequire(import.meta.url)('electron')
const probe = join(work, 'probe.cjs')
writeFileSync(
  probe,
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 190, height: 38, show: false, frame: false, transparent: true, hasShadow: false,
    resizable: false, skipTaskbar: true, focusable: false,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {})
  })
  const seen = []
  w.webContents.on('input-event', (_e, input) => seen.push(input.type))
  await w.loadURL('data:text/html,<body style="margin:0">x</body>')
  w.showInactive()
  const at = { x: 20, y: 15, button: 'left', clickCount: 1 }
  w.webContents.sendInputEvent({ type: 'mouseDown', ...at })
  w.webContents.sendInputEvent({ type: 'mouseUp', ...at })
  setTimeout(() => {
    console.log('SEEN=' + JSON.stringify(seen) + ' PANEL=' + (process.platform !== 'darwin' || !w.isDestroyed()))
    app.exit(0)
  }, 600)
})
`
)
const r = spawnSync(electron, [probe], { encoding: 'utf8', timeout: 90_000 })
const line = /SEEN=(\[[^\]]*\]) PANEL=(\w+)/.exec(r.stdout ?? '')
if (!line) {
  console.error(r.stdout, r.stderr)
  throw new Error('the Electron probe printed nothing - see the output above')
}
const seen = JSON.parse(line[1])
ok("Electron still routes 'mouseDown' to a focusable:false overlay's input-event", seen.includes('mouseDown'))
ok("and 'mouseUp' with it, which is what ends a drag", seen.includes('mouseUp'))
ok('the window options are ones Electron still accepts on this platform', line[2] === 'true')

rmSync(work, { recursive: true, force: true })
console.log(`stash-activate: ${n} assertions passed`)
