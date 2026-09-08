/**
 * What a pane writes to its own terminal in the instant before a woken CLI starts printing.
 *
 * A sleeping pane keeps the screen it fell asleep with - that is the whole point of sleep
 * over close - and `wake()` deliberately writes no terminal reset. But an agent CLI does
 * not draw its startup frame by printing rows: it positions the cursor and paints the
 * cells it owns, leaving every cell it does not own exactly as it found it. Painted over
 * a screen that still holds the old frame, the two texts interleave character by
 * character: `Claude Code v2.1.263` landing in the gaps of the old status row read as
 * `assClaudesCodesv2.1.263ft+tab to cycle)` on Robert's screen (2026-09-08).
 *
 * So the fix is to give the CLI rows nobody else has written on, without deleting
 * anything: SCROLL the old screen up into scrollback and put the cursor at the top of the
 * blank viewport it leaves behind. Scrolling is not erasing - `\x1b[2J` would blank the
 * viewport without pushing those rows anywhere, which is the one thing this must never do
 * (`shared/reclaim.ts` learned the same lesson the hard way: lowering a scrollback limit
 * DELETES). The old screen is still there, one scroll wheel away, which is what "the
 * screen it went to sleep with is the screen it wakes with" was actually asking for.
 */

/** A pane grid smaller than this is a reading nobody took; a pane taller is one nobody has. */
const MIN_ROWS = 8
const MAX_ROWS = 200

/**
 * Push `rows` rows of the pane into scrollback and leave the cursor at the top of the
 * blank viewport. `rows` is the pane's own grid height; an unmeasured pane gets `MIN_ROWS`,
 * which under-scrolls rather than over-scrolls - a few interleaved rows are recoverable by
 * eye, a screen scrolled twice as far as it needed is a wall of blank.
 */
export function wakeBytes(rows: number | undefined): string {
  const n = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Number.isFinite(rows) ? Math.floor(rows as number) : 0))
  // `\x1b[0m` first for the same reason the sleep caption resets: the pane was cut
  // mid-frame and whatever colour it was left in would otherwise paint the blank rows.
  return `\x1b[0m\r${'\n'.repeat(n)}\x1b[H`
}

export { MIN_ROWS, MAX_ROWS }
