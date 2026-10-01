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
  /** An unsent prompt is work, even when no turn ever started. */
  drafting?: boolean
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
  /** The app is still delivering a queued prompt (`Session.owedPrompt`). */
  owedPrompt?: boolean
  /** A queued prompt was given up as not sent (`Session.unsentPrompt`). */
  unsentPrompt?: unknown
  /** When a prompt was last queued for this pane (`queuePrompt`); none = never. */
  promptQueuedAt?: number
  /** When a prompt was last PROVEN submitted: a queued one settled `sent`, or a person sent a line. */
  promptSentAt?: number
}

/**
 * Did this pane's prompt never go in? s44-mud42wl9 (Mac, 2026-09-22 20:13Z, load ~470):
 * opened with `--close-when-done`, its opening prompt was logged `queued prompt LOST` and
 * left in the composer, and the pane was then closed and reported DONE. A pane that never
 * received its job has not finished it.
 */
function promptNeverSent(p: DonePane): boolean {
  return Boolean(p.unsentPrompt) || (p.promptQueuedAt ?? 0) > (p.promptSentAt ?? 0)
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
  return closeVerdict(p, quietMs, now) === 'close'
}

/**
 * `close` - finished, close it. `wait` - something is still going on. `unsent` - quiet and
 * otherwise finished, but its prompt never went in: the pane stays OPEN and the opener is
 * told the prompt was never sent, never that the job is done.
 */
export function closeVerdict(p: DonePane, quietMs: number, now = Date.now()): 'close' | 'wait' | 'unsent' {
  if (!p.printed) return 'wait'
  if (p.status === 'exited' || p.asleep) return 'wait'
  if (p.runSince || (p.busyUntil ?? 0) > now) return 'wait'
  if (p.ask || p.drafting || p.job || p.backJob) return 'wait'
  if (quietMs < CLOSE_DONE_QUIET_MS) return 'wait'
  if (p.owedPrompt) return 'wait'
  return promptNeverSent(p) ? 'unsent' : 'close'
}
