// The floating clipboard overlay: the shelf, outside the app.
//
// The in-window shelf only exists while PaneForge has the screen and the focus, which is
// exactly when you do not need it - the copy you want to paste back was made in a browser,
// an editor, a chat, and by then PaneForge is behind them. So the history also lives in a
// small always-on-top window that sits in the bottom-left corner of whichever display the
// main window is on, over everything else, for as long as the app is running.
//
// Three things make it behave like a system tool rather than a second app window:
//
//  * `focusable: false` - clicking a row must not take the keyboard away from whatever you
//    were typing in, because the whole point is to click a line and then press Ctrl+V
//    where you already were. Windows still delivers mouse events to a non-focusable
//    window; it just never activates it.
//  * `skipTaskbar` - it is not a window you alt-tab to.
//  * 'screen-saver' always-on-top level - one step above a normal topmost window, so a
//    full-screen browser or a video does not bury it.
//
// It is a separate BrowserWindow rather than a region of the main one because a child of
// the main window cannot outlive it being minimised, and minimised is a normal state for
// the app while you work elsewhere.

import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import { getConfig, setConfig } from './config'
import type { RecentItem, ShelfLift, StashConfig } from '../shared/types'

/** The resting size: a pill with the count on it. */
const COLLAPSED = { width: 190, height: 38 }
/** Opened: tall enough for a real history, narrow enough to not cover a window. */
const EXPANDED = { width: 352, height: 470 }
/** The settings panel behind the gear needs more room than the list does. */
const TALL = { width: 352, height: 566 }
/** Gap from the corner of the work area, so it clears the taskbar. */
const MARGIN = 12

let shelf: BrowserWindow | null = null
let expanded = false
let tall = false
/** When a pointer was last pressed on the overlay. See `shelfTouchedAt`. */
let touchedAt = 0
/**
 * When the overlay was last actually MOVED by a drag - not merely pressed.
 *
 * A press and a drag are told apart because macOS reports the app activation for them at
 * wildly different times (107ms after a click, 2882ms after a drag - measured, see
 * shared/activation.ts), and only the drag needs a window long enough to look reckless.
 */
let draggedAt = 0
let getMain: (() => BrowserWindow | null) | null = null
let cached: RecentItem[] = []
let cachedConfig: StashConfig | null = null
/** Where a drag started: the window's bounds at the moment it was picked up. */
let drag: { orig: Electron.Rectangle; moved: boolean } | null = null

/**
 * Put the overlay on every desktop - without costing the app its Dock icon.
 *
 * `setVisibleOnAllWorkspaces(_, { visibleOnFullScreen: true })` is not just a collection
 * behaviour on macOS. Since 10.14 an NSWindow may not float over a fullscreen app unless
 * the process is an accessory, so Electron does the only thing that works:
 * `TransformProcessType(kProcessTransformToUIElementApplication)` - the exact call behind
 * `app.dock.hide()`, applied to the WHOLE app and never undone. PaneForge asked for this
 * 0.7s into every launch, so on macOS it had no Dock icon at all: nothing to click,
 * nothing to Cmd-Tab to, and nothing to right-click and Keep in Dock. Measured
 * 2026-07-30 with a stripped-down Electron app: `dock.isVisible()` goes true -> false on
 * that one call, and on no other option this window sets.
 *
 * `skipTransformProcessType` opts out. The window still joins all Spaces and still keeps
 * `FullScreenAuxiliary`; what it gives up is floating above another app's *fullscreen*
 * window, which is a fair trade for the app existing in the Dock. Windows is unaffected
 * either way - it has no such transform.
 */
function floatOnAllWorkspaces(win: BrowserWindow): void {
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin'
  })
}

function alive(): boolean {
  return !!shelf && !shelf.isDestroyed() && !shelf.webContents.isDestroyed()
}

/**
 * The work area of the display the main window is on - not the primary display. Moving
 * PaneForge to the second monitor has to take its clipboard with it.
 */
function corner(width: number, height: number): { x: number; y: number } {
  const main = getMain?.()
  let area: Electron.Rectangle
  try {
    const b = main && !main.isDestroyed() ? main.getBounds() : null
    area = (b ? screen.getDisplayMatching(b) : screen.getPrimaryDisplay()).workArea
  } catch {
    area = screen.getPrimaryDisplay().workArea
  }
  return { x: area.x + MARGIN, y: area.y + area.height - height - MARGIN }
}

