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
 * The same backstop for a DELETE, and it is twenty-five times the other one on purpose.
 *
 * 400 is right for arrows: the danger there is a CLI reading an arrow as a menu step, and
 * nothing legitimate needs hundreds of them. A backspace is not an arrow. It is bounded by
 * something real - you cannot have typed more than the screen holds - and the worst a
 * spurious one does is delete a character the CLI can put back.
 *
 * Sharing the arrow limit is what made "highlight it and press delete" leave text behind.
 * `keysForDelete` returned `''` for any selection over 400 characters, the pane read that
 * as "not eligible" and handed the key to the pty, and the pty did what a bare Backspace
 * always does: removed ONE character and left the highlight sitting there. A Mod+A over a
 * paragraph-length prompt is past 400 immediately, so the whole-input case - the one the
 * select-all exists for - was the case that could not work.
 *
 * 10000 is a 200x50 screenful, which is the true ceiling on what may be selected here: the
 * selection has to be on the line the far end is editing, and that line is on the screen.
 */
const DEFAULT_DELETE_LIMIT = 10000

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
 * The keys for a click that may only move ALONG the line the cursor is already editing -
 * left and right, never up and never down.
 *
 * This is what a BARE click sends, and the restriction is the whole reason a bare click is
 * allowed to do anything at all. An up-arrow in a plain shell is the previous command, not
 * a movement, so a click that could emit one has to be behind a modifier. A click that can
 * only emit left and right cannot recall anything, cannot leave the line, and in the worst
 * case walks to the end of it and stops - which is what every line editor does with a right
 * arrow it cannot honour.
 *
 * `cols` is what makes a wrapped line work. A long prompt drawn across three rows is ONE
 * line to the editor at the far end, so a click two rows up is `2 * cols` characters back
 * and the arrows cross the wrap by themselves. The caller decides which rows qualify -
 * see `sameLine` in `TerminalPane.tsx`, which walks xterm's own `isWrapped` chain.
 */
export function keysAlongLine(c: {
  cursorCol: number
  clickCol: number
  /** How many rows the click is from the cursor's row, positive downwards. */
  rows: number
  /** The terminal's width, so a wrapped row counts as that many characters. */
  cols: number
  keyLimit?: number
}): string {
  if (!(c.cols > 0)) return ''
  const delta = c.rows * c.cols + (c.clickCol - c.cursorCol)
  if (!delta) return ''
  if (Math.abs(delta) > (c.keyLimit ?? DEFAULT_KEY_LIMIT)) return ''
  return (delta > 0 ? ARROW.right : ARROW.left).repeat(Math.abs(delta))
}

/** What every line editor and every CLI input box reads as "delete one character back". */
export const BACKSPACE = '\x7f'

/**
 * The keys that delete a highlighted piece of what you have typed.
 *
 * A terminal cannot hand a selection to the far end any more than it can hand it a caret,
 * so a selection you can see and cannot delete is the ordinary state of every terminal -
 * "can't select all and then delete" was the report. The move is the same one a click
 * makes: walk the cursor to the END of the selection with arrows, then send one backspace
 * per selected character. What comes back is the CLI's own editing, so it undoes, it
 * re-wraps, and nothing here has to know what it is editing.
 *
 * `wrapped` is what makes a multi-row selection legal. Rows a long input WRAPPED onto are
 * one line to the far end, `cols` characters each, so the arithmetic crosses them. Rows of
 * a drawn input box are separate lines holding a newline and a frame of unknown width, and
 * that count cannot be derived from the screen - so a selection across those is refused
 * rather than guessed at, and a guess here is a burst of backspaces eating the line above.
 */
export function keysForDelete(c: {
  cursorRow: number
  cursorCol: number
  /** the selection, in absolute buffer rows, end exclusive */
  startRow: number
  startCol: number
  endRow: number
  endCol: number
  cols: number
  /** the selected rows are one wrapped line, not separate lines of a box */
  wrapped: boolean
  keyLimit?: number
}): string {
  const keyLimit = c.keyLimit ?? DEFAULT_DELETE_LIMIT
  const rows = c.endRow - c.startRow
  if (rows < 0) return ''
  if (rows > 0 && !c.wrapped) return ''
  if (!(c.cols > 0)) return ''
  const length = rows * c.cols + (c.endCol - c.startCol)
  if (length <= 0 || length > keyLimit) return ''
  // The cursor has to reach the far end of the selection first, and it may only do that
  // along the line it is already on - the same restriction a bare click lives under.
  const toEnd = c.endRow - c.cursorRow
  if (toEnd !== 0 && !c.wrapped) return ''
  const move = keysAlongLine({
    cursorCol: c.cursorCol,
    clickCol: c.endCol,
    rows: toEnd,
    cols: c.cols,
    keyLimit
  })
  if (Math.abs(toEnd) * c.cols + Math.abs(c.endCol - c.cursorCol) > keyLimit) return ''
  return move + BACKSPACE.repeat(length)
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
