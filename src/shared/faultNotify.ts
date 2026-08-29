// A fault the app recovered from is a fault nobody hears about.
//
// `crash.ts` catches every uncaught exception and rejection in the main process, and
// `renderWatch.ts` kills and reloads a wedged renderer, and BOTH of them are designed to
// keep the app up and quiet - which is right, and which means the entire record is a line
// in `paneforge-errors.log`, a file nobody opens until something has already gone wrong
// twice. The window's toast is worse than nothing here: the two faults worth hearing about
// (a wedged renderer, a crash on a machine driven over the link) are exactly the ones with
// nobody in front of the screen.
//
// So the same fault also leaves the machine, down the one channel this app already has to
// a phone (`askNotify.ts`, one HTTPS POST, no long poll). This file is the whole decision;
// `main/faultNotify.ts` is the plumbing.
//
// EVERY RULE HERE IS A REFUSAL, because the expensive failure is not a missed fault - the
// log still has it - but a phone buzzing forty times while a loop throws every frame.

/** What `crash.ts` and `renderWatch.ts` pass to `logProblem`/`write`. */
export interface Fault {
  kind: string
  detail: string
}

export interface FaultState {
  /** signature -> when it was last sent. */
  sent: Record<string, number>
  count: number
}

/** A repeat of the same fault is one message, not one per occurrence. */
export const QUIET_MS = 30 * 60 * 1000

/**
 * The whole run's budget. A main process that throws in a timer throws for ever, and five
 * is enough to say "this is happening" - the log is the record, this is the alarm.
 */
export const MAX_PER_RUN = 5

/**
 * A renderer line that is an ACT, rather than the reading that led to it.
 *
 * `renderWatch` writes eight or nine lines around one recovery - the cpu time, the
 * unresponsive event, the probe going unanswered, the act, then "answering again". Only
 * the act is news; the rest is the evidence, and the evidence lives in the log.
 */
const RENDERER_ACTS = /^(reload|recreate|still wedged)/

/** The crash-guard drill names itself so a test copy cannot page anybody. */
const DRILL = /SMOKE TEST \(not a real fault\)/

export function worthSending(f: Fault): boolean {
  if (DRILL.test(f.detail)) return false
  if (f.kind === 'uncaughtException' || f.kind === 'unhandledRejection') return true
  if (f.kind === 'renderer') return RENDERER_ACTS.test(f.detail.trim())
  return false
}

/**
 * What makes two faults the same one.
 *
 * The first line only, with every number taken out: a stack's line numbers are stable but
 * a wedged renderer's line carries the pid, the cpu time and how long the probe waited, so
 * two reports of ONE recurring wedge never match on the raw text and the quiet window
 * never fires.
 */
export function signature(f: Fault): string {
  const first = f.detail.split('\n')[0].replace(/\d+/g, '#').slice(0, 160)
  return `${f.kind}: ${first}`
}

export interface DecideOpts {
  now: number
  /** This machine's name, so a desk driven over the link says which one. */
  device?: string
  /** '' for the installed app. A `npm run try` copy must never page anybody. */
  profile?: string
}

/**
 * The message, or null. Pure, so `npm run test:faultnotify` is the whole contract.
 *
 * The text leads with the machine and the act because it is read on a lock screen, and it
 * ends by naming the log - the point of the message is to get somebody to the evidence,
 * never to carry the evidence.
 */
export function decide(
  state: FaultState,
  f: Fault,
  opts: DecideOpts
): { state: FaultState; send: string | null } {
  const s: FaultState = { sent: { ...state.sent }, count: state.count ?? 0 }
  if (opts.profile) return { state: s, send: null }
  if (!worthSending(f)) return { state: s, send: null }
  if (s.count >= MAX_PER_RUN) return { state: s, send: null }
  const sig = signature(f)
  const last = s.sent[sig]
  if (last !== undefined && opts.now - last < QUIET_MS) return { state: s, send: null }
  s.sent[sig] = opts.now
  s.count += 1
  return { state: s, send: faultMessage(f, { device: opts.device, last: s.count === MAX_PER_RUN }) }
}

/**
 * Plain text, three short lines. It names the machine first (a desk driven over the link
 * is the case this exists for, and "which one" is the first thing anybody asks), then what
 * the app DID about it - "the window was reloaded" is the difference between a fault worth
 * walking over to and one already handled - then where the evidence is.
 */
export function faultMessage(f: Fault, o: { device?: string; last?: boolean } = {}): string {
  const where = o.device ? `PaneForge on ${o.device}` : 'PaneForge'
  const first = f.detail.split('\n')[0].slice(0, 300)
  const lines = [
    f.kind === 'renderer'
      ? `${where}: the window stopped answering.`
      : `${where} hit a fault it stayed up through.`,
    '',
    `${f.kind}: ${first}`,
    '',
    'The stack is in paneforge-errors.log next to the config.'
  ]
  if (o.last) lines.push(`No more of these this run (${MAX_PER_RUN} sent) - read the log.`)
  return lines.join('\n')
}