function currentSize(): { width: number; height: number } {
  return expanded ? (tall ? TALL : EXPANDED) : COLLAPSED
}

/**
 * The point the overlay grows from: its bottom-left corner. Everything about this window
 * is anchored there rather than at the top-left, because opening it has to push the list
 * upwards out of the pill - a top-left anchor would make the pill jump up the screen the
 * moment you hovered it.
 *
 * A dragged position is kept only while it is still on a display. Unplug the monitor it
 * was parked on and it goes back to the corner instead of being stranded off-screen with
 * no way to reach it - it is a window with no taskbar entry and no way to be alt-tabbed
 * to, so "lost off the edge" would mean lost for good.
 */
function anchor(width: number, height: number): { x: number; y: number } {
  let saved: { x: number; y: number } | null = null
  try {
    saved = getConfig().stashPos ?? null
  } catch {
    saved = null
  }
  if (!saved) return corner(width, height)
  const top = saved.y - height
  try {
    const area = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }).workArea
    // Fully on that display, and never so far down that its own header is off the edge.
    const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(top, area.y), area.y + area.height - height)
    return { x, y }
  } catch {
    return corner(width, height)
  }
}

/**
 * Summon-only: nothing on screen until it is asked for.
 *
 * The Stash was a pill in a corner, above every other window, that opened when the pointer
 * came near it. Robert's report was that it "gets in the way whenever I copy things", and
 * both halves of that are structural rather than tunable: a floating window is over
 * somebody's work by definition, and hover means the thing you did not ask for happens
 * while you are reaching for something else. So the pill is gone and the list is a summon
 * - the hotkey opens it AT THE POINTER, and the auto-close timer already puts it away.
 * Nothing is dropped: every copy is still captured, still searchable, still on the Stash.
 */
function summonOnly(): boolean {
  try {
    return getConfig().stashSummon !== false
  } catch {
    return false
  }
}

/** Where the pointer was when it was summoned, so re-anchoring does not chase the mouse. */
let summonPoint: { x: number; y: number } | null = null

/**
 * At the pointer, opening upwards, and never off the display it was summoned on. The 24px
 * and 12px are the same offsets a context menu uses: beside the pointer, not under it, so
 * the first row is not already highlighted by the cursor sitting on it.
 */
function pointerAnchor(width: number, height: number): { x: number; y: number } {
  let p = summonPoint
  try {
    if (!p) p = screen.getCursorScreenPoint()
  } catch {
    p = null
  }
  if (!p) return corner(width, height)
  try {
    const area = screen.getDisplayNearestPoint(p).workArea
    return {
      x: Math.min(Math.max(p.x - 24, area.x), area.x + area.width - width),
      y: Math.min(Math.max(p.y - height + 12, area.y), area.y + area.height - height)
    }
  } catch {
    return corner(width, height)
  }
}

/** Re-anchor. Called on every size change, every display change and every window move. */
function place(): void {
  if (!alive()) return
  // Never while the pointer is holding it. `anchor()` reads the position from the config,
  // and the config is only written when a drag ENDS - so any re-anchor during a drag (the
  // main window moved, a hover timer opened the list, the display changed) teleported the
  // overlay back to where it was picked up and resized it under the hand holding it. That
  // is the "it extends sideways instead of moving" - the pill growing into the 352px card
  // from its left edge, mid-gesture. During a drag the pointer is the only authority on
  // where this window is; endShelfDrag calls place() the moment it is let go.
  if (drag) return
  const size = currentSize()
  const { x, y } = summonOnly() ? pointerAnchor(size.width, size.height) : anchor(size.width, size.height)
  try {
    shelf!.setBounds({ x, y, width: size.width, height: size.height })
  } catch {
    /* a display unplugged mid-call - the next move event puts it right */
  }
}

/** The list needs a taller window when the settings panel is showing behind the gear. */
export function setShelfTall(next: boolean): void {
  if (!alive() || tall === next || drag) return
  tall = next
  place()
}

// --- dragging ---------------------------------------------------------------
//
// The overlay is `focusable: false`, which rules out the usual `-webkit-app-region: drag`
// (Windows moves a window by activating it first). So its header does the drag by hand:
// the page reports the pointer in screen coordinates, and the window is moved to match.

export function beginShelfDrag(): void {
  if (!alive() || ghost) return
  drag = { orig: shelf!.getBounds(), moved: false }
}

