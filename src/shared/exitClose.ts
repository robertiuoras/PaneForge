/**
 * A PANE WHOSE PROGRAM HAS GONE CLOSES ITSELF.
 *
 * When an agent CLI or a shell ends, the card used to stay on the desk wearing `exited`
 * and, if the process had failed, a number. Nobody could tell WHY it said that, and a
 * mirrored row from the other machine saying it was worse - the process it is talking
 * about is not even on this desk (Robert 2026-09-04: "i also dont want to see a session
 * like exited especially a remote one its too confusing why exited ... id rather it closed
 * instead of showing that").
 *
 * Nothing is lost by closing it. `recordEnd` has already written the History row with the
 * conversation id on it, so `Open again` brings the same chat back - which is the whole
 * point of letting it go.
 *
 * The refusals are the interesting half, and all of them are "this is not a program that
 * ended":
 *
 *  - a pane put to SLEEP killed its own process on purpose and says `asleep` (`sleep()`),
 *  - a pane being MOVED to the other machine is mid-handoff and its card is the receipt,
 *  - the whole app QUITTING kills every pty, and closing panes on the way out would write
 *    an empty desk over the one that should come back,
 *  - a pane that FAILED TO START never ran: closing it would make a broken agent look like
 *    nothing happened at all, which is the one case where the card is the only evidence.
 *    That is a pane that printed nothing, and one that failed while still `starting`.
 */

/** The card holds its last screen for this long, so the final lines can be read. */
export const LINGER_MS = 6000

export interface ExitReading {
  /** The app put this pane to sleep - it killed the process itself. */
  asleep?: boolean
  /** This pane is being moved to another machine. */
  handingOff?: boolean
  /** The whole app is going away. */
  quitting?: boolean
  /** Did this process ever print a byte? `false` means it never started. */
  printed?: boolean
  /** Exit code, when there is one. */
  exitCode?: number | null
  /** Was the pane still `starting` - never once idle or working - when it ended? */
  starting?: boolean
  /** A person kept it open (the card's Keep open): its last screen is what they kept. */
  kept?: boolean
}

export interface ExitPlan {
  /** Close the pane. */
  close: boolean
  /** How long to wait first - the card holds its last output briefly. */
  after: number
  /** Why, in this app's own words, for the log and the activity list. */
  why: string
  /** The agent never got going: the card stays and says so (`Session.startFailed`). */
  failedStart?: boolean
}

export function exitPlan(r: ExitReading): ExitPlan {
  if (r.asleep) return { close: false, after: 0, why: 'asleep' }
  if (r.handingOff) return { close: false, after: 0, why: 'moving to the other machine' }
  if (r.quitting) return { close: false, after: 0, why: 'the app is closing' }
  if (r.kept) return { close: false, after: 0, why: 'kept open by hand' }
  // A pane that never printed anything did not run. The card is the only place that says
  // so, and an agent that cannot start is exactly what somebody needs to see.
  if (!r.printed) return { close: false, after: 0, why: 'it never started', failedStart: true }
  const failed = typeof r.exitCode === 'number' && r.exitCode !== 0
  // The same failure with a screen to read: a CLI that printed and then died before it was
  // ever ready. Claude answering its own folder-trust question with the preselected
  // "No, exit" is the measured one (exit 1 within seconds, 2026-09-12 s27/s28), and closing
  // it six seconds later made a broken start look like nothing happened. A clean exit
  // during start (`/exit` typed early) is not a failure and still closes.
  if (failed && r.starting)
    return { close: false, after: 0, why: `it stopped before it was ready (code ${r.exitCode})`, failedStart: true }
  return {
    close: true,
    after: LINGER_MS,
    why: failed ? `it stopped on its own (code ${r.exitCode})` : 'it finished'
  }
}

/** The sentence the activity list carries, so a card that vanished is not a mystery. */
export function exitWords(place: string, plan: ExitPlan): string {
  return `${place} closed - ${plan.why}`
}
