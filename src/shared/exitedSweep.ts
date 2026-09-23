/**
 * A FINISHED PANE LEAVES THE SIDEBAR BY ITSELF, TEN MINUTES LATER.
 *
 * `shared/exitClose.ts` already closes most dead panes within `LINGER_MS` (6s) of their
 * process ending. The one case it deliberately leaves alone is a process that never
 * printed a byte (`exitPlan`'s `!r.printed` refusal, "it never started") - the card is
 * the only evidence a broken agent left behind, so closing it on the spot would hide the
 * failure. Evidence (chat 13, 2026-09-23): five panes (s15 s17 s21 s23 s43) sat wearing
 * `exited` until somebody closed them by hand.
 *
 * This is the second, slower net: any LOCAL pane still showing `exited` ten minutes after
 * it died is removed the same way a person closes it - `kill()`, which keeps History,
 * `resumeId` and `scrollbackId` exactly as a manual close does. `Open again` still brings
 * the same conversation back.
 *
 * The trap this exists to avoid: a SLEEPING pane also wears `status: 'exited'` on purpose
 * (`sleep()` in `main/sessions.ts`) - the app puts idle panes to sleep to save resources,
 * the card is kept deliberately, and a click wakes it. `meta.asleep` is the one field that
 * tells a pane the app put down on purpose from one whose process ended on its own, so the
 * whole rule keys on "asleep is not set", never on `status` alone.
 */

/** How long a dead pane sits before it is swept off the sidebar. */
export const EXITED_REMOVE_MS = 10 * 60_000

/** How often the sweep looks. Matches the other 30s-ish sweeps in this app. */
export const SWEEP_MS = 30_000

/** The one fact about each pane the sweep needs, read off `Session` / `SessionMeta`. */
export interface ExitedFact {
  id: string
  /** Only a LOCAL pane can be removed here - a listed/mirrored remote pane is not ours to kill. */
  remote?: boolean
  status: 'exited' | string
  /**
   * Set the app itself put this pane down on purpose (`sleep()`), never a process that
   * ended on its own. THE field that tells the two apart - see the module comment.
   */
  asleep?: number | boolean
  /** Epoch ms this pane's process actually ended. Undefined = never died, or not yet stamped. */
  exitedAt?: number
  /** An unanswered question on screen - the card is evidence of that, not just of exit. */
  ask?: unknown
  /** Mid-handoff to another machine - its card is the receipt for the move in progress. */
  handingOff?: boolean
  /** Epoch ms of the most recent keystroke/click into this pane. */
  lastKeyboard?: number
}

export interface ExitedRemoval {
  id: string
  reason: string
}

/**
 * A pane's process ended on its own, and nothing about it is still worth keeping the
 * card open for - shared by the automatic ten-minute sweep and the "Clear finished"
 * button, which differ only in how long they are willing to wait.
 */
function isFinished(p: ExitedFact): boolean {
  if (p.remote) return false
  if (p.status !== 'exited') return false
  // The one guard the whole feature exists to get right: an app-slept pane also reads
  // `exited`, and must never be swept or counted as finished.
  if (p.asleep) return false
  if (p.ask) return false
  if (p.handingOff) return false
  if (!p.exitedAt) return false
  // Touched (typed into, clicked) after it died holds the clock, the same way
  // `closeAfterResult` refuses a pane with newer user input than the moment it judged.
  if (p.lastKeyboard && p.lastKeyboard > p.exitedAt) return false
  return true
}

/**
 * Which finished panes are old enough for the automatic sweep to remove, given the facts
 * above and the current time. Pure arithmetic over readings the caller took - nothing
 * here touches a process or a file, so `npm run test:exitedsweep` can prove every
 * refusal without a pty.
 */
export function exitedSweep(panes: ExitedFact[], now: number): ExitedRemoval[] {
  const out: ExitedRemoval[] = []
  for (const p of panes) {
    if (!isFinished(p)) continue
    // A restart or wake resets `exitedAt` (see `main/sessions.ts`), so a pane brought
    // back to life and killed again a moment later starts a fresh ten minutes rather than
    // inheriting a clock from before it was ever touched.
    if (now - p.exitedAt! < EXITED_REMOVE_MS) continue
    out.push({ id: p.id, reason: `finished ${Math.round((now - p.exitedAt!) / 60_000)} min ago, nobody touched it` })
  }
  return out
}

/**
 * Every finished pane, regardless of how long it has been dead - what the "Clear
 * finished" button removes on a press. Same refusals as the automatic sweep (asleep,
 * remote, a question on screen, mid-handoff, touched since it died); only the age wait
 * is skipped, because a person pressing the button IS the ten minutes' worth of "nobody
 * is going to do anything more with this".
 */
export function clearFinishedNow(panes: ExitedFact[]): ExitedRemoval[] {
  return panes.filter(isFinished).map((p) => ({ id: p.id, reason: 'cleared by hand' }))
}

/** How many panes "Clear finished" would remove right now - what its label counts. */
export function finishedCount(panes: ExitedFact[]): number {
  return clearFinishedNow(panes).length
}