/**
 * Moving this window with setPosition is expensive ON WINDOWS, and that is not a thing
 * pacing can fix: it is transparent, always-on-top at screen-saver level, so every call
 * is a DWM recomposite and blocks for it. Measured 2026-07-28 on that machine: ~27ms per
 * setPosition, so a paced drag topped out at 37Hz however the calls were scheduled -
 * and disabling the blur and shadows changed nothing (47 vs 44 positions painted per
 * 1.2s sweep), so it is the transparency itself, not the styling.
 *
 * So a drag there moves the window ONCE: on the first real move it is expanded to cover
 * every display (`lift`), the content slides inside it with a CSS transform - compositor
 * work, no window move, every frame - and on release (`drop`) the window shrinks back
 * to content size at the dragged-to position. The two bounds changes are hidden behind
 * setOpacity(0), and the renderer says when it has repainted (`shown`) so the reveal
 * never shows the content mid-jump.
 *
 * macOS has no DWM and no such cost - measured 2026-07-30 on this Mac, on a window with
 * these exact options: 0.35ms per setPosition, 0.08ms per setBounds. There the trick is
 * all downside, and it was visibly wrong. AppKit refuses to put a window's frame under
 * the menu bar unless it was built with `enableLargerThanScreen`, so asking for the whole
 * desktop at y=0 landed the window at y=33 (measured: requested {0,0,1512,982}, got
 * {0,33,1512,982}) - and the content, slid by a transform computed from the rectangle it
 * ASKED for, was nowhere near the hand holding it: `npm run test:stashdrag` against the
 * old code puts the grabbed grip (-105, +100) px from the pointer mid-drag, and 128px
 * from where it was let go. That is the gap between the mouse and the Stash.
 *
 * So macOS drags the window itself, once per pointer move (`LIVE_DRAG`): no ghost window
 * over every display, no transform, no opacity dance, and nothing in between the pointer
 * and the window to be off by.
 */
const LIVE_DRAG = process.platform === 'darwin'

let ghost: { orig: Electron.Rectangle; watchdog: NodeJS.Timeout } | null = null

/** The one rectangle that covers every display there is. */
function desktopBounds(): Electron.Rectangle {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const d of screen.getAllDisplays()) {
    minX = Math.min(minX, d.bounds.x)
    minY = Math.min(minY, d.bounds.y)
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width)
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1920, height: 1080 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function liftShelfDrag(): ShelfLift {
  if (!alive() || !drag || ghost) return null
  drag.moved = true
  // The lift IS the first movement - on the ghost path it is the only one the main process
  // ever hears about, because the content then slides under a CSS transform and no further
  // move reaches here until the drop.
  draggedAt = Date.now()
  // Where moving the window is cheap, that is the whole implementation: the renderer
  // reports the pointer and `moveShelfDrag` puts the window there.
  if (LIVE_DRAG) return { live: true }
  const orig = drag.orig
  ghost = {
    orig,
    // A drop that never arrives (the renderer died mid-drag, the pointer was lost)
    // would leave an invisible-content window covering every display and eating every
    // click. Nothing else can undo that state, so time it out.
    watchdog: setTimeout(() => dropShelfDrag(0, 0), 60_000)
  }
  try {
    shelf!.setOpacity(0)
    shelf!.setBounds(desktopBounds())
  } catch {
    /* a display vanished mid-call; the watchdog or the drop still restores */
  }
  // Where the window ENDED UP, never where it was asked to go: a window manager is free
  // to clamp that rectangle (macOS does, by the height of the menu bar), and a transform
  // built on the request would then hold the content that far from the pointer.
  const big = shelf!.getBounds()
  return { dx: orig.x - big.x, dy: orig.y - big.y, w: orig.width, h: orig.height }
}

/** A pointer move during a live drag: the window goes where the pointer took it. */
export function moveShelfDrag(dx: number, dy: number): void {
  if (!alive() || !drag || ghost) return
  drag.moved = true
  draggedAt = Date.now()
  const { orig } = drag
  try {
    shelf!.setBounds({
      x: Math.round(orig.x + dx),
      y: Math.round(orig.y + dy),
      width: orig.width,
      height: orig.height
    })
  } catch {
    /* a display vanished mid-move; the next move (or the drop) puts it right */
  }
}

