// Moving around a pane's scrollback and selecting text with no mouse - tmux's copy
// mode, which is the one piece of terminal craft this app had no answer to at all.
// Copy-on-select and Ctrl+C both need a hand on the mouse, and the thing people
// actually want to copy out of an agent pane - the command it just printed, the path in
// the error - is three keys away in tmux and a drag here.
//
// All of the arithmetic lives here, away from xterm, because it is the half that can be
// wrong in ways a screenshot cannot show: a column that quietly clamps to the wrong end
// of a short line, a selection length that is one cell out on the row it wraps at. The
// pane does two things this file cannot do (draw and read the buffer) and nothing else.
//
// The motions are vi's WORD ones (`W`/`B`, runs of non-space) rather than vi's `w`/`b`
// (which also stop at every punctuation run). In a terminal the thing being reached for
// is nearly always a path, a URL or a flag - `src/main/pipe.ts` is one thing to a person
// and eight stops to vi's small `w`.

export interface CopyState {
  /** absolute buffer line, scrollback included */
  row: number
  /** 0-based column */
  col: number
  /** where a selection was started with `v`, null when only the cursor is moving */
  anchor: { row: number; col: number } | null
  /**
   * The column the cursor is REACHING for, which is not the column it is in. Walking
   * down through a short line and out the other side must come back to where it was,
   * or every j past a blank line drags the cursor to column 0 for good.
   */
  want: number
  /**
   * Whole lines (`V`). It cannot be expressed as a column pair the way `v` can: going
   * DOWN, the range has to reach the end of a line whose length is not known until the
   * cursor is on it, and going UP it has to reach the end of the anchor's line, which
   * the cursor has just left. So the shape is remembered and the ends are computed
   * when the selection is drawn.
   */
  lineWise: boolean
}

export interface CopyCtx {
  /** terminal width, which is what a selection length wraps at */
  cols: number
  /** last addressable line in the buffer */
  lastRow: number
  /** how many rows are on screen, for the page motions */
  viewRows: number
  /** the text of one buffer line, right-trimmed */
  lineText(row: number): string
}

export type CopyAction = 'none' | 'yank' | 'exit' | 'find'

export interface CopyResult {
  state: CopyState
  action: CopyAction
}

export function startState(row: number, col: number): CopyState {
  return { row, col, anchor: null, want: col, lineWise: false }
}

