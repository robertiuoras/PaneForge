// A pane that says it is working, on a frame that has stopped moving.
//
// The busy read is taken off the bottom of the pane's own screen (`shared/busy.ts`),
// which is right until the screen itself goes wrong. A CLI that is torn mid-paint - a
// resize the app half-missed, a replay drawn at somebody else's width - can leave its
// working line sitting on a row nothing ever overwrites, and from then on every read of
// that pane says the agent is running. The card reads Running, the turn clock counts,
// the idle sweep never touches it, and the only way out was for somebody to notice and
// press Fix. Reported 2026-08-30: "pane 7 was broken for a long time, showed still
// running, when I pressed fix it fixed".
//
// Fix is `sessions.redraw` - a SIGWINCH nudge, no keystrokes - so the recovery is
// something the pane can do for itself. What it needs is a way to tell a stuck frame
// from a slow one, and the pane's OWN SILENCE is not it: a pane that stops printing
// entirely already recovers, because `busyUntil` in main is a three-minute deadline the
// renderer has to keep renewing. A pane still claiming to be busy an hour later is
// therefore one that is still being asked - output keeps arriving, and every read finds
// the same stale evidence. So the reading is that evidence not CHANGING:
//
//   - a live footer moves every second. Claude Code prints "(8s · ↓ 282 tokens)" and
//     Codex "Esc to interrupt · 12s"; both tick, and the spinner glyph cycles under
//     them. `busyEvidence` returns the matched line, so the signature moves with it.
//   - a stale one is byte-identical for as long as it is left there.
//
// The threshold is generous for one reason: the expensive mistake is not a late repair
// but a needless poke at a working agent, since a full-screen CLI redraws its whole
// frame on SIGWINCH. Four minutes of an unchanged working line, at most twice, and only
// while `autoFixUi` is on - the same switch that means "do not poke a CLI on my behalf"
// for the restore repair.
//
// `npm run test:staleframe`.

import type { BusyEvidence } from './busy'

/** How long the same busy evidence must sit unchanged before the frame is suspect. */
export const STALE_AFTER_MS = 240_000

/** Never nudge one pane faster than this, whatever the reads say. */
export const NUDGE_EVERY_MS = 60_000

/**
 * How many repaints one stretch of unchanged evidence is worth.
 *
 * A CLI that redraws the same frame back is not torn - it believes what it is showing -
 * and a watchdog that keeps asking turns one stuck pane into a pane being poked for
 * ever. The count resets when the evidence finally changes, which is what "this stretch"
 * means.
 */
export const MAX_NUDGES = 2

export interface StaleInput {
  /** the frame reads as a running agent right now */
  busy: boolean
  /** how long the busy evidence has been byte-identical */
  unchangedMs: number
  /** repaints already asked for over THIS stretch of unchanged evidence */
  tries: number
  /** since the last repaint this pane asked for; Infinity when it never has */
  sinceNudge: number
  /** `autoFixUi` - the user's "do not poke a CLI on my behalf" */
  allowed: boolean
}

/** Should this pane ask its CLI to repaint? */
export function dueForRepaint(i: StaleInput): boolean {
  if (!i.busy || !i.allowed) return false
  if (i.tries >= MAX_NUDGES) return false
  if (i.unchangedMs < STALE_AFTER_MS) return false
  return i.sinceNudge >= NUDGE_EVERY_MS
}

/**
 * What "the same frame" means, and why it is the evidence rather than the screen.
 *
 * Signing the whole read window would be reset by anything else printing into it - a
 * statusline ticking over, a tool line scrolling past - which is exactly the pane that
 * needs this most: the stale line is stranded ABOVE traffic that is still moving. So the
 * signature is the one line that made the pane read busy, plus which rule matched it.
 */
export function staleSignature(ev: BusyEvidence | null): string {
  return ev ? `${ev.reason}|${ev.line.trim()}` : ''
}
