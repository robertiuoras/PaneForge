// A cursor-up that asks for more rows than the screen has above the cursor.
//
// Claude Code paints a frame as a DIFF against the frame it believes is on screen: it
// moves to a row, writes the cells that changed, and skips the rest with `CSI n G`. A
// space is never written - a gap between two words is a cursor jump, on the promise that
// the cell is already blank. That promise only holds while its idea of the screen is the
// screen.
//
// Measured 2026-09-25 on pane s129 (130x55, Claude Code 2.1.281), where a line copied out
// of the pane had stray letters in its word gaps: the whole log replayed through a plain
// headless xterm at a FIXED 130x55 shows the same letters - so no resize, no reflow, no
// replay is involved. The one inconsistency in 1.1 MB of output is a single cursor-up:
//
//   frame shrinks by a line at the bottom of a full screen:  ESC[2K ESC[G ESC[1A ESC[K
//   ...                                        next repaint:  ESC[54A <diff of 55 rows>
//
// The cursor was on row 53. No terminal can move up 54 from there, so every one does what
// the standard says and stops at row 0. Claude Code meant a row one ABOVE that: after the
// shrink it takes the screen to show the last 55 rows of its frame, as if the terminal
// had pulled a line back down out of the scrollback, and a real terminal never does. So
// the whole repaint landed one row too high, and each skipped gap showed whatever letter
// the row above had in that column.
// Across 244 Claude pane logs on this Mac, 29 cursor-ups in 23 panes met the shape below.
//
// So the pane gives the CLI the screen it is drawing against: when a cursor-up would stop
// at the top, the rows it cannot reach are brought back from the scrollback - the screen
// scrolls DOWN by the shortfall, the rows it opens at the top are the lines that were
// last pushed off, and the cursor follows its row. The move then lands where the CLI
// meant, on the line it expects, and every relative move after it agrees again.
//
// Only in the shape that proves that is what happened, and a plain clamp otherwise:
//   - the normal screen with no scroll region (the alternate screen has no scrollback);
//   - the shortfall is exactly the blank rows under the cursor: the CLI believes its cursor
//     is on the last row, which is what a frame that shrank at the bottom leaves behind.
//     `ESC[999A` used as "go to the top" never qualifies, and neither does the cursor-up
//     Claude Code draws its banner with after `/clear` (`ESC[4B \r ESC[6A` from the top of
//     a screen the pane has just emptied: bringing rows back there would put the turn the
//     pane kept back on the cleared screen);
//   - the scrollback holds at least that many lines.
// The lines brought back are copies: the originals stay in the scrollback, so nothing is
// ever lost - at worst a line shows twice, in the scrollback and on the screen, until the
// CLI paints over the screen one.
//
// xterm has no public way to change rows from inside its parser, and the fix has to run
// between the cursor-up being read and the bytes after it, so this reaches into its core -
// the same two list operations its own `CSI T` (scroll down) does, with a copied line in
// place of a blank one. `npm run test:cursorup` replays the measured frame through a real
// xterm, so an xterm upgrade that moves any of this shows up there as the letters coming
// back, and anything missing makes this a plain clamp rather than an error.

/** The one thing asked of a terminal: xterm's parser hook. */
interface HookableTerminal {
  rows: number
  parser: {
    registerCsiHandler(id: { final: string }, handler: (params: (number | number[])[]) => boolean): { dispose(): void }
  }
}

/** The part of xterm's core this reaches: its active buffer and the row repaint tracker. */
interface CoreLine {
  isWrapped: boolean
  clone(): CoreLine
  translateToString(trimRight?: boolean): string
}
interface CoreBuffer {
  lines: { get(i: number): CoreLine | undefined; splice(start: number, deleteCount: number, ...items: CoreLine[]): void }
  ybase: number
  y: number
  scrollTop: number
  scrollBottom: number
}
interface Core {
  buffer: CoreBuffer
  buffers: { normal: CoreBuffer }
  _inputHandler: { _dirtyRowTracker: { markRangeDirty(y1: number, y2: number): void } }
}

/**
 * How many rows to bring back before a cursor-up of `n` from row `y`, or 0 to let the
 * terminal clamp it. `blankFromBottom` counts blank rows up from the last one.
 */
export function shortfall(n: number, y: number, rows: number, blankFromBottom: number, scrollback: number): number {
  const k = n - y
  if (k <= 0) return 0
  if (y + k !== rows - 1) return 0
  if (blankFromBottom < k) return 0
  if (scrollback < k) return 0
  return k
}

/** Install the fix on a terminal. Returns what undoes it. */
export function realignCursorUp(term: HookableTerminal): { dispose(): void } {
  return term.parser.registerCsiHandler({ final: 'A' }, (params) => {
    try {
      const core = (term as unknown as { _core?: Core })._core
      const buf = core?.buffer
      if (!core || !buf || buf !== core.buffers.normal) return false
      const rows = term.rows
      if (buf.scrollTop !== 0 || buf.scrollBottom !== rows - 1) return false
      const first = params[0]
      const n = Math.max(1, (typeof first === 'number' ? first : first?.[0]) || 1)
      if (n <= buf.y) return false
      let blank = 0
      for (let r = rows - 1; r > buf.y; r--) {
        if (buf.lines.get(buf.ybase + r)?.translateToString(true) !== '') break
        blank++
      }
      const k = shortfall(n, buf.y, rows, blank, buf.ybase)
      if (!k) return false
      // Bottom row out, a copy of the line above the screen in at the top, k times: the
      // i-th pass copies the line i+1 above the screen, so they come back in order.
      const back: CoreLine[] = []
      for (let i = 0; i < k; i++) {
        const line = buf.lines.get(buf.ybase - 1 - i)?.clone()
        if (!line) return false
        back.push(line)
      }
      // The topmost copy continues nothing on screen: left marked as wrapped, a resize would
      // join it onto the original above it and show that text twice.
      back[back.length - 1].isWrapped = false
      for (const line of back) {
        buf.lines.splice(buf.ybase + rows - 1, 1)
        buf.lines.splice(buf.ybase, 0, line)
      }
      buf.y += k
      core._inputHandler._dirtyRowTracker.markRangeDirty(0, rows - 1)
    } catch {
      // An xterm whose core no longer looks like this: the plain clamp, as before.
    }
    // Never swallow the move itself: xterm's own cursor-up runs next, now in range.
    return false
  })
}