/** The last column that has a character on it; 0 on an empty line. */
function maxCol(ctx: CopyCtx, row: number): number {
  return Math.max(0, ctx.lineText(row).length - 1)
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * One keypress. Returns the new state and what the pane should do about it.
 *
 * `key` is the browser's `KeyboardEvent.key`, and `ctrl` is its modifier - only two
 * chords mean anything here (Ctrl-D and Ctrl-U, the half-page motions vi and less both
 * use), and everything else with a modifier is left for the app's own shortcuts.
 */
export function applyKey(s: CopyState, key: string, ctrl: boolean, ctx: CopyCtx): CopyResult {
  const at = (row: number, col: number): CopyState => {
    const r = clamp(row, 0, ctx.lastRow)
    // `want` follows the column the cursor actually reached, not the one asked for.
    // Pressing `l` against the end of a short line moves nothing on screen, and it must
    // not quietly move where the next `j` will land either.
    const c = clamp(col, 0, maxCol(ctx, r))
    return { row: r, col: c, anchor: s.anchor, want: c, lineWise: s.lineWise }
  }
  // Vertical motion keeps the wanted column and lands wherever the shorter line ends.
  const toRow = (row: number): CopyState => {
    const r = clamp(row, 0, ctx.lastRow)
    return {
      row: r,
      col: clamp(s.want, 0, maxCol(ctx, r)),
      anchor: s.anchor,
      want: s.want,
      lineWise: s.lineWise
    }
  }
  const done = (state: CopyState, action: CopyAction = 'none'): CopyResult => ({ state, action })

  if (ctrl) {
    const half = Math.max(1, Math.floor(ctx.viewRows / 2))
    if (key === 'd') return done(toRow(s.row + half))
    if (key === 'u') return done(toRow(s.row - half))
    return done(s)
  }

  switch (key) {
    case 'h':
    case 'ArrowLeft':
      return done(at(s.row, s.col - 1))
    case 'l':
    case 'ArrowRight':
      return done(at(s.row, s.col + 1))
    case 'j':
    case 'ArrowDown':
      return done(toRow(s.row + 1))
    case 'k':
    case 'ArrowUp':
      return done(toRow(s.row - 1))
    case 'PageDown':
      return done(toRow(s.row + ctx.viewRows))
    case 'PageUp':
      return done(toRow(s.row - ctx.viewRows))
    case '0':
      return done(at(s.row, 0))
    case '^': {
      const text = ctx.lineText(s.row)
      const i = text.search(/\S/)
      return done(at(s.row, i < 0 ? 0 : i))
    }
    case '$':
      return done(at(s.row, maxCol(ctx, s.row)))
    case 'g':
      return done(at(0, 0))
    case 'G':
      return done(at(ctx.lastRow, 0))
    case 'w':
      return done(wordRight(s, ctx))
    case 'b':
      return done(wordLeft(s, ctx))
    case 'e':
      return done(wordEnd(s, ctx))
    case 'v':
      // Toggle: pressing it again drops the selection and leaves the cursor where it is,
      // which is the only way back out of a selection started in the wrong place.
      return done({
        ...s,
        anchor: s.anchor && !s.lineWise ? null : { row: s.row, col: s.col },
        lineWise: false
      })
    case 'V':
      // Whole lines. Pressing it inside a character selection widens that selection to
      // its lines rather than starting again somewhere else.
      return done({
        ...s,
        anchor: s.anchor ?? { row: s.row, col: s.col },
        lineWise: !s.lineWise || !s.anchor
      })
    case 'y':
    case 'Enter':
      return done(s, 'yank')
    case '/':
      return done(s, 'find')
    case 'q':
    case 'Escape':
      return done(s, 'exit')
    default:
      return done(s)
  }
}

/**
 * What xterm has to be told to highlight: a start cell and a length in cells, which is
 * how its own `select()` expresses a selection that wraps across rows.
 *
 * With no anchor this is the single cell under the cursor - copy mode has no caret of
 * its own, and a one-cell highlight IS the caret. That is not a workaround: a terminal
 * with the WebGL renderer has no DOM to put a caret in.
 */
export function selectionOf(s: CopyState, ctx: CopyCtx): { row: number; col: number; length: number } {
  if (!s.anchor) return { row: s.row, col: s.col, length: 1 }
  const a = s.anchor
  const first = a.row < s.row || (a.row === s.row && a.col <= s.col) ? a : { row: s.row, col: s.col }
  const last = first === a ? { row: s.row, col: s.col } : a
  if (s.lineWise) {
    // Column 0 of the first line to the end of the last one - and the end is measured
    // here, because which line it is changes with every j.
    const tail = Math.max(1, ctx.lineText(last.row).length)
    return { row: first.row, col: 0, length: (last.row - first.row) * ctx.cols + tail }
  }
  const length = (last.row - first.row) * ctx.cols + (last.col - first.col) + 1
  return { row: first.row, col: first.col, length: Math.max(1, length) }
}

/** Which row to scroll to so the cursor is on screen, or null when it already is. */
export function scrollFor(s: CopyState, viewportTop: number, viewRows: number): number | null {
  if (s.row < viewportTop) return s.row
  if (s.row > viewportTop + viewRows - 1) return s.row - viewRows + 1
  return null
}

// --- word motions -----------------------------------------------------------------
// Deliberately within one line. A word motion that walked onto the next line would in a
// terminal walk onto the next *wrapped fragment* of the same line as often as not, and
// the pane cannot tell those apart without asking xterm about wrapping - which is the
// kind of thing this file exists to stay out of.

function wordRight(s: CopyState, ctx: CopyCtx): CopyState {
  const text = ctx.lineText(s.row)
  let i = s.col
  while (i < text.length && !/\s/.test(text[i])) i++
  while (i < text.length && /\s/.test(text[i])) i++
  const col = i >= text.length ? Math.max(0, text.length - 1) : i
  return { ...s, col, want: col }
}

function wordLeft(s: CopyState, ctx: CopyCtx): CopyState {
  const text = ctx.lineText(s.row)
  let i = s.col - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  while (i > 0 && !/\s/.test(text[i - 1])) i--
  const col = Math.max(0, i)
  return { ...s, col, want: col }
}

function wordEnd(s: CopyState, ctx: CopyCtx): CopyState {
  const text = ctx.lineText(s.row)
  let i = s.col + 1
  while (i < text.length && /\s/.test(text[i])) i++
  while (i + 1 < text.length && !/\s/.test(text[i + 1])) i++
  const col = clamp(i, 0, Math.max(0, text.length - 1))
  return { ...s, col, want: col }
}
