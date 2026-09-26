// A pane that gets narrower breaks the lines above it between words, not through them.
//
// Claude Code ends every line of a reply itself, at the width the pane had when it wrote
// it. When the pane then gets narrower - a second pane opens beside it - each of those
// lines is too long for the new width, and xterm's reflow cuts it at the last column and
// carries the rest to column 0 of the next row: "...(workflow, ho" / "ok, skill,". Measured
// 2026-09-26 on pane s52: a reply drawn at ~145 columns, the pane narrowed to 133 when s53
// opened at 6:02pm, and replaying its log is clean at 143-150 and torn at 133. No terminal
// can do better than a cut from the bytes alone - the CLI's own line ends are hard - and
// the CLI only repaints the screen, never the scrollback.
//
// So on a shrink, the scrollback rows xterm has just split are split again at a space, with
// the continuation indented under the text it continues (a list item's text, not its
// dash). Only rows ABOVE the screen: the screen is the CLI's own, and with the pty going
// first (`shrinkFirst.ts`) it has already been repainted at the new width. A line whose
// overflow is only a rule (`────`) or blanks is cut instead of carried - a separator
// drawn at the old width is still a separator.
//
// The new rows are separate lines, not soft wraps: a pane that grows back leaves them
// as they are (xterm would join a soft wrap back with the indent inside the sentence).
//
// `npm run test:wordrewrap`.

/** One cell of a logical line: its text ('' for an empty cell), or null for the right half of a wide character. */
export type Cell = string | null

export interface WrapPlan {
  /** Blank cells in front of every row after the first. */
  indent: number
  /** Each new row as a [from, to) range of the logical line's cells. */
  rows: [number, number][]
}

const isGap = (c: Cell): boolean => c === '' || c === ' '
const RULE = /^[─━═—–\-_]$/
/** What a line of prose may start with; a glyph (⎿ ⏺ │ ...) starts a new block. */
const PROSE = /^[\p{L}\p{N}"'`(\[{<*_~$/.@#&]$/u

/** How far a continuation is indented: under the text, past a list marker when there is one. */
export function hangingIndent(cells: Cell[], cols: number): number {
  let s = 0
  while (s < cells.length && isGap(cells[s])) s++
  let head = ''
  for (let i = s; i < Math.min(cells.length, s + 6); i++) head += cells[i] || ' '
  const marker = /^([-*•] |\d{1,3}[.)] |⎿ +)/.exec(head)
  const indent = s + (marker ? marker[0].length : 0)
  return indent * 2 > cols ? 0 : indent
}

/** Where a too-long logical line breaks at `cols`, or null when it is not too long. */
export function planWrap(cells: Cell[], cols: number): WrapPlan | null {
  let n = cells.length
  while (n > 0 && isGap(cells[n - 1])) n--
  if (cols < 8) return null
  if (n <= cols) return { indent: 0, rows: [[0, n]] }
  // The overflow is a rule or nothing: cut it, do not carry it.
  const tail = cells.slice(cols, n)
  const last = cells[cols - 1]
  if (last && RULE.test(last) && tail.every((c) => c === last || isGap(c))) return { indent: 0, rows: [[0, cols]] }
  const indent = hangingIndent(cells, cols)
  const rows: [number, number][] = []
  let p = 0
  while (p < n) {
    const avail = rows.length ? cols - indent : cols
    let end = p + avail
    if (end >= n) {
      rows.push([p, n])
      break
    }
    // Never between the two halves of a wide character.
    while (end > p && cells[end] === null) end--
    let b = end
    while (b > p && !isGap(cells[b])) b--
    if (b > p) {
      let to = b
      while (to > p && isGap(cells[to - 1])) to--
      rows.push([p, to])
      p = b
    } else {
      rows.push([p, end])
      p = end
    }
    while (p < n && isGap(cells[p])) p++
  }
  return { indent, rows }
}

