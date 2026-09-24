// Rows a Claude Code repaint pushes off the top of the screen without scrolling them.
//
// Claude Code redraws its frame in place. When the part of the frame on screen moves down
// the conversation - a reply grows, a block collapses - it goes back to the top row and
// paints every row again, each one `m` rows further on. The top `m` rows of the old screen
// are not scrolled into the scrollback, the way a terminal's own output would push them:
// they are painted over. That text was a finished reply, it is never sent again, and so
// scrolling up finds a hole in the middle of the answer - in every terminal, not only here.
//
// Measured 2026-09-25 on pane s129 (130x55, Claude Code 2.1.281): one repaint painted over
// 14 lines of a finished reply, and not one of their words appears again in the rest of the
// log (0 of 13 non-blank lines anywhere in the buffer at any later point). Across the 86
// Claude pane logs on this Mac that kept one size for their whole life, 249 repaints lost
// 965 lines in 32 panes: 237 of them begin with `ESC[H`, 12 with a cursor-up to row 0.
//
// So when a frame starts at the top row, the pane keeps a copy of the screen, and when the
// frame ends it checks whether the screen is that copy moved up by `m` rows. If it is, the
// `m` rows that fell off the top go back into the scrollback, above the screen, in order.
// Only in the shape that proves that is what happened:
//   - the frame reached row 0 on the normal screen with no scroll region (a cursor-up of
//     at least the cursor's row, or a cursor position on row 1), and the pane was not
//     resized before the frame ended (a frame ends at `ESC[?25h` or `ESC[?2026l`);
//   - at least 5 rows of 8+ characters from old row `m` on sit exactly `m` rows higher, the
//     run starts AT old row `m` (so it is the top that went, not a block in the middle),
//     and more rows match moved than match in place;
//   - the screen is no emptier at the bottom than it was (a frame that shrank moved nothing);
//   - a row whose text is already on the screen or in the screenful of scrollback above it
//     is not put back, so nothing shows twice - that includes the copy `cursorUpRealign.ts`
//     brings back for its own fix. Only that near: the same words far up the scrollback
//     are an earlier turn (`… +2 lines (ctrl+o to expand)`, a command run twice), and a
//     whole-buffer check dropped those rows from the middle of the reply they belonged to.
// Where the old screen top now is comes from an xterm marker, not a remembered index: a
// full scrollback drops lines off its far end as the frame scrolls, and every index moves.
//
// Replayed over the 89 single-size Claude pane logs on this Mac with the pane's 20,000-line
// scrollback, it puts back 680 lines in 30 panes, at 2-3 µs a frame (70 MB parsed in 1,044
// ms against 884 without it). Where a line it put back also
// shows elsewhere (checked by hand in s17, s20, s31, s141), Claude Code had printed that
// stretch of the conversation twice and the rows around it show twice as well: it filled
// the hole in the first copy, it did not add a copy.
//
// This is the "middle case" `screenLoss.ts` refuses to file on purpose, and its reason does
// not apply here: that check snapshots at a wipe and judges 400 ms later, so it would file
// the TEXT of whatever half-drawn frame was on screen. This one copies the screen the last
// frame FINISHED (a frame ends at `?25h`/`?2026l`), puts back the rows themselves, colours
// and all, and only when the rows under them moved by exactly `m`. When it has put rows
// back the pane drops its pending wipe check (`onKept`), or a repaint that lost 80%+ of
// the screen would be filed a second time by that check.
//
// Like `cursorUpRealign.ts` this reaches into xterm's core, because there is no public way
// to put a line into the scrollback anywhere but its end; anything missing makes it a
// no-op. `npm run test:pushedoff` replays s129's frame through a real xterm.

/** The one thing asked of a terminal: xterm's parser hooks and its resize event. */
interface HookableTerminal {
  rows: number
  onResize(listener: () => void): { dispose(): void }
  registerMarker(cursorYOffset?: number): { line: number; isDisposed: boolean; dispose(): void } | undefined
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      handler: (params: (number | number[])[]) => boolean
    ): { dispose(): void }
  }
}

interface CoreLine {
  isWrapped: boolean
  clone(): CoreLine
  translateToString(trimRight?: boolean): string
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
  y: number
  scrollTop: number
  scrollBottom: number
}
interface Core {
  buffer: CoreBuffer
  buffers: { normal: CoreBuffer }
  _inputHandler: {
    _dirtyRowTracker: { markRangeDirty(y1: number, y2: number): void }
    _onRequestSyncScrollBar?: { fire(): void }
  }
}

const MIN_LEN = 8
const MIN_RUN = 5

const blankAtBottom = (rows: string[]): number => {
  let n = 0
  for (let i = rows.length - 1; i >= 0 && !rows[i].trim(); i--) n++
  return n
}

/** A row's text for "is this already in the buffer": its border and bullet glyphs dropped. */
export const rowKey = (text: string): string => text.replace(/^[^\p{L}\p{N}]+/u, '').trimEnd()

/**
 * How many rows fell off the top, or 0. `before` is the screen when the frame reached the
 * top; `after[i]` is what the buffer now holds on the line `before[i]` was on.
 */
export function displaced(before: string[], after: (string | null)[]): number {
  const rows = before.length
  const score = (m: number): [number, number] => {
    let count = 0
    let first = -1
    for (let r = m; r < rows; r++) {
      if (before[r].trim().length < MIN_LEN || after[r - m] !== before[r]) continue
      count++
      if (first < 0) first = r
    }
    return [count, first]
  }
  const [inPlace] = score(0)
  let best = 0
  let shift = 0
  let start = -1
  for (let m = 1; m < rows; m++) {
    const [count, first] = score(m)
    if (count > best) [best, shift, start] = [count, m, first]
  }
  if (best < MIN_RUN || best <= inPlace || start !== shift) return 0
  return shift
}

