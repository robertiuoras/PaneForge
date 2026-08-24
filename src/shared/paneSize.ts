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
export interface Borrow {
  cols: number
  rows: number
}

/**
 * The one grid every borrower can draw, or null when nobody is borrowing.
 *
 * Each axis is taken separately on purpose: a tall narrow phone and a short wide mirror
 * have no single window between them, and cols and rows are independent constraints -
 * pairing them would hand somebody a grid wider than their screen to keep an aspect.
 */
export function smallestBorrow(borrows: Iterable<Borrow>): Borrow | null {
  let cols = Infinity
  let rows = Infinity
  for (const b of borrows) {
    if (b.cols > 0) cols = Math.min(cols, b.cols)
    if (b.rows > 0) rows = Math.min(rows, b.rows)
  }
  return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : null
}
