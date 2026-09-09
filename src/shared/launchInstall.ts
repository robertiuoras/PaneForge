// A build that was downloaded, staged, and then sat there for a day.
//
// updater.log, this Mac: 0.8.207 reached `state ready` at 2026-09-08T02:28:31Z. The app
// was relaunched at 2026-09-09T02:30:34Z and came up as `launch v0.8.206`, with
// `mac update already staged from an earlier run 0.8.208` on the next line - so the
// restart that could have applied 0.8.207 applied nothing, 0.8.207 was thrown away
// superseded, and the machine spent nearly 24 hours two versions behind with the fix
// sitting on its own disk the whole time.
//
// The staged bundle is only ever moved in on the way OUT (`installStagedMacUpdateOnQuit`),
// and a process that is killed, crashes, or is taken down by a logout never runs that. So
// the one moment a staged build is guaranteed to be installable - a fresh process, no
// window drawn, no pane restored, nothing anybody would lose - was the one moment nothing
// looked at it.
//
// This is the decision, with no electron in it. Every answer other than 'go' leaves the
// app exactly as it was: the restart card is still there and the user can still press it.

export type LaunchVerdict =
  | 'go'
  | 'nothing is staged'
  | 'the staged build is not newer'
  | 'a window is already open'
  | 'it has already failed twice'
  | 'this copy cannot be replaced'

/**
 * How many launch installs of the SAME version may fail before the app stops trying.
 *
 * Two, matching the existing install-attempt rule: an install that does not take leaves
 * the app running the old version, so a third automatic go at it is a relaunch loop and
 * the card is back anyway for the user to press.
 */
export const MAX_TRIES = 2

export interface LaunchState {
  /** Version expanded on disk by an earlier run, '' when there is none. */
  staged: string
  /** Is it newer than the version this process is? */
  newer: boolean
  /** Windows already on screen. A launch install is only safe while this is zero. */
  windows: number
  /** Attempts already made at THIS version, from install-attempt.json. */
  tries: number
  /** Is the bundle in a place this process may replace (see macUpdate.canSwap)? */
  canSwap: boolean
}

export function applyAtLaunch(s: LaunchState): LaunchVerdict {
  if (!s.staged) return 'nothing is staged'
  if (!s.newer) return 'the staged build is not newer'
  // The whole safety of this is that nothing exists yet. Once a window is up, a pane may
  // be restoring or an agent may already be mid-turn, and the way out is the quit path
  // that has always handled it.
  if (s.windows > 0) return 'a window is already open'
  if (s.tries >= MAX_TRIES) return 'it has already failed twice'
  if (!s.canSwap) return 'this copy cannot be replaced'
  return 'go'
}