/** The part of `before` that goes back: rows `0..m-1`, minus text the buffer already has. */
export function toKeep(before: string[], m: number, has: (key: string) => boolean): number[] {
  const keep: number[] = []
  for (let r = 0; r < m; r++) {
    const key = rowKey(before[r])
    if (key && has(key)) continue
    keep.push(r)
  }
  return keep.some((r) => before[r].trim()) ? keep : []
}

/**
 * Install the fix on a terminal. Install it BEFORE `realignCursorUp`, which must run first.
 * `onKept` hears each time rows were put back.
 */
export function keepPushedOffRows(term: HookableTerminal, onKept: () => void): { dispose(): void } {
  let snap: { top: { line: number; isDisposed: boolean; dispose(): void }; text: string[]; lines: CoreLine[] } | null = null
  const drop = (): void => {
    snap?.top.dispose()
    snap = null
  }
  const coreOf = (): Core | null => (term as unknown as { _core?: Core })._core ?? null

  const take = (): void => {
    if (snap) return
    try {
      const core = coreOf()
      const buf = core?.buffer
      if (!core || !buf || buf !== core.buffers.normal) return
      const rows = term.rows
      if (buf.scrollTop !== 0 || buf.scrollBottom !== rows - 1) return
      const text: string[] = []
      const lines: CoreLine[] = []
      for (let r = 0; r < rows; r++) {
        const line = buf.lines.get(buf.ybase + r)
        if (!line) return
        text.push(line.translateToString(true))
        lines.push(line.clone())
      }
      // The marker lands on the cursor's row plus the offset: the top row of the screen.
      const top = term.registerMarker(-buf.y)
      if (top) snap = { top, text, lines }
    } catch {
      drop()
    }
  }

  const settle = (): boolean => {
    const taken = snap
    snap = null
    if (!taken) return false
    const base = taken.top.isDisposed ? -1 : taken.top.line
    taken.top.dispose()
    if (base < 0) return false
    try {
      const core = coreOf()
      const buf = core?.buffer
      if (!core || !buf || buf !== core.buffers.normal) return false
      const rows = term.rows
      if (taken.text.length !== rows) return false
      const at = (i: number): string | null => buf.lines.get(i)?.translateToString(true) ?? null
      const after: (string | null)[] = []
      for (let i = 0; i < rows; i++) after.push(at(base + i))
      const m = displaced(taken.text, after)
      if (!m) return false
      const screen: string[] = []
      for (let r = 0; r < rows; r++) screen.push(at(buf.ybase + r) ?? '')
      if (blankAtBottom(screen) > blankAtBottom(taken.text)) return false
      const known = new Set<string>()
      for (let i = Math.max(0, base - rows); i < buf.ybase + rows; i++) known.add(rowKey(at(i) ?? ''))
      const keep = toKeep(taken.text, m, (key) => known.has(key))
      if (!keep.length) return false
      let back = keep.map((r, i) => {
        const line = taken.lines[r]
        // A row whose row above was not put back continues nothing it now sits under.
        if (i > 0 ? keep[i - 1] !== r - 1 : r !== 0) line.isWrapped = false
        return line
      })
      const atBottom = buf.ydisp === buf.ybase
      // A full scrollback makes room the way a scroll does, off its oldest end - by hand,
      // because xterm's splice past a full list moves lines onto slots it has not read yet
      // (measured: a 12-line buffer came out with its screen rows out of order). Never
      // past `base`: whatever still does not fit is the oldest of the rows going back.
      const over = buf.lines.length + back.length - buf.lines.maxLength
      let into = base
      if (over > 0) {
        const trim = Math.min(over, base)
        back = back.slice(over - trim)
        buf.lines.trimStart(trim)
        buf.ybase -= trim
        buf.ydisp = Math.max(0, buf.ydisp - trim)
        into -= trim
      }
      if (!back.length) return false
      buf.lines.splice(into, 0, ...back)
      buf.ybase += back.length
      if (atBottom) buf.ydisp = buf.ybase
      else if (buf.ydisp >= into) buf.ydisp += back.length
      core._inputHandler._dirtyRowTracker.markRangeDirty(0, rows - 1)
      core._inputHandler._onRequestSyncScrollBar?.fire()
      onKept()
    } catch {
      // An xterm whose core no longer looks like this: the rows stay lost, as before.
    }
    return false
  }

  const hooks = [
    term.parser.registerCsiHandler({ final: 'A' }, (params) => {
      const first = params[0]
      const n = Math.max(1, (typeof first === 'number' ? first : first?.[0]) || 1)
      const buf = coreOf()?.buffer
      if (buf && n >= buf.y) take()
      return false
    }),
    ...['H', 'f'].map((final) =>
      term.parser.registerCsiHandler({ final }, (params) => {
        const first = params[0]
        if (((typeof first === 'number' ? first : first?.[0]) || 1) === 1) take()
        return false
      })
    ),
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      // A frame left for the alternate screen is abandoned; its snapshot must not be judged
      // against whatever the normal screen shows when the CLI comes back.
      if (params.some((p) => p === 1049 || p === 1047 || p === 47)) drop()
      return params.includes(25) ? settle() : false
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => (params.includes(2026) ? settle() : false)),
    term.onResize(drop)
  ]
  return {
    dispose: () => {
      drop()
      hooks.forEach((h) => h.dispose())
    }
  }
}