/** The end of a live drag: settle on the last position and remember it. */
function moveShelfDragFinal(orig: Electron.Rectangle, dx: number, dy: number): void {
  try {
    shelf!.setBounds({
      x: Math.round(orig.x + dx),
      y: Math.round(orig.y + dy),
      width: orig.width,
      height: orig.height
    })
    const b = shelf!.getBounds()
    setConfig({ stashPos: { x: b.x, y: b.y + b.height } })
  } catch {
    /* a position that could not be written is only a position */
  }
  // Put it back inside the work area if it was let go half off the edge.
  place()
}

/** The renderer has painted the lifted (or dropped) frame; safe to show again. */
export function shownShelfDrag(): void {
  if (alive() && shelf!.getOpacity() < 1) shelf!.setOpacity(1)
}

/** Shrink back to content size where it was let go, and remember the spot. */
export function dropShelfDrag(dx: number, dy: number): void {
  const live = drag && !ghost ? drag : null
  // Stamped from the moment the hand lets go, which is what the window is measured from:
  // the activation for a drag arrives seconds AFTER the drop, not during it.
  if (drag?.moved || ghost) draggedAt = Date.now()
  drag = null
  if (live) {
    // Nothing to shrink - the window has been where the pointer is all along. Put it
    // exactly there one last time (the last pointer move can be a frame stale), keep the
    // spot, and let place() pull it back if it was let go half off the edge.
    if (!alive()) return
    moveShelfDragFinal(live.orig, dx, dy)
    return
  }
  if (!ghost) return
  const { orig, watchdog } = ghost
  clearTimeout(watchdog)
  ghost = null
  if (!alive()) return
  try {
    shelf!.setOpacity(0)
    shelf!.setBounds({
      x: Math.round(orig.x + dx),
      y: Math.round(orig.y + dy),
      width: orig.width,
      height: orig.height
    })
    const b = shelf!.getBounds()
    setConfig({ stashPos: { x: b.x, y: b.y + b.height } })
  } catch {
    /* a position that could not be written is only a position */
  }
  // Put it back inside the work area if it was let go half off the edge.
  place()
  // The renderer reveals the window the frame after it clears its transform; if it
  // cannot (torn down mid-drag), reveal anyway rather than staying invisible forever.
  setTimeout(() => shownShelfDrag(), 250)
}

/** A press that never turned into a drag: a click on the header, nothing to move. */
export function endShelfDrag(): void {
  drag = null
  // The click path never lifted, but belt-and-braces: a stray end after a lift must
  // not strand the expanded window.
  if (ghost) dropShelfDrag(0, 0)
}

export function shelfWindowOpen(): boolean {
  return alive()
}

/**
 * When a pointer was last pressed on the overlay - 0 if it never has been.
 *
 * Read by the activation handlers in index.ts: on macOS a click anywhere in the app
 * activates the app, and answering that by revealing the main window is the Stash dragging
 * PaneForge over the thing you were about to paste into. Recorded from the main process's
 * own input routing rather than from an IPC message the page sends, because the page's
 * message is a round trip later and the activation is already being decided by then.
 */
export function shelfTouchedAt(): number {
  return touchedAt
}

/**
 * When the overlay was last MOVED, and whether it is being moved right now.
 *
 * Read by the activation handlers in index.ts alongside `shelfTouchedAt`. A press that never
 * travelled leaves this at its previous value on purpose: a click is not a drag, and giving
 * it the drag's four-second window would start swallowing deliberate Cmd-Tabs, which is the
 * thing the short window exists to protect.
 */
export function shelfDraggedAt(): number {
  return draggedAt
}

/** A drag is in flight. However long it is held, it explains any activation during it. */
export function shelfDragging(): boolean {
  return !!drag || !!ghost
}

/**
 * Fallback for physical presses that AppKit delivers to the non-activating panel without
 * Electron also surfacing a webContents input event. The renderer reports it in capture
 * phase, before any drag or button handler, and index.ts already settles activation for it.
 */
export function noteShelfTouch(): void {
  touchedAt = Date.now()
}

/** True while a game has the overlay put away. See setShelfHidden. */
let hiddenForGame = false

/**
 * Put the overlay away without closing it, for as long as a game is on screen.
 *
 * This window is the app's worst offender for a fullscreen game and not because of
 * focus: it is `alwaysOnTop` at screen-saver level with `visibleOnFullScreen`, which is
 * a window Windows must composite above an exclusive-fullscreen game - so the game
 * stops being exclusive. Dropping the always-on-top flag as well as hiding, because a
 * hidden window that is still registered above the screen saver has been enough on its
 * own. Closing it instead would work too but would throw away the clipboard history it
 * is holding, and it comes back the moment the game exits.
 */
