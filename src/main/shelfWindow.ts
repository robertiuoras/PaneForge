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
import type { RecentItem, StashConfig } from '../shared/types'

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
/** Where a drag started: the pointer, and the window's bottom-left at that moment. */
let drag: { px: number; py: number; x: number; bottom: number; moved: boolean } | null = null

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
  if (!alive() || tall === next) return
  tall = next
  place()
}

// --- dragging ---------------------------------------------------------------
//
// The overlay is `focusable: false`, which rules out the usual `-webkit-app-region: drag`
// (Windows moves a window by activating it first). So its header does the drag by hand:
// the page reports the pointer in screen coordinates, and the window is moved to match.

export function beginShelfDrag(): void {
  if (!alive()) return
  const b = shelf!.getBounds()
  drag = { px: NaN, py: NaN, x: b.x, bottom: b.y + b.height, moved: false }
  pendingMove = null
  lastAt = { x: b.x, y: b.y }
}

/**
 * Moving this window is expensive, and that is not a thing this code can fix: it is
 * transparent, always-on-top at screen-saver level and blurring what is behind it, so
 * every move is a DWM recomposite of whatever it is floating over. Measured on the
 * machine this was written on: 10.3ms average per `setBounds`, 41ms at worst.
 *
 * A pointer produces moves far faster than that (a 1000Hz mouse, coalesced by Chromium
 * to one per frame, is still 60-144 a second), so the naive "one message, one move"
 * built a queue that main could never drain: the pill kept crawling towards the cursor
 * for the better part of a second AFTER the mouse had stopped. That is the lag.
 *
 * Two things fix it, and both are about doing less rather than doing it faster:
 *
 *  * only ever the newest position matters - an intermediate one on the way to where the
 *    pointer is now is a frame nobody will see - so a move that arrives while one is
 *    still owed replaces it instead of joining a queue;
 *  * `setPosition` instead of `setBounds`, because the size is not changing and asking
 *    for a resize as well costs about 2ms of the 10 (8.2ms average, 21ms worst).
 *
 * The result cannot back up: at most one pending position exists at any moment, so the
 * window is always at most one frame behind the pointer no matter how fast the mouse is.
 */
const DRAG_FRAME_MS = 16
let pendingMove: { x: number; y: number } | null = null
let moveTimer: NodeJS.Timeout | null = null
let lastAt: { x: number; y: number } | null = null

function flushMove(): void {
  moveTimer = null
  const next = pendingMove
  pendingMove = null
  if (!next || !alive()) return
  // The pointer can travel several pixels inside one frame without the window's rounded
  // position changing; that call is pure cost.
  if (lastAt && lastAt.x === next.x && lastAt.y === next.y) return
  lastAt = next
  try {
    shelf!.setPosition(next.x, next.y)
  } catch {
    /* dragged across a display that vanished - endShelfDrag puts it back in bounds */
  }
}

export function moveShelfDrag(px: number, py: number): void {
  if (!alive() || !drag) return
  // The first move is what fixes the grab point; before it there is no delta to apply.
  if (Number.isNaN(drag.px)) {
    drag.px = px
    drag.py = py
    return
  }
  const size = currentSize()
  drag.moved = true
  pendingMove = {
    x: Math.round(drag.x + (px - drag.px)),
    y: Math.round(drag.bottom + (py - drag.py) - size.height)
  }
  // The first move of a gesture goes now, so the window does not start a frame late.
  if (moveTimer) return
  flushMove()
  moveTimer = setTimeout(flushMove, DRAG_FRAME_MS)
}

/** Remember where it was let go, so it is still there after a restart. */
export function endShelfDrag(): void {
  if (!drag) return
  const moved = drag.moved
  drag = null
  // Let go mid-frame: the last position the pointer reached is still owed, and it is the
  // one that gets written to the config below.
  if (moveTimer) clearTimeout(moveTimer)
  moveTimer = null
  flushMove()
  // A press that never turned into a drag is a click on the header, not a move: writing
  // the config on every one of those would rewrite the file all afternoon.
  if (!moved || !alive()) return
  const b = shelf!.getBounds()
  try {
    setConfig({ stashPos: { x: b.x, y: b.y + b.height } })
  } catch {
    /* a position that could not be written is only a position */
  }
  // Put it back inside the work area if it was let go half off the edge.
  place()
}

export function shelfWindowOpen(): boolean {
  return alive()
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
  if (expanded) shelf!.showInactive()
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
  shelf.setAlwaysOnTop(true, 'screen-saver')
  shelf.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  shelf.once('ready-to-show', () => {
    shelf?.showInactive()
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
