/**
 * DOES THE STEP ACTUALLY SHOW WHAT IT SAYS IT SHOWS?
 *
 * A step's `checks` are node test scripts, and a node script has no window: it can prove
 * the arithmetic behind a change and it cannot see that the ring landed on nothing, or
 * covered the screen, or that the surface never opened. Both faults Robert found by eye
 * on 2026-09-04 - a 618x1050 ring reading as a glowing line down the window, and a pane
 * the tour opened that could not be got rid of - are invisible to every suite in the repo
 * and obvious in one look ("these types of things you must check visually yourself you
 * cant see from code").
 *
 * So the card takes that look itself, in the window it is drawn in. This file is the
 * judgement, over numbers the renderer measures; nothing here touches the DOM, so
 * `scripts/look-check-test.mjs` runs it with no window at all.
 */

import { spotFits } from './tour'

/** What the renderer measured for one step. `null` = nothing on screen matched. */
export interface LookReading {
  /** the ringed control, as the window measures it */
  spot: { width: number; height: number; x: number; y: number } | null
  /** the surface the step said it would open - `null` when the step opens none */
  surfaceOnScreen: boolean | null
  win: { width: number; height: number }
}

export interface LookVerdict {
  ok: boolean
  /** One line, in the words of somebody looking at the screen. */
  says: string
}

/** A control this small is not something a person can be pointed at. */
export const MIN_SPOT = 8

/**
 * The one line the card prints about what it can see.
 *
 * Every failure names the NUMBER that failed, because "the ring is wrong" sends the next
 * person back to the window to measure it again.
 */
export function lookVerdict(step: { spot?: string; open: string }, r: LookReading): LookVerdict {
  if (r.surfaceOnScreen === false)
    return { ok: false, says: 'The screen this step is about did not open.' }
  if (!step.spot) {
    return r.surfaceOnScreen === true
      ? { ok: true, says: 'Looked at it - the screen it names is open.' }
      : { ok: true, says: 'Nothing to look at on this one.' }
  }
  if (!r.spot) return { ok: false, says: 'Nothing on screen matches what this step points at.' }
  const { width, height } = r.spot
  if (width < MIN_SPOT || height < MIN_SPOT)
    return { ok: false, says: `What it points at is ${Math.round(width)}x${Math.round(height)} - too small to see.` }
  if (!spotFits(r.spot, r.win)) {
    const pct = Math.round(((width * height) / (r.win.width * r.win.height)) * 100)
    return { ok: false, says: `The ring covers ${pct}% of the window - that is not pointing at anything.` }
  }
  if (r.spot.x + width < 0 || r.spot.y + height < 0 || r.spot.x > r.win.width || r.spot.y > r.win.height)
    return { ok: false, says: 'What it points at is off the edge of the window.' }
  return { ok: true, says: `Looked at it - the ring is on a ${Math.round(width)}x${Math.round(height)} control.` }
}