export function setShelfHidden(hidden: boolean): void {
  if (hidden === hiddenForGame) return
  hiddenForGame = hidden
  if (!alive()) return
  if (hidden) {
    shelf!.setAlwaysOnTop(false)
    shelf!.hide()
    return
  }
  // The game left, but a copy launched out of sight is still holding it back.
  if (hiddenForQuiet) return
  shelf!.setAlwaysOnTop(true, 'screen-saver')
  place()
  shelf!.showInactive()
}

/** Whether a newly created overlay should stay out of sight (a game was already up). */
export function shelfHiddenForGame(): boolean {
  return hiddenForGame
}

/** True while a copy that launched out of sight is holding the overlay back. */
let hiddenForQuiet = false

/**
 * Keep the overlay off the screen for a copy that was launched minimized.
 *
 * A test copy an agent starts is careful about its main window - a taskbar button and
 * nothing else on Windows, and on macOS not even shown (see revealPlan). The Stash was not
 * part of that deal: it is `alwaysOnTop` at screen-saver level and `skipTaskbar`, so it
 * appeared over whatever was on screen, from an app with no visible window to close it
 * from. Measured 2026-07-28: `npm run try` put a visible Stash up 0.7s into the launch
 * while the main window correctly stayed hidden the whole time.
 *
 * Released the moment a human touches the window (focus or restore), which is the same
 * signal the idle-quit timer in index.ts trusts.
 */
export function setShelfQuiet(quiet: boolean): void {
  if (quiet === hiddenForQuiet) return
  hiddenForQuiet = quiet
  if (!alive()) return
  if (quiet) {
    shelf!.setAlwaysOnTop(false)
    shelf!.hide()
    return
  }
  if (hiddenForGame) return
  shelf!.setAlwaysOnTop(true, 'screen-saver')
  floatOnAllWorkspaces(shelf!)
  place()
  shelf!.showInactive()
}

/** Either reason the overlay is currently being kept off the screen. */
function keptBack(): boolean {
  return hiddenForGame || hiddenForQuiet
}

/**
 * Put it back in the corner of whatever display the app is on now. The main window calls
 * this as it moves; it does nothing at all while the overlay is off.
 */
export function placeShelf(): void {
  if (alive()) place()
}

/** Newest items, pushed to the overlay (and remembered for the next time it loads). */
export function updateShelfItems(items: RecentItem[]): void {
  cached = items
  if (alive()) shelf!.webContents.send('shelf:items', items)
}

export function shelfItems(): RecentItem[] {
  return cached
}

/** The Stash's own settings, pushed to the panel behind the overlay's gear. */
export function updateShelfConfig(config: StashConfig): void {
  cachedConfig = config
  if (alive()) shelf!.webContents.send('shelf:config', config)
}

/**
 * Whether the main window is currently showing the Stash itself.
 *
 * There is one Stash. The overlay is at the 'screen-saver' always-on-top level, one step
 * above a normal topmost window, so an expanded overlay covers the main window's list
 * rather than sitting beside it - two lists of the same clips, the readable one hidden
 * behind the one that cannot be typed into. While the window has it, the overlay is a
 * pill.
 */
let windowStash = false

/** Told by the renderer when its own Stash opens or closes. */
export function setStashInWindow(open: boolean): void {
  windowStash = open
  if (open) setShelfExpanded(false)
}

/** Open (or close) the list. Used by the hotkey and by the overlay's own header. */
export function setShelfExpanded(next: boolean): void {
  if (!alive()) return
  // Never a second list. Closing is always allowed - this only refuses to open one.
  if (next && windowStash) return
  // A window being dragged does not change size. The renderer holds this off too, but it
  // is the renderer's own hover timer that asks, and a timer that fires one millisecond
  // after the press is exactly the case that made a drag turn into an expand. Main owns
  // the size, so main is where "not now" has to be true.
  if (drag) return
  // Summoned: the list appears where the pointer is, and where it is asked for is decided
  // once - re-anchoring on every resize would make it chase the mouse across the screen
  // while the settings panel opens under it.
  if (summonOnly() && next) summonPoint = cursorNow()
  expanded = next
  // Closing puts the settings panel away with it: reopening on the settings page rather
  // than on your clipboard would be the wrong half of the window every time.
  if (!next) tall = false
  place()
  shelf!.webContents.send('shelf:expanded', expanded)
  // ...and there is nothing to leave on screen when it closes.
  if (summonOnly()) {
    if (next) {
      if (!keptBack()) shelf!.showInactive()
    } else {
      summonPoint = null
      shelf!.hide()
    }
  }
}

