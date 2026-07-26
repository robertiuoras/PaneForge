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
import type { RecentItem } from '../shared/types'

/** The resting size: a pill with the count on it. */
const COLLAPSED = { width: 172, height: 38 }
/** Opened: tall enough for a real history, narrow enough to not cover a window. */
const EXPANDED = { width: 348, height: 460 }
/** Gap from the corner of the work area, so it clears the taskbar. */
const MARGIN = 12

let shelf: BrowserWindow | null = null
let expanded = false
let getMain: (() => BrowserWindow | null) | null = null
let cached: RecentItem[] = []

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

/** Re-anchor to the bottom-left. Called on every size change and every window move. */
function place(): void {
  if (!alive()) return
  const size = expanded ? EXPANDED : COLLAPSED
  const { x, y } = corner(size.width, size.height)
  try {
    shelf!.setBounds({ x, y, width: size.width, height: size.height })
  } catch {
    /* a display unplugged mid-call - the next move event puts it right */
  }
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

/** Open (or close) the list. Used by the hotkey and by the overlay's own header. */
export function setShelfExpanded(next: boolean): void {
  if (!alive()) return
  expanded = next
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
  const { width, height } = COLLAPSED
  const { x, y } = corner(width, height)
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
  })
  shelf.on('closed', () => {
    shelf = null
    expanded = false
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
