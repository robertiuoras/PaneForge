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
  const { x, y } = anchor(size.width, size.height)
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
 * A test copy an agent starts is careful about its main window - `showInactive()` then
 * `minimize()`, no focus taken, a taskbar button and nothing else. The Stash was not
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

/** Open (or close) the list. Used by the hotkey and by the overlay's own header. */
export function setShelfExpanded(next: boolean): void {
  if (!alive()) return
  // A window being dragged does not change size. The renderer holds this off too, but it
  // is the renderer's own hover timer that asks, and a timer that fires one millisecond
  // after the press is exactly the case that made a drag turn into an expand. Main owns
  // the size, so main is where "not now" has to be true.
  if (drag) return
  expanded = next
  // Closing puts the settings panel away with it: reopening on the settings page rather
  // than on your clipboard would be the wrong half of the window every time.
  if (!next) tall = false
  place()
  shelf!.webContents.send('shelf:expanded', expanded)
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
  shelf.once('ready-to-show', () => {
    if (!keptBack()) shelf?.showInactive()
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
