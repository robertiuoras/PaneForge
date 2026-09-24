// Putting the WINDOW away when this PC's desk is empty, and keeping the app running.
//
// Robert, 2026-09-25: "when all sessions on this pc specifically are finished then
// paneforge itself closes too ... after 3 mins of inactivity ... any backend thing running
// keep it open so mac can create sessions here if needed but visually paneforge can close
// unless activity using the visual one/mac connected to pc."
//
// So this is not `idlequit.ts`. That one quits the process, which would take the listener
// the Mac starts panes through with it, and it refuses on an empty desk - the exact desk
// this is for. Here the window is hidden (off screen, off the taskbar) and nothing else
// changes: the remote host, the pty manager and the renderer all keep running, and the
// next pane on this machine - typed here or started from the Mac - brings the window back
// without taking the keyboard.
//
// Refusals, each one a reason in the log line:
//   - a pane on this machine is still alive (running, waiting, or asleep and being kept)
//   - another device is watching this screen, or this desk is watching another's
//   - somebody used the window in the last three minutes
//
// Pure: no Electron, `now` is passed in. `npm run test:idlehide`.

import type { Session } from './types'

/** How long an empty desk nobody is using stays on screen. */
export const IDLE_HIDE_MS = 3 * 60_000

/**
 * The panes that keep the window up: every local pane except one whose run has ENDED.
 * A sleeping pane also reads `status: 'exited'`, but it is a pane somebody is keeping
 * (`Session.asleep`), so it counts.
 */
export function livePanes(sessions: Pick<Session, 'status' | 'asleep'>[]): number {
  return sessions.filter((s) => s.status !== 'exited' || !!s.asleep).length
}

export interface IdleHideInput {
  /** `livePanes()` of this machine's own panes - never the mirrored ones. */
  live: number
  /** Screen views either way: another device watching this one, or this one watching. */
  watching: number
  /** The window is on screen now (a minimised one still counts: it is on the taskbar). */
  visible: boolean
  /** Epoch ms of the last sign of somebody using the window, or of the desk changing. */
  lastActivity: number
  now: number
  /** `IDLE_HIDE_MS` unless a test copy asked for a shorter wait. */
  waitMs?: number
}

export interface IdleHideVerdict {
  hide: boolean
  reason: string
}

export function idleHideVerdict(i: IdleHideInput): IdleHideVerdict {
  if (!i.visible) return { hide: false, reason: 'already hidden' }
  if (i.live > 0) return { hide: false, reason: `${i.live} pane(s) still open` }
  if (i.watching > 0) return { hide: false, reason: 'a screen is being watched' }
  const quiet = i.now - i.lastActivity
  if (quiet < (i.waitMs ?? IDLE_HIDE_MS)) return { hide: false, reason: 'used too recently' }
  return { hide: true, reason: `no panes and nobody using it for ${Math.round(quiet / 60_000)} min` }
}

/** A window this rule hid comes back the moment this machine has a pane again. */
export function idleHideReveal(hiddenByRule: boolean, live: number): boolean {
  return hiddenByRule && live > 0
}
