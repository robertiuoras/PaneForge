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
  /** A process closing it would stop is listening on a port (`shared/serving.ts`). */
  serving?: string
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
  // Mid-turn by status alone, with no turn clock to read (log review 2026-10-01).
  if (p.status === 'working') return false
  if (p.runSince || (p.busyUntil ?? 0) > now) return false
  if (p.ask || p.drafting || p.job || p.backJob || p.serving) return false
  return quietMs >= CLOSE_DONE_QUIET_MS
}

/**
 * Who closed a pane, on the `close-request` line and for the one refusal below: a person
 * (the window, the phone, a paired machine), a command somebody named the pane in (`pf
 * close`, `pf move`, a hand-off), or one of the app's own clocks and sweeps. `unnamed` is
 * a caller from outside that said nothing.
 */
export type CloseBy =
  | 'user'
  | 'phone'
  | 'remote'
  | 'pf'
  | 'handoff'
  | 'review'
  | 'close-when-done'
  | 'idle-clock'
  | 'exited-sweep'
  | 'exit-close'
  | 'cwd-gone'
  | 'tidy-dupes'
  | 'unnamed'

const NAMED_BY_SOMEBODY = new Set<CloseBy>(['user', 'phone', 'remote', 'pf', 'handoff'])

/**
 * Why this close may not happen, or undefined when it may. Only a close nobody named the
 * pane in, and only mid-turn. Log review 2026-10-01: s16-munpf9fk (09-30 08:05Z) and
 * s2-munmghtf (08:47Z) closed while `working` and nothing on disk said who. A person's
 * close, or `pf close` run by a chat (a chat moving itself is `working` as it asks), is a
 * decision; a clock's is a guess, and a wrong one loses the turn.
 */
export function closeRefused(by: CloseBy, status: string): string | undefined {
  if (status !== 'working' || NAMED_BY_SOMEBODY.has(by)) return undefined
  return 'it is mid-turn - only a person or a command naming it closes a working pane'
}

/** What each closer means, for History's `closedBecause` when the caller said nothing more. */
const BY_WORDS: Record<CloseBy, string> = {
  user: 'a person closed it in the window',
  phone: 'a person closed it from the phone',
  remote: 'a paired machine closed it',
  pf: 'a `pf close`/`pf move` command named it',
  handoff: 'it was handed off to another pane',
  review: 'its result was recorded in Review and it closed itself',
  'close-when-done': 'it was opened to close when done',
  'idle-clock': 'the idle countdown ran out',
  'exited-sweep': 'its program had exited',
  'exit-close': 'its program exited',
  'cwd-gone': 'its folder no longer exists',
  'tidy-dupes': 'it was a duplicate of another pane',
  unnamed: 'something outside the app closed it without saying who'
}

/** What a close saw, the evidence `closedBecause` names. */
export interface CloseEvidence {
  status: string
  /** When the screen's footer said the turn ended; 0 = it never did, or a turn was running. */
  footerEndedAt: number
  /** The transcript's last entry (`ReplyRead.lastEntry`); unset = not read. */
  lastEntry?: { kind: string; at?: number }
  /** The transcript's turn-end row. */
  transcriptTurnEndedAt?: number
  /** `openTurnOf`'s words when the transcript says the turn is still open. */
  openTurn?: string | null
}

/**
 * One plain-words line saying why a pane closed and what that was judged on, for History's
 * `closedBecause` and the `close-request` line. Robert, 2026-10-03, after s105 closed
 * mid-turn: "better logs in future so we know why it was stopped and what happened".
 */
export function closedBecause(by: CloseBy, why: string | undefined, ev: CloseEvidence): string {
  const iso = (t: number): string => new Date(t).toISOString()
  const seen = [
    `status ${ev.status}`,
    ev.footerEndedAt ? `screen said the turn ended at ${iso(ev.footerEndedAt)}` : 'screen showed no finished turn',
    ev.lastEntry ? `conversation's last entry ${ev.lastEntry.kind}${ev.lastEntry.at ? ` at ${iso(ev.lastEntry.at)}` : ''}` : 'conversation not read',
    ev.transcriptTurnEndedAt ? `turn-end row ${iso(ev.transcriptTurnEndedAt)}` : 'no turn-end row'
  ]
  return `${why || BY_WORDS[by]}. Asked by: ${by}. Seen: ${seen.join(', ')}.${ev.openTurn ? ` INCIDENT: closed with its turn still open - ${ev.openTurn}.` : ''}`
}

/**
 * Who a `sessions:kill` came from. The window's own IPC is a person. Everything else
 * arrives through `callInvoke` (pf and the phone share that door): the window's code in a
 * phone's browser says `user`, `pf` says so, and a caller from outside may not claim one
 * of the app's own names.
 */
export function closeByOf(fromWindow: boolean, said: unknown): CloseBy {
  if (fromWindow) return 'user'
  if (said === 'user') return 'phone'
  if (said === 'pf' || said === 'tidy-dupes') return said
  return 'unnamed'
}