interface CoreLine {
  isWrapped: boolean
  getTrimmedLength(): number
  getString(i: number): string
  getWidth(i: number): number
  copyCellsFrom(src: CoreLine, srcCol: number, destCol: number, length: number, reverse: boolean): void
}
interface CoreBuffer {
  lines: {
    length: number
    maxLength: number
    get(i: number): CoreLine | undefined
    splice(start: number, deleteCount: number, ...items: CoreLine[]): void
    trimStart(count: number): void
  }
  ybase: number
  ydisp: number
  getBlankLine(attr: undefined, isWrapped?: boolean): CoreLine
}
interface Core {
  buffer: CoreBuffer
  buffers: { normal: CoreBuffer }
  _inputHandler: {
    _dirtyRowTracker: { markRangeDirty(y1: number, y2: number): void }
    _onRequestSyncScrollBar?: { fire(): void }
  }
}
interface ResizableTerminal {
  cols: number
  rows: number
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void }
}

/** A line Claude filled to its width: the next line of the same paragraph follows it. */
const FULL_SLACK = 20

/**
 * Re-break every split line in the scrollback at `term.cols`. Returns how many paragraphs
 * were rebuilt. Rows on the screen, and a line that runs onto it, are left alone.
 *
 * `oldCols` is the width the pane had: a line that filled it (within `FULL_SLACK`) was
 * ended by the CLI mid-paragraph, so the line under it - same indent, not a new list item,
 * not blank, not a rule - is joined on before re-breaking. Without that every paragraph
 * comes out as a long row and an orphan ("...(workflow," / "hook, skill,") per old line.
 */
