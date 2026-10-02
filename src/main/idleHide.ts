// The clock behind `shared/idleHide.ts`: hide the window when this PC's desk is empty and
// nobody is using it, and show it again (without focus) when a pane appears.
//
// "Using the window" is the window being focused while the OS says there was input in the
// last poll: input while PaneForge has focus is input to PaneForge, and it covers the
// mouse, which the renderer's own key clock does not. Focus alone is not use - on a PC
// nobody sits at, PaneForge is the last thing focused for ever (see `idlequit.ts`).

import { powerMonitor, type BrowserWindow } from 'electron'
import { idleHideReveal, idleHideVerdict, livePanes } from '../shared/idleHide'
import type { Session } from '../shared/types'

const POLL_MS = 15_000

export interface IdleHideDeps {
  win: () => BrowserWindow | null
  localSessions: () => Session[]
  watching: () => number
  log: (line: string) => void
  /** Test copies set a shorter wait; the real app uses `IDLE_HIDE_MS`. */
  waitMs?: number
}

let deps: IdleHideDeps | null = null
let timer: NodeJS.Timeout | null = null
let lastActivity = Date.now()
let lastLive = -1
let hiddenByRule = false
/** The last refusal logged, so the log says why it is NOT hiding once per change, not per poll. */
let lastReason = ''

function tick(): void {
  if (!deps) return
  const w = deps.win()
  if (!w || w.isDestroyed()) return
  const now = Date.now()
  try {
    if (w.isFocused() && powerMonitor.getSystemIdleTime() * 1000 < POLL_MS) lastActivity = now
  } catch {
    // No idle reading: leave the clock alone rather than guess either way.
  }
  const live = livePanes(deps.localSessions())
  const v = idleHideVerdict({
    live,
    watching: deps.watching(),
    // Minimised is still on the taskbar, and Electron reads it as not visible. A hidden
    // minimised window stays isMinimized(), so the rule's own hide is remembered instead.
    visible: !hiddenByRule && (w.isVisible() || w.isMinimized()),
    lastActivity,
    now,
    waitMs: deps.waitMs
  })
  if (!v.hide) {
    if (v.reason !== lastReason) deps.log(`window stays: ${v.reason}`)
    lastReason = v.reason
    return
  }
  lastReason = ''
  hiddenByRule = true
  deps.log(`hid the window: ${v.reason}; the app keeps running for other devices`)
  w.hide()
}

/** Every desk change: a pane ending starts the three minutes, a pane arriving shows the window. */
export function idleHideDeskChanged(): void {
  if (!deps) return
  const live = livePanes(deps.localSessions())
  if (live !== lastLive) lastActivity = Date.now()
  lastLive = live
  const w = deps.win()
  if (!w || w.isDestroyed() || !idleHideReveal(hiddenByRule, live)) return
  hiddenByRule = false
  deps.log(`showed the window again: ${live} pane(s) on this machine`)
  w.showInactive()
}

export function startIdleHide(d: IdleHideDeps): void {
  deps = d
  if (timer) return
  lastActivity = Date.now()
  timer = setInterval(tick, d.waitMs !== undefined ? Math.min(POLL_MS, Math.max(1000, d.waitMs / 4)) : POLL_MS)
  timer.unref?.()
}

/** The window was shown or focused, by a person or by the reveal: the clock starts again. */
export function idleHideShown(): void {
  hiddenByRule = false
  lastActivity = Date.now()
}
