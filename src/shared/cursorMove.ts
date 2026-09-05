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
 * The delete path returned `''` for any selection over 400 characters, the pane read that
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

/**
 * One row of what is being typed, in screen columns: where the text starts on that row,
 * where it ends, and whether it FILLS the composer.
 *
 * `full` is the only part that is not a reading, and it decides one character. Measured
 * against a live Claude Code composer at 157 columns:
 *
 *   - a row broken at a space holds 151 characters of a 244-character prompt and the next
 *     holds 91: 242 on screen, 244 in the CLI. The wrap ATE the space, so crossing that
 *     boundary is one character nothing draws. A hard newline costs the same one - `aaaa`,
 *     esc-enter, `bbbb` is emptied by exactly 8 backspaces, not 9.
 *   - 300 unbroken `x` characters draw 153 then 147 and are emptied by exactly 300: a word
 *     too long for the line is SPLIT, and nothing was eaten.
 *
 * So a row that stops short of the width was broken at a separator worth one character, and
 * a row drawn out to the width was split and is worth none.
 */
export interface InputRow {
  /** first column of what was typed on this row */
  start: number
  /** column just past the last character typed on it */
  end: number
  /** the row is drawn out to the composer's full width, so the break below it ate nothing */
  full: boolean
  /**
   * Logical editor offsets at cell boundaries, relative to `start`. A wide glyph occupies
   * two terminal cells but one arrow/backspace position; its continuation boundary is
   * undefined so a selection cannot split it. Omitted rows retain the old ASCII mapping.
   */
  offsets?: readonly (number | undefined)[]
}

/** The small public part of an xterm buffer cell needed to map its screen columns safely. */
export interface InputCell {
  getWidth(): number
  getChars(): string
}

/**
 * Map each cell boundary in `[start, end]` to editor positions.
 *
 * xterm already owns Unicode width and cluster handling. Each non-continuation cell it
 * exposes is one editable unit, whatever `getChars()` contains; a width-zero continuation
 * has no safe caret boundary. Refusing that boundary is safer than making up a UTF-16
 * offset and deleting a half-selected glyph.
 */
export function offsetsForCells(
  start: number,
  end: number,
  cellAt: (col: number) => InputCell | undefined
): readonly (number | undefined)[] | null {
  if (start < 0 || end < start) return null
  const offsets: (number | undefined)[] = Array(end - start + 1).fill(undefined)
  offsets[0] = 0
  let logical = 0
  for (let col = start; col < end; ) {
    const cell = cellAt(col)
    if (!cell) return null
    const width = cell.getWidth()
    // Width zero is a continuation, never a safe caret point. Widths above two are not
    // a terminal shape we have evidence for, so leave that input alone rather than guess.
    if (width !== 1 && width !== 2) return null
    // Reading xterm's cluster is deliberate: its one leading cell, not JavaScript's UTF-16
    // length, is the logical editor unit. Empty cells can be typed spaces on a full row.
    cell.getChars()
    if (col + width > end) return null
    logical++
    for (let p = col + 1; p < col + width; p++) offsets[p - start] = undefined
    offsets[col + width - start] = logical
    col += width
  }
  return offsets
}

/** How many characters into the input a screen position is, or -1 when it is not in it. */
export function offsetIn(rows: InputRow[], index: number, col: number): number {
  if (!rows.length || index < 0 || index >= rows.length) return -1
  let off = 0
  for (let i = 0; i < index; i++) {
    const r = rows[i]
    const n = r.offsets?.[r.offsets.length - 1] ?? r.end - r.start
    if (n === undefined) return -1
    off += n + (r.full ? 0 : 1)
  }
  const r = rows[index]
  const at = Math.min(Math.max(col, r.start), r.end) - r.start
  const n = r.offsets ? r.offsets[at] : at
  return n === undefined ? -1 : off + n
}

/**
 * The arrows that walk the far end's cursor from one place in the input to another.
 *
 * Left and right only, whatever rows are crossed - which is what makes this safe in a
 * composer the CLI is drawing itself: the text is one string over there, so a left arrow at
 * the start of a row steps back onto the end of the one above it. An up arrow would be the
 * CLI's own history, and this never sends one.
 */
export function keysToPoint(
  rows: InputRow[],
  from: { row: number; col: number },
  to: { row: number; col: number },
  keyLimit = DEFAULT_KEY_LIMIT
): string {
  const a = offsetIn(rows, from.row, from.col)
  const b = offsetIn(rows, to.row, to.col)
  if (a < 0 || b < 0) return ''
  const d = b - a
  if (!d) return ''
  if (Math.abs(d) > keyLimit) return ''
  return (d > 0 ? ARROW.right : ARROW.left).repeat(Math.abs(d))
}

/**
 * `keysForDelete`, for an input the CLI draws over several rows of its own.
 *
 * Same move as the wrapped case - walk to the end of the selection, then one backspace per
 * character - counted over `rows` rather than over a rectangle of `cols`, because a
 * composer's rows are indented, are of different lengths, and are not xterm wraps.
 * Everything about the count is in `offsetIn`; the refusals are here.
 */
export function keysForRows(a: {
  rows: InputRow[]
  /** all three are ROW INDICES into `rows`, not buffer rows */
  cursor: { row: number; col: number }
  start: { row: number; col: number }
  end: { row: number; col: number }
  keyLimit?: number
}): string {
  const keyLimit = a.keyLimit ?? DEFAULT_DELETE_LIMIT
  const s = offsetIn(a.rows, a.start.row, a.start.col)
  const e = offsetIn(a.rows, a.end.row, a.end.col)
  const c = offsetIn(a.rows, a.cursor.row, a.cursor.col)
  if (s < 0 || e < 0 || c < 0) return ''
  const length = e - s
  if (length <= 0 || length > keyLimit) return ''
  if (Math.abs(e - c) > keyLimit) return ''
  return keysToPoint(a.rows, a.cursor, a.end, keyLimit) + BACKSPACE.repeat(length)
}

/**
 * The backspaces still owed after a delete that did not take everything highlighted.
 *
 * A composer's rows are counted, not measured: whether the break at the end of a row ate a
 * separator is a JUDGEMENT (`InputRow.full`), and one row's judgement was deliberately
 * biased - "within a column of the far edge counts as full" - because guessing the other
 * way deletes a character nobody highlighted. The cost of that bias is this: a row that
 * broke one column short of the edge is called full, its eaten space is counted as
 * nothing, and one character of the highlight survives. It survives at the START, because
 * the walk goes to the END of the selection and backspaces from there.
 *
 * So the count is checked instead of trusted. `seen` and `want` are the composer's length
 * after the keys landed and what it should have been; both are read the same way, so the
 * same ambiguity is on both sides of the subtraction and cancels. Anything left over is
 * characters of the highlight that are still there, with the cursor sitting right after
 * them - which is exactly where a backspace removes them.
 *
 * `cap` is the most that can honestly be owed: at most one character per row boundary the
 * selection crossed, plus one. Over that, something else moved the composer - the person
 * typing, the CLI redrawing - and nothing is sent, because a backspace into that is a
 * character nobody highlighted.
 */
export function leftoverBackspaces(a: { seen: number; want: number; rowsCrossed: number }): number {
  const extra = a.seen - a.want
  if (extra <= 0) return 0
  return extra > Math.max(0, a.rowsCrossed) + 1 ? 0 : extra
}
