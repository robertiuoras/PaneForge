// Clicking where you want the caret, in a terminal that has no caret to click.
//
// A CLI's prompt box is drawn text, not a text field: the pty is handed keystrokes and
// nothing else, so a click on the middle of a half-typed line arrives nowhere. Every
// terminal that solves this at all solves it the same way (iTerm2 has shipped it for
// years as Option-click): work out how far the click is from where the cursor actually
// is, and send that many arrow keys. The line editor on the other end does the moving.
//
// This file is only the arithmetic, which is the part worth pinning down - it decides
// what the pty receives, and a wrong answer types dozens of keys into somebody's shell.
// `npm run test:cursorclick`.

/** The escape sequences a line editor reads as the four arrows. */
export const ARROW = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const

export interface CursorClick {
  /** The row the cursor is on, counted from the top of the whole buffer. */
  cursorRow: number
  /** The column the cursor is on, 0-based. */
  cursorCol: number
  /** The row that was clicked, counted the same way. */
  clickRow: number
  /** The column that was clicked, 0-based. */
  clickCol: number
  /**
   * How many rows away a click may be and still be treated as one. A prompt box is a
   * handful of lines; anything further is a click in the scrollback, and in a plain
   * shell an up-arrow there is not a movement at all - it is the previous command. So
   * out of range does NOTHING rather than something surprising.
   */
  rowLimit?: number
  /**
   * A backstop on the total. Nothing legitimate needs hundreds of keys, and a burst that
   * size against a CLI that treats an arrow as a menu step is the worst case there is.
   */
  keyLimit?: number
}

const DEFAULT_ROW_LIMIT = 6
const DEFAULT_KEY_LIMIT = 400

/**
 * The keys to send so the far end's cursor ends up where the click was, or `''` when the
 * click should be left alone.
 *
 * Vertical first, then horizontal: the editor has to be on the right line before moving
 * along it, and doing it the other way round walks off the end of the shorter line and
 * loses the column.
 */
export function keysForClick(c: CursorClick): string {
  const rowLimit = c.rowLimit ?? DEFAULT_ROW_LIMIT
  const keyLimit = c.keyLimit ?? DEFAULT_KEY_LIMIT
  const dRow = c.clickRow - c.cursorRow
  const dCol = c.clickCol - c.cursorCol
  if (!dRow && !dCol) return ''
  if (Math.abs(dRow) > rowLimit) return ''
  if (Math.abs(dRow) + Math.abs(dCol) > keyLimit) return ''
  const vert = (dRow > 0 ? ARROW.down : ARROW.up).repeat(Math.abs(dRow))
  const horiz = (dCol > 0 ? ARROW.right : ARROW.left).repeat(Math.abs(dCol))
  return vert + horiz
}

/**
 * Which cell a pointer is over, given the pixel box the terminal's rows and columns are
 * drawn in. Kept here beside the arithmetic it feeds so both are testable without a
 * window; the caller supplies the rectangle it measured.
 */
export function cellAt(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number
): { col: number; row: number } {
  const cw = box.width / cols
  const ch = box.height / rows
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v))
  return {
    col: clamp(Math.floor((x - box.left) / cw), cols - 1),
    row: clamp(Math.floor((y - box.top) / ch), rows - 1)
  }
}
