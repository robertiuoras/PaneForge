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

import { keptRows, type ScreenReader } from './keepScrollback'

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

/**
 * Claude Code's working line: a spinner glyph, a verb ending in an ellipsis, then its
 * timer in brackets - `✻ Drizzling… (33s · ↓ 2.3k tokens · thinking with xhigh effort)`,
 * `✳ Drizzling… (running Stop hooks… 0/2 · 33s …)`. Live UI redrawn every tick, never
 * history. The line a finished turn leaves (`✻ Cooked for 53s · done 3:31 PM`) has no
 * ellipsis and stays history, and a tool line (`⏺ Bash(…)`) has its bracket first.
 */
export const WORKING = /^\s*\S\s+[^\s(][^(]*…\s*\(/u

/**
 * What a wipe really destroyed, or nothing: the rows the pane files into the scrollback.
 *
 * `before` is the screen when the wipe started and `cursor` the caret's row on it;
 * `after` is every line of the buffer from the row that screen's top was on to the end,
 * read once the output went quiet - so rows the CLI scrolled into the scrollback the
 * ordinary way since the wipe count as kept, not lost.
 *
 * Judged against the screen alone, that was wrong every time a Claude turn kept going
 * after one of its full repaints. Measured 2026-09-27 on pane s19 (143x55, Claude Code
 * 2.1.283): a repaint at 3:31:22pm started the check, a Stop hook made Claude carry on
 * for 20s, and when the output finally paused the finished reply had scrolled up the
 * ordinary way - so the check found none of the screen it remembered, called it lost and
 * printed it back: the frozen `Drizzling… (33s …)` line, both status-line rows and the
 * reply's tail, above the reply they had scrolled off with (fix.log `why: wipe`, 3:31:42pm).
 *
 * And the composer, the hint and status lines under it and the working line above it are
 * never filed: the CLI draws them again on every frame, so a wipe cannot lose them.
 */
export function rowsToFile(before: string[], cursor: number, after: string[]): string[] {
  const reader: ScreenReader = {
    rows: before.length,
    buffer: { active: { baseY: 0, cursorY: cursor, getLine: (y) => ({ translateToString: () => before[y] ?? '' }) } }
  }
  const history = before.slice(0, keptRows(reader)).filter((r) => !WORKING.test(r))
  const was = meaningful(history)
  if (was.length < LOST_ENOUGH) return []
  // Exact rows anywhere since the wipe, and the old substring test on the screen itself:
  // a row the redraw re-wrapped can come back inside a longer one.
  const seen = new Set(meaningful(after))
  const screen = meaningful(after.slice(-before.length)).join('\n')
  const lost = history.filter((r) => {
    const t = r.trim()
    return t.length >= MEANINGFUL && !seen.has(t) && !screen.includes(t)
  })
  return lost.length >= LOST_ENOUGH && lost.length / was.length >= LOST_SHARE ? lost : []
}