export function rewrapScrollback(term: ResizableTerminal, oldCols = 0): number {
  const core = (term as unknown as { _core?: Core })._core
  const buf = core?.buffer
  if (!core || !buf || buf !== core.buffers.normal) return 0
  const cols = term.cols
  const lines = buf.lines
  // Each logical line in the scrollback as [first row, last row].
  const logical: [number, number][] = []
  for (let i = 0; i < buf.ybase; i++) {
    const head = lines.get(i)
    if (!head || head.isWrapped) continue
    let e = i
    while (e + 1 < lines.length && lines.get(e + 1)?.isWrapped) e++
    if (e >= buf.ybase) break
    logical.push([i, e])
    i = e
  }
  const textOf = ([h, e]: [number, number]): Cell[] => {
    const cells: Cell[] = []
    for (let r = h; r <= e; r++) {
      const line = lines.get(r) as CoreLine
      const len = r < e ? cols : line.getTrimmedLength()
      for (let c = 0; c < len; c++) cells.push(line.getWidth(c) === 0 ? null : line.getString(c))
    }
    return cells
  }
  const lead = (cells: Cell[]): number => {
    let n = 0
    while (n < cells.length && isGap(cells[n])) n++
    return n
  }
  const trimmed = (cells: Cell[]): number => {
    let n = cells.length
    while (n > 0 && isGap(cells[n - 1])) n--
    return n
  }
  // Paragraphs: runs of logical lines, the first of them split by the shrink.
  const groups: [number, number][][] = []
  for (let k = 0; k < logical.length; k++) {
    const [h, e] = logical[k]
    if (e === h) continue
    const unit = [logical[k]]
    let cells = textOf(logical[k])
    const indent = hangingIndent(cells, cols)
    while (oldCols > 0 && k + 1 < logical.length && trimmed(cells) >= oldCols - FULL_SLACK) {
      const next = logical[k + 1]
      if (next[0] !== unit[unit.length - 1][1] + 1) break
      const nc = textOf(next)
      const n = trimmed(nc)
      const s = lead(nc)
      if (!n || s !== indent) break
      if (hangingIndent(nc, cols) !== s) break
      const first = nc[s]
      if (!first || !PROSE.test(first)) break
      const at0 = lead(cells)
      const own = cells[at0]
      if (!own || (RULE.test(own) && cells[at0 + 1] === own)) break
      unit.push(next)
      cells = nc
      k++
    }
    groups.push(unit)
  }
  if (!groups.length) return 0
  const atBottom = buf.ydisp === buf.ybase
  let done = 0
  // Rows trimmed off the oldest end so far: every group above moves up by this much.
  let shift = 0
  for (let g = groups.length - 1; g >= 0; g--) {
    const unit = groups[g]
    let at = unit[0][0] - shift
    if (at < 0) break
    const last = unit[unit.length - 1][1] - shift
    const src: CoreLine[] = []
    for (let r = at; r <= last; r++) src.push(lines.get(r) as CoreLine)
    const cells: Cell[] = []
    // Where each cell comes from as [row in src, column]; [-1, -1] is a space put between
    // two joined lines.
    const where: [number, number][] = []
    unit.forEach(([h, e], u) => {
      const part: Cell[] = []
      const from: [number, number][] = []
      for (let r = h; r <= e; r++) {
        const j = r - unit[0][0]
        const line = src[j]
        const len = r < e ? cols : line.getTrimmedLength()
        for (let c = 0; c < len; c++) {
          part.push(line.getWidth(c) === 0 ? null : line.getString(c))
          from.push([j, c])
        }
      }
      const skip = u ? lead(part) : 0
      if (u) {
        while (cells.length && isGap(cells[cells.length - 1])) {
          cells.pop()
          where.pop()
        }
        cells.push(' ')
        where.push([-1, -1])
      }
      cells.push(...part.slice(skip))
      where.push(...from.slice(skip))
    })
    const plan = planWrap(cells, cols)
    if (!plan) continue
    const out = plan.rows.map(([from, to], k) => {
      const line = buf.getBlankLine(undefined, false)
      let dest = k ? plan.indent : 0
      let i = from
      while (i < to) {
        const [j, c] = where[i]
        if (j < 0) {
          dest++
          i++
          continue
        }
        let run = 1
        while (i + run < to && where[i + run][0] === j && where[i + run][1] === c + run) run++
        if (dest + run > cols) run = Math.max(0, cols - dest)
        if (!run) break
        line.copyCellsFrom(src[j], c, dest, run, false)
        dest += run
        i += run
      }
      return line
    })
    const grow = out.length - src.length
    // A full scrollback makes room off its oldest end first; xterm's own splice past a
    // full list scrambles it (see pushedOffTop.ts).
    const over = lines.length + grow - lines.maxLength
    if (over > 0) {
      if (over > at) continue
      lines.trimStart(over)
      buf.ybase -= over
      buf.ydisp = Math.max(0, buf.ydisp - over)
      at -= over
      shift += over
    }
    lines.splice(at, src.length, ...out)
    buf.ybase += grow
    if (!atBottom && buf.ydisp > at) buf.ydisp = Math.max(0, buf.ydisp + grow)
    done++
  }
  if (atBottom) buf.ydisp = buf.ybase
  core._inputHandler._dirtyRowTracker.markRangeDirty(0, term.rows - 1)
  core._inputHandler._onRequestSyncScrollBar?.fire()
  return done
}

/**
 * Install on a pane: every time it gets narrower, re-break its scrollback between words.
 *
 * `allow` says whether THIS shrink is one to rewrap. A rewrap is permanent - the soft wraps
 * xterm would undo on widening become hard breaks - so a temporary shrink (a replay put
 * back, a hidden pane sized) must be left to xterm's own reversible reflow.
 */
export function rewrapOnShrink(term: ResizableTerminal, allow: () => boolean = () => true): { dispose(): void } {
  let cols = term.cols
  return term.onResize((size) => {
    const was = cols
    cols = size.cols
    if (size.cols >= was || !allow()) return
    try {
      rewrapScrollback(term, was)
    } catch {
      // An xterm whose core no longer looks like this keeps its own reflow.
    }
  })
}
