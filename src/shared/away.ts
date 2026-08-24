/**
 * Whether a person is at this machine, and what that does to the idle clock.
 *
 * `reclaim.ts`'s idle clock closes a pane nobody has typed into for `idleCloseMinutes`.
 * That reading is per-pane and it cannot tell the two reasons a pane is quiet apart: an
 * agent that finished hours ago and is never coming back, and an agent that finished a
 * minute before somebody stood up to make coffee. Robert, 2026-08-24: "i wasnt at my
 * laptop for like 10 mins and all tabs closed because i wasnt here to stop it".
 *
 * So the clock runs on the time a person could have acted, not on wall time: while the OS
 * says nobody has touched this machine, it is FROZEN at the moment they left, and it
 * carries on from there when they come back. Ten minutes away costs a pane nothing; ten
 * minutes at the keyboard ignoring it costs it exactly what it did before.
 *
 * The machine this feature was turned on for - a second desk driven over the device link,
 * which fills with finished panes and has no person - keeps today's behaviour, and it does
 * so without a setting to get wrong: `sawPerson` is false there for as long as nobody
 * touches its own keyboard, and with no person ever seen there is nobody to be away.
 *
 * Memory is NOT held hostage by this. Only the clock pauses; `reclaimPlan`, which fires on
 * real pressure, is untouched and still closes finished panes on a machine in trouble. So
 * a laptop left open overnight is protected by the reading that was always the honest
 * trigger, and the clock is left to be what it says it is.
 *
 * Pure: no Electron. `npm run test:reclaim`.
 */

/**
 * How long the OS must report no input before somebody counts as away.
 *
 * A minute, because the cost of being wrong is asymmetric and small in one direction: a
 * pause that starts a few seconds early holds a pane open a little longer, and a pause
 * that starts late is the bug this exists to fix. It also has to be comfortably longer
 * than reading a screen without touching anything, which is seconds, not minutes.
 */
export const AWAY_AFTER_MS = 60_000

export interface Away {
  /**
   * Epoch ms of the last input this machine saw, while nobody is at it. null when
   * somebody is here, and null when nobody has ever been (see `sawPerson`).
   */
  awaySince: number | null
  /**
   * Has a person touched THIS machine at any point since the app started?
   *
   * The whole of the second-desk refusal. A machine driven entirely over the device link
   * never sets this, so it never pauses anything and behaves exactly as it did before.
   * Sticky on purpose: somebody who launched the app and walked away is a person who was
   * here, and the point of the pause is that they are coming back.
   */
  sawPerson: boolean
}

export const NOBODY_YET: Away = { awaySince: null, sawPerson: false }

/**
 * The new reading, from the old one and the OS's own idle time.
 *
 * `idleMs` is how long the machine says it has been since ANY input - not this window's,
 * not this app's. A person working in another app is present and their panes' clocks run,
 * which is right: they can see the countdown chip and press it.
 */
export function readAway(prev: Away, idleMs: number, now: number): Away {
  if (idleMs < AWAY_AFTER_MS) return { awaySince: null, sawPerson: true }
  if (!prev.sawPerson) return prev
  // The moment they left, not the moment we noticed. Recomputed each reading rather than
  // stamped once, so a poll that is late (a sleeping laptop, a busy main process) still
  // freezes the clock where the person actually stopped.
  return { awaySince: now - idleMs, sawPerson: true }
}

/**
 * The clock the idle close is allowed to read: frozen while nobody is here.
 *
 * Never later than `now`, so this can only ever DELAY a close. A pane that was already
 * past its deadline when the person left is due the moment the sweep next runs, exactly as
 * before - the pause holds a pane that was still counting, it does not undo a decision.
 */
export function deskNow(now: number, awaySince: number | null): number {
  if (awaySince === null) return now
  return Math.min(now, awaySince)
}