/** The pointer now, or nothing if the display layout is being rebuilt under us. */
function cursorNow(): { x: number; y: number } | null {
  try {
    return screen.getCursorScreenPoint()
  } catch {
    return null
  }
}

export function toggleShelf(): void {
  if (!alive()) return
  setShelfExpanded(!expanded)
  // Opened by hotkey from another app: make sure it is on top of whatever just claimed
  // that spot, without taking focus.
  // Not while a game has it put away: the hotkey toggles the state, and it appears when
  // the game does not need the screen any more.
  if (expanded && !keptBack()) shelf!.showInactive()
}

export function openShelfWindow(mainWindow: () => BrowserWindow | null): void {
  getMain = mainWindow
  if (alive()) return
  expanded = false
  tall = false
  const { width, height } = COLLAPSED
  const { x, y } = anchor(width, height)
  shelf = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // See the note at the top: clicking the overlay must never steal the keyboard.
    focusable: false,
    // On macOS `focusable: false` is not enough, and the gap is the whole feature.
    // It stops the WINDOW becoming key; it does not stop the click activating the
    // APP, and PaneForge answers activation by revealing its main window (index.ts) -
    // so clicking a row to copy, or grabbing the grip to move the overlay, pulled the
    // whole app over whatever you were typing in, and took the focus that the Cmd-V
    // was going to. A panel carries NSWindowStyleMaskNonactivatingPanel: clicks are
    // delivered, the app is never activated, and the frontmost app stays frontmost.
    // Windows has no such window class and needs none - it already delivers mouse
    // events to a non-focusable window without activating it.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    title: 'PaneForge clipboard',
    webPreferences: {
      preload: join(__dirname, '../preload/shelf.js'),
      sandbox: false,
      contextIsolation: true,
      // It has to keep counting and re-rendering while the app it belongs to is buried.
      backgroundThrottling: false
    }
  })
  // Both of these are what a fullscreen game cannot survive, so a window built while a
  // game is already running is built without them and gets them from setShelfHidden(false).
  if (!keptBack()) {
    shelf.setAlwaysOnTop(true, 'screen-saver')
    floatOnAllWorkspaces(shelf)
  }
  // A pointer press on the overlay, timestamped where the input is routed rather than
  // where the page reacts to it. Only presses: a pointer merely passing over the Stash
  // must not suppress a Cmd-Tab a moment later. See shelfTouchedAt().
  shelf.webContents.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'mouseUp') noteShelfTouch()
  })
  shelf.once('ready-to-show', () => {
    // Summon-only builds the window and leaves it off screen. It has to exist - it holds
    // the list and answers the hotkey in a frame - it simply is not shown until asked.
    if (!keptBack() && !(summonOnly() && !expanded)) shelf?.showInactive()
    updateShelfItems(cached)
    if (cachedConfig) updateShelfConfig(cachedConfig)
    // Something may have asked for it open before the page existed (the hotkey bringing a
    // hidden overlay back), and that message went nowhere. Say it again now.
    if (expanded) {
      place()
      shelf?.webContents.send('shelf:expanded', true)
    }
  })
  shelf.on('closed', () => {
    shelf = null
    expanded = false
    tall = false
    drag = null
    if (ghost) clearTimeout(ghost.watchdog)
    ghost = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    shelf.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/shelf.html`)
  } else {
    shelf.loadFile(join(__dirname, '../renderer/shelf.html'))
  }

  // Follow the app around: another display, a different taskbar size, a screen unplugged.
  // The main window's own move events call placeShelf() - it is recreated over the app's
  // life, so it wires itself up rather than being subscribed to from here.
  screen.on('display-metrics-changed', place)
  screen.on('display-added', place)
  screen.on('display-removed', place)
}

export function closeShelfWindow(): void {
  screen.removeListener('display-metrics-changed', place)
  screen.removeListener('display-added', place)
  screen.removeListener('display-removed', place)
  if (alive()) shelf!.close()
  shelf = null
  expanded = false
}
