// A pane automation opened for one job, and when it may close itself.
//
// `pf open <cwd> --prompt "..."` is how a session, a script or a cron job hands a brief to
// a fresh pane. Nobody is sitting in that pane, so when the agent finishes the card stays
// on the desk for ever - reported 2026-08-28: pane 8 (`quitonclose: adopt already-windowless
// apps`) had done its work and sat there. `--close-when-done` is the answer, and every rule
// worth writing down is about WHEN, because the expensive failure is closing a pane with
// work still in it.
//
// Pure: `main/sessions.ts` supplies the readings and does the closing. `npm run test:closedone`.

/** What deciding needs to know about the pane. A subset of what `sessions.ts` holds. */
export interface DonePane {
  /** Has this process printed anything at all? Until it has, it has not started. */
  printed?: number
  /** `exited` covers a sleeping pane too, which is not a finished job. */
  status: string
  asleep?: number
  /** A turn is running. */
  runSince?: number
  /** ...or the pane's own footer still says so, a beat after the last byte. */
  busyUntil?: number
  /** It is sitting on a question - closing would throw the question away unanswered. */
  ask?: unknown
  /** A shell pane's foreground command (`shared/paneJob.ts`). */
  job?: string
  /**
   * What the AGENT left running in the background (`shared/paneBackJobs.ts`).
   *
   * The reason this is not simply "the turn ended": an agent that starts a build with
   * `run_in_background` goes quiet the moment its turn is over, and this reading comes off
   * a process table sampled every four seconds. A pane closing on the turn's own edge
   * would take that build with it.
   */
  backJob?: string
}

/**
 * How long a finished pane must stay finished. Two of the process table's four-second
 * samples plus the sweep's own second, so a background job started in the last breath of a
 * turn has been seen before anything is killed.
 */
export const CLOSE_DONE_QUIET_MS = 8_000

/**
 * May this pane close itself now?
 *
 * `quietMs` is how long since it last printed. Every refusal is something that would be
 * LOST rather than finished, which is the same test `shared/sleep.ts` applies - and the
 * bar is higher here, because a slept pane can be woken and a closed one is a History row.
 */
export function doneEnough(p: DonePane, quietMs: number, now = Date.now()): boolean {
  if (!p.printed) return false
  if (p.status === 'exited' || p.asleep) return false
  if (p.runSince || (p.busyUntil ?? 0) > now) return false
  if (p.ask || p.job || p.backJob) return false
  return quietMs >= CLOSE_DONE_QUIET_MS
}
