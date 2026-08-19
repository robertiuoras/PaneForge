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
 * How much of `before` must survive on `after` for it to have been a repaint.
 *
 * A repaint is not byte-identical - a spinner turns, a clock ticks, a token count moves -
 * so this is deliberately far below "the same". A clear leaves nothing of the old screen
 * at all, so anything in between is a redraw that happened to change a lot, and the
 * cheaper mistake there is to call it a repaint and file nothing: the screen the user is
 * reading is still on screen either way.
 */
const KEPT_ENOUGH = 0.34

/** The rows of a screen that are worth comparing at all. */
export function meaningful(screen: string[]): string[] {
  return screen.map((r) => r.trim()).filter((r) => r.length >= MEANINGFUL)
}

/**
 * Was the screen `before` a wipe destroyed by what was drawn after it?
 *
 * `false` for a screen that had nothing on it: there is nothing to lose, and filing a
 * blank screen would put a screenful of empty rows in front of whatever is above it.
 */
export function screenLost(before: string[], after: string[]): boolean {
  const was = meaningful(before)
  if (!was.length) return false
  const now = meaningful(after).join('\n')
  const kept = was.filter((r) => now.includes(r)).length
  return kept / was.length < KEPT_ENOUGH
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
