// Which of a pane's two widths moves first.
//
// A pane has two widths that must agree: the xterm grid on screen, and the pty the agent
// is writing into. The renderer changed the first and then told main about the second
// (`refit` then `api.resize` in TerminalPane), so between them the terminal was already at
// the new size while the CLI was still painting at the old one. That gap is one IPC hop,
// which is nothing at rest and is guaranteed to catch output during a streaming turn.
//
// The two directions are NOT symmetrical, and that is the whole fix:
//
//   - Painting NARROWER than the terminal is cosmetic. Short lines, and the next repaint
//     at the right width covers them. Nothing is lost.
//   - Painting WIDER than the terminal is destructive. Everything an agent CLI prints is
//     absolute column moves (`\x1b[155G`) and a terminal CLAMPS a column it cannot reach,
//     so every line lands on the right-hand edge, one word over the last. xterm can unwrap
//     a row it wrapped itself; it can never undo a clamp, and by the time anyone sees it
//     the rows have scrolled into the SCROLLBACK, where no repaint reaches. See the same
//     mechanism written up in `shared/handoff.ts` and commit 4b73e71, which fixed it for
//     the moment a pane OPENS. This is the same bug at every resize after that.
//
// So: on a GROW the terminal may go first (it is briefly wider than the paint, which is
// harmless). On a SHRINK the pty must go first, and the terminal waits for the grid to
// come back before it follows.
//
// Measured 2026-08-25 on this machine's own pane log (`s24-mt81jexv`): the CLI painted
// absolute column moves to 155-157 in every 100KB slice of the session, and replaying the
// torn reply through a headless terminal is clean at 157 and tears at 150 and below.

export interface Grid {
  cols: number
  rows: number
}

export type ResizeStep =
  /** nothing to do - the terminal already has the shape the window has room for */
  | { do: 'none' }
  /** growing, or a shrink the pty has already granted: fit the terminal now */
  | { do: 'fit' }
  /** shrinking: ask the pty for this grid and leave the terminal where it is */
  | { do: 'ask'; cols: number; rows: number }
  /** a shrink is asked for and not granted yet: the terminal must not follow */
  | { do: 'wait' }

/**
 * How long a granted shrink may take before the terminal follows anyway.
 *
 * A refusal is a real state, not a theory: `resize` in main/sessions.ts deliberately
 * REMEMBERS a desk resize instead of obeying it while a phone is holding the pane. Without
 * a ceiling the terminal would stay wider than its own box for as long as that lasted, so
 * the wait ends and the fit happens - the pane is then torn the way it always was, which
 * is worse than nothing only if the ceiling is too low to cover a normal IPC hop. This is
 * ~100x a local resize round trip.
 */
export const GRANT_GRACE_MS = 1500

/**
 * The next step for one pane, given what its terminal is, what its window has room for,
 * and what the pty is confirmed to be at.
 *
 * Pure so `scripts/shrink-first-test.mjs` can hold the ordering still. `pty` is the grid
 * main has actually applied (it rides on the session as `cols`/`rows`), never the grid we
 * asked for - asking is what got this wrong in the first place.
 */
export function nextResize(i: {
  /** the grid the terminal is at right now */
  have: Grid
  /** what this window has room for, or null when it cannot be measured */
  want: Grid | null
  /** the grid the pty is CONFIRMED to be at, or null when nothing has said */
  pty: Grid | null
  /** the shrink already asked for, or null when none is outstanding */
  asked: Grid | null
  /** how long that ask has been outstanding */
  waitedMs: number
  graceMs?: number
}): ResizeStep {
  const grace = i.graceMs ?? GRANT_GRACE_MS
  // An outstanding ask is answered before anything else is considered: the window may
  // well have moved again since, and re-measuring is what `fit` does anyway.
  if (i.asked) {
    if (i.pty && i.pty.cols <= i.asked.cols && i.pty.rows <= i.asked.rows) return { do: 'fit' }
    if (i.waitedMs >= grace) return { do: 'fit' }
    return { do: 'wait' }
  }
  const w = i.want
  if (!w || !(w.cols > 0) || !(w.rows > 0)) return { do: 'none' }
  // The terminal already fits its box - but the pty may not be at that grid. A shrink ask
  // whose box grew back before the grant lands here: the terminal never moved, so the fit
  // that follows changes nothing and nothing re-tells the pty. See `ptyOwed` below.
  if (w.cols === i.have.cols && w.rows === i.have.rows) return ptyOwed(i.have, i.pty) ? { do: 'fit' } : { do: 'none' }
  // Only COLUMNS decide the direction. Rows cannot clamp a column move, and taking rows
  // away is what a phone keyboard does on every tap - making that wait would move the
  // screen under somebody who is typing.
  if (w.cols < i.have.cols) return { do: 'ask', cols: w.cols, rows: w.rows }
  return { do: 'fit' }
}

/** main/sessions.ts `resize` floors every grid at these, so a terminal under them still matches. */
const MIN_COLS = 20
const MIN_ROWS = 5

/**
 * Whether the pty is owed this terminal's grid - it is confirmed at some OTHER shape.
 *
 * The renderer used to tell the pty only when the TERMINAL changed shape. That misses the
 * one move where it does not: a shrink asks the pty first and leaves the terminal alone
 * (`nextResize` 'ask'), and when the box grows back before the grant - a layout flashing a
 * tile small for a frame - the fit that follows finds the terminal already right, reports
 * nothing, and the pty stays at the transient grid for good. Measured 2026-09-23 on the
 * live desk: s15-mudr1l7h's pty at 29x16 with `borrowed: false` under a 130x55 terminal,
 * `sinceResizeMs: null` in fix.log (the terminal never changed shape), and Claude Code's
 * frame wrapped at 29 columns across the whole pane until the app was touched.
 *
 * `pty` null is "nobody has said", which owes nothing: a mirror, or a pane not yet listed.
 */
export function ptyOwed(have: Grid, pty: Grid | null): boolean {
  if (!pty || !(pty.cols > 0) || !(pty.rows > 0)) return false
  return pty.cols !== Math.max(have.cols, MIN_COLS) || pty.rows !== Math.max(have.rows, MIN_ROWS)
}
