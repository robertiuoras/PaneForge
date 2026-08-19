// Did that repaint LOSE the screen, or redraw it?
//
// A CLI wipes the screen for two quite different reasons and sends the same bytes for
// both. Measured 2026-08-19 over this machine's pane logs, one Claude Code pane emitted
// the wipe shape `ESC[H` + an erase per row **152 times in 8.4 MB**, and the third one
// examined was mid-answer, with "thinking with medium effort" still on screen: an ordinary
// full repaint, which destroys nothing because the same frame is drawn straight back. The
// same bytes are also exactly what `/clear` sends. So a keeper that files the screen the
// moment it sees the shape is right a handful of times a session and wrong dozens, and
// what it costs when it is wrong is a scrollback stuffed with duplicate frames - the very
// thing that makes scrolling up useless, arrived at from the other direction.
//
// Nothing in the bytes tells the two apart. What tells them apart is what the screen looks
// like once the redraw has settled: a repaint puts its own rows back, a clear does not. So
// the pane snapshots the screen when a wipe starts, waits for the output to go quiet, and
// asks this.

/**
 * A row worth comparing.
 *
 * Short enough that a screen of terse lines still has something to compare - a pane
 * holding a list of one-word answers is exactly the screen somebody minds losing - and
 * long enough that a prompt marker, a lone box edge or a spinner is not counted as
 * "the same screen".
 */
const MEANINGFUL = 6

/**
 * How many rows have to be missing before any of it is worth filing.
 *
 * Every redraw differs by a row or two - a spinner, a clock, a token count - and filing
 * those would put a line of noise into the scrollback dozens of times a session.
 */
const LOST_ENOUGH = 3

/**
 * ...and how much of the screen has to be missing, which is the line between a clear and
 * every other reason a CLI wipes.
 *
 * Measured 2026-08-19 by replaying an 8.4 MB pane log through the shipped keeper and a
 * real terminal: 152 wipes, and the ones that were the CLI re-rendering a scrolling diff
 * lost **13, 17 and 15 rows of 39, 39 and 36** - 35-44%, because the frame it drew back is
 * the same view a few lines further on. A `/clear` loses all of it. Filing the middle case
 * looks tempting (those rows really are gone) and is refused on purpose: what is on screen
 * mid-render is a torn frame - half-drawn box edges, a spinner caught between characters -
 * and a scrollback stuffed with those is the reported bug arrived at from the other side.
 */
const LOST_SHARE = 0.8

/** The rows of a screen that are worth comparing at all. */
export function meaningful(screen: string[]): string[] {
  return screen.map((r) => r.trim()).filter((r) => r.length >= MEANINGFUL)
}

/**
 * The rows of `before` that are not on `after` - what the redraw really took.
 *
 * This is the whole answer to "repaint or clear", and it is better than answering that
 * question: a repaint puts every row back and this is empty, a clear puts none back and
 * this is the screen, and the case in between - a CLI re-rendering its view a line or two
 * further on - hands back exactly the lines that fell off the top. Measured over a real
 * 8.4 MB pane log, that middle case is most of them: 152 wipes, of which only a handful
 * are clears. Filing whole screens for those would have put ~7,000 duplicated rows into
 * the scrollback; filing what is missing puts back only what was about to be lost.
 */
export function lostRows(before: string[], after: string[]): string[] {
  const now = meaningful(after).join('\n')
  return before.filter((r) => {
    const t = r.trim()
    return t.length >= MEANINGFUL && !now.includes(t)
  })
}

/**
 * Was the screen `before` a wipe worth keeping any of?
 *
 * `false` for a screen that had nothing on it, and for one the redraw put straight back:
 * there is nothing to keep, and filing it anyway is how a scrollback fills with copies of
 * itself. `LOST_ENOUGH` rather than a single row because a status line, a clock and a
 * token count differ between any two frames and are not history.
 */
export function screenLost(before: string[], after: string[]): boolean {
  const was = meaningful(before)
  if (was.length < LOST_ENOUGH) return false
  const lost = lostRows(before, after).length
  return lost >= LOST_ENOUGH && lost / was.length >= LOST_SHARE
}

/**
 * The bytes that put `rows` into a terminal's scrollback and leave the screen blank.
 *
 * Printed from the top of a blank screen, then one newline per row sent from the bottom
 * row: a newline at the bottom row scrolls, and a scroll is the only thing that puts a
 * line into the scrollback rather than deleting it. Trailing blank rows are dropped -
 * filing them puts a gap in front of the thing being kept - and an empty screen produces
 * no bytes at all.
 */
export function fileRows(rows: string[], height: number): string {
  const keep = rows.slice(0, Math.max(1, height)).map((r) => r.replace(/\s+$/, ''))
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop()
  if (!keep.length) return ''
  return (
    '\x1b[H\x1b[J' +
    keep.join('\r\n') +
    `\x1b[${Math.max(1, height)};1H` +
    '\r\n'.repeat(keep.length) +
    '\x1b[H\x1b[J'
  )
}
