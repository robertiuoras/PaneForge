// One pty, several screens looking at it.
//
// A pane can be drawn by this desk's window, by a phone, and by any number of paired
// devices mirroring it - and every one of those fits its OWN window and says so. The
// original rule (`resize` in main/sessions.ts) is that the desk OWNS the size and everyone
// else BORROWS it, which is right and was only ever written for one borrower: the borrow
// was a boolean and a single set of numbers, so the second viewer overwrote the first.
//
// Two viewers with different windows therefore trade the pty back and forth for as long as
// both are open, and a full-screen CLI redraws its whole frame every round - which is what
// "the remote window keeps changing sizes" is. Measured 2026-08-23 with the same PC pane
// mirrored into two Mac windows: the pty flipped between their two grids indefinitely.
//
// The answer is not to pick a winner - a viewer whose window is smaller than the grid it
// is sent draws a screen cut off at the edge, which is the older bug in `mirrorFit.ts`.
// It is to lend every borrower a grid they can ALL draw: the smallest one asked for. The
// others get slack, which is the one failure here nobody notices, and the number is stable
// because it does not depend on who spoke last.
/** A grid, with no claim about who asked for it. */
export interface Grid {
  cols: number
  rows: number
}

export interface Borrow extends Grid {
  /**
   * When this screen last said it was still looking.
   *
   * A borrow ends when the borrower says so - and a phone in a pocket never says so. Its
   * screen locks, iOS suspends the tab, and the SSE stream stays nominally open behind a
   * tunnel, so nothing on the desk ever hears "I have looked away": measured 2026-08-25 on
   * this machine's own pane s24-mt81jexv, sitting at 72x33 with `borrowed: true` while the
   * three panes beside it in the same window were 159x57 and a person was at the desk.
   *
   * So a borrow is a LEASE, not a flag. Every screen already re-states which panes it has
   * on screen every `VISIBILITY_REFRESH_MS` (30s, App.tsx) - the same tick that expires a
   * dataPump claim - and that tick renews this stamp. A screen that stops ticking loses
   * its borrow on its own, which is the only reading that survives a phone that vanishes.
   *
   * **0 means no lease at all.** A screen on the far side of the device link has no tick
   * of ours to renew with - a mirrored pane only re-states its size when it repaints, and
   * an idle one is silent for hours - so its borrow ends with the CONNECTION (the link
   * drops, `returnSizeOn` runs) and must never end on a clock. Expiring those would snap
   * the pty back under somebody who is still reading it, which is the older bug in
   * `mirrorFit.ts` arriving by a new door.
   */
  at: number
  /**
   * Whether a PERSON is at the screen holding this borrow.
   *
   * A borrow is what a headless desk reads as "somebody is looking at this pane"
   * (`ReclaimPane.watched`), and a mirror's borrow never expires - it ends with the
   * connection, not on a clock (`at: 0` above). Put together, one glance at a PC pane from
   * the Mac took that pane off the idle clock for as long as the link was up: measured
   * 2026-09-04, three panes idle on the PC with `idleCloseMinutes: 5` and no close, no
   * countdown, and nothing in `reclaim.log` since 03:23.
   *
   * So the borrowing screen says whether anybody is there (`away.ts`'s `sawPerson`), and a
   * mirror on a desk nobody is sitting at stops holding the pane open. Absent means YES: a
   * phone, an older build and a screen that does not say are all "somebody is looking",
   * which is what shipped before this and the safe direction to be wrong in.
   */
  person?: boolean
}

/** Is any screen holding this pane with a person at it - the "somebody is looking" reading. */
export function watchedBorrow(borrows: Iterable<Borrow>): boolean {
  for (const b of borrows) if (b.person !== false) return true
  return false
}

/**
 * How long a borrow outlives the last tick from the screen holding it.
 *
 * Three ticks: two may be lost to a phone's flaky stream without the pane snapping back
 * under somebody who is still reading it.
 */
export const BORROW_TTL_MS = 90_000

/**
 * Drop every borrow whose lease has run out. True when the map changed.
 *
 * Separated from `smallestBorrow` so the caller can tell "the numbers moved" from
 * "somebody let go", and so the expiry is one line a test can hold still.
 */
export function dropStale(
  borrows: Map<string, Borrow>,
  now: number,
  ttl: number = BORROW_TTL_MS
): boolean {
  let dropped = false
  for (const [who, b] of borrows) {
    if (b.at === 0) continue
    if (now - b.at > ttl) {
      borrows.delete(who)
      dropped = true
    }
  }
  return dropped
}

/**
 * The one grid every borrower can draw, or null when nobody is borrowing.
 *
 * Each axis is taken separately on purpose: a tall narrow phone and a short wide mirror
 * have no single window between them, and cols and rows are independent constraints -
 * pairing them would hand somebody a grid wider than their screen to keep an aspect.
 */
export function smallestBorrow(borrows: Iterable<Borrow>): Grid | null {
  let cols = Infinity
  let rows = Infinity
  for (const b of borrows) {
    if (b.cols > 0) cols = Math.min(cols, b.cols)
    if (b.rows > 0) rows = Math.min(rows, b.rows)
  }
  return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : null
}
