// When is a watched pane's turn over?
//
// D2 of `docs/agentic-dispatch.md`. A dispatched run is a real pane, and a pane's CLI is
// interactive - it does not exit when the turn ends, and the one thing the supervisor may
// NOT do is read the pane's text to find out (that is `readsBusy()`, and the whole point
// of `shared/agentic.ts` was to stop scraping it). What it may watch is the disk and the
// process: the diff since the lane's base moving, and the pty going away.
//
// So "the turn is over" is an arithmetic answer over three timestamps, and it lives here
// so `npm run test:dispatch` can assert on it without a pane, a pty or a clock.

import type { Diffstat } from './agentic'

/** How often the watcher polls the diff. Slow on purpose: `diffSince` writes an
 * intent-to-add into the lane's index, and the agent is using that index too. */
export const WATCH_POLL_MS = 15_000

/**
 * How long the diff has to sit still before the turn is called done.
 *
 * Counted from the last time the diff CHANGED, and only once it has changed at all - an
 * agent that is still reading the repo has written nothing, and the budget is what bounds
 * that phase. 90s because a coding CLI that has stopped editing for a minute and a half is
 * writing its answer, not its code.
 */
export const WATCH_QUIET_MS = 90_000

export interface WatchClock {
  /** When this attempt started - the prompt was typed, or the retry was. */
  startedAt: number
  /** Hard ceiling for the attempt, from the dispatch plan. */
  budgetMs: number
  /** Last time the diff was seen to change. 0 = it has not changed yet. */
  lastChangeAt: number
  /** The pane's process is gone. */
  exited: boolean
  now: number
  quietMs?: number
}

export type WatchVerdict =
  | { due: false }
  | { due: true; reason: 'exit' | 'quiet' | 'budget' }

/**
 * Is it time to run the gate?
 *
 * `exit` beats everything - a pty that is gone will never write again. `quiet` needs a
 * change first, so a pane still thinking is left alone until `budget` - which fires
 * whether or not anything was written, because the gate is also how a run that changed
 * nothing gets called a failure rather than watched for ever.
 */
export function gateDue(w: WatchClock): WatchVerdict {
  if (w.exited) return { due: true, reason: 'exit' }
  const quiet = w.quietMs ?? WATCH_QUIET_MS
  if (w.lastChangeAt > 0 && w.now - w.lastChangeAt >= quiet) return { due: true, reason: 'quiet' }
  if (w.now - w.startedAt >= w.budgetMs) return { due: true, reason: 'budget' }
  return { due: false }
}

/**
 * One string per distinct diff, so "did it change" is a comparison and not a deep walk.
 * Paths are in it deliberately: a rename keeps the counters and moves a path.
 */
export function diffKey(d: Diffstat): string {
  return `${d.files}:${d.added}:${d.removed}:${d.paths.join(',')}`
}
