// How big each column and row of the grid is, and the arithmetic for dragging the line
// between two of them.
//
// The grid was `repeat(n, 1fr)` with `grid-auto-rows: 1fr`: every pane exactly the same
// size, always, whatever was in it. That is the right default and the wrong only option -
// the pane you are reading is usually one of four, and the other three are being watched,
// not read. There was no way to say so.
//
// Sizes are fractions, not pixels, so a window that changes size keeps the proportions
// somebody chose. They are stored per grid SHAPE (`3x2`), not per session id: the thing
// being remembered is "in a three-across grid I want the left column wide", which survives
// closing a pane and opening another one, and does not follow a pane that moved.

/** Fractions of one axis. Always as many entries as there are tracks, always summing to n. */
export type Fractions = number[]

export interface GridSize {
  cols: Fractions
  rows: Fractions
}

/** No track may be dragged smaller than this. Below it a terminal is not a terminal. */
export const MIN_TRACK_PX = 140

/**
 * The five shapes a grid can be put into, and the order the cycle key walks them in.
 *
 * tmux calls these even-horizontal, even-vertical, main-horizontal, main-vertical and
 * tiled. Those names describe the *split* rather than the result and read backwards to
 * anyone who has not used tmux for a decade, so the same five layouts are named after
 * what you get: columns side by side, rows stacked, one big pane on the left or on top,
 * or everything the same size.
 *
 * `tiled` is what the grid has always done and stays the default, so nobody's window
 * changes shape because this exists.
 */
export type LayoutKind = 'tiled' | 'columns' | 'rows' | 'main-left' | 'main-top'

export const LAYOUTS: LayoutKind[] = ['tiled', 'columns', 'rows', 'main-left', 'main-top']

export const LAYOUT_LABEL = {
  tiled: 'Tiled',
  columns: 'Columns',
  rows: 'Rows',
  'main-left': 'Big left',
  'main-top': 'Big top'
}

/** Whether a string off disk is still one of the layouts this build knows. */
export function isLayout(x: string): boolean {
  for (const k of LAYOUTS) if (k === x) return true
  return false
}

/** The next layout in the cycle, wrapping. */
export function nextLayout(kind: LayoutKind): LayoutKind {
  const i = LAYOUTS.indexOf(kind)
  return LAYOUTS[(i + 1) % LAYOUTS.length]
}

/**
 * Move one pane along the order the cells are filled from, and return the new order.
 *
 * The grid has always been re-arrangeable by dragging one pane onto another, which is a
 * mouse and a steady hand; tmux marks a pane and swaps it with a key. This is the key.
 *
 * Two decisions, both taken from the drag rather than invented here. It **swaps** with
 * the pane `delta` slots away instead of lifting one out and re-inserting it: inserting
 * shuffles every pane after the drop into a different cell, so three panes nobody asked
 * about would move (`App.tsx`'s drag says the same thing at more length). And it moves by
 * SLOTS in this list, not by "one cell left", because the five layouts fill their cells
 * from the list - "left" means nothing at all in `rows`, and something different in
 * `main-left` for the first pane than for the other four.
 *
 * Off either end is a no-op rather than a wrap. Wrapping would fling the pane you are
 * holding to the far corner on a key you were leaning on, and a layout has no undo.
 */
export function moveInOrder(ids: string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return ids
  const to = from + delta
  if (to < 0 || to >= ids.length) return ids
  const next = ids.slice()
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** One pane's cell, in 1-based CSS grid lines. */
export interface Cell {
  col: number
  row: number
  colSpan: number
  rowSpan: number
}

export interface GridPlan {
  cols: number
  rows: number
  /** Where each pane goes, in the order the sessions are in. */
  cells: Cell[]
}

/**
 * How many tracks a layout needs for `n` panes, and which cell each pane lands in.
 *
 * Explicit cells rather than letting the grid auto-place, because two of the five
 * layouts have a pane that spans: `main-left` is one pane down the whole left side with
 * the rest stacked beside it, and auto-placement cannot express that. The other three
 * come out exactly where auto-placement would have put them, so the placement is uniform
 * and there is one code path in the renderer instead of two.
 *
 * One pane is one pane in every layout - a "big left" of one is a full window, not a
 * half-empty grid - so `n === 1` short-circuits before any of the shapes are considered.
 */
export function planGrid(kind: LayoutKind, n: number, maxCols = Infinity): GridPlan {
  const cells: Cell[] = []
  if (n <= 0) return { cols: 1, rows: 1, cells }

  if (kind === 'tiled' || n === 1) {
    // Near-square, the rule the grid has used since it was a .bat file - but never more
    // columns than the box holds readable tiles across (`gridCols`): four panes in a
    // 618px box are one column of four, not a 2x2 of 300px tiles.
    const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(n)), maxCols))
    const rows = Math.max(1, Math.ceil(n / cols))
    for (let i = 0; i < n; i++)
      cells.push({ col: (i % cols) + 1, row: Math.floor(i / cols) + 1, colSpan: 1, rowSpan: 1 })
    return { cols, rows, cells }
  }

  if (kind === 'columns') {
    for (let i = 0; i < n; i++) cells.push({ col: i + 1, row: 1, colSpan: 1, rowSpan: 1 })
    return { cols: n, rows: 1, cells }
  }

  if (kind === 'rows') {
    for (let i = 0; i < n; i++) cells.push({ col: 1, row: i + 1, colSpan: 1, rowSpan: 1 })
    return { cols: 1, rows: n, cells }
  }

  if (kind === 'main-left') {
    const rows = n - 1
    cells.push({ col: 1, row: 1, colSpan: 1, rowSpan: rows })
    for (let i = 1; i < n; i++) cells.push({ col: 2, row: i, colSpan: 1, rowSpan: 1 })
    return { cols: 2, rows, cells }
  }

  const cols = n - 1
  cells.push({ col: 1, row: 1, colSpan: cols, rowSpan: 1 })
  for (let i = 1; i < n; i++) cells.push({ col: i, row: 2, colSpan: 1, rowSpan: 1 })
  return { cols, rows: 2, cells }
}

/**
 * What the main pane is worth before anybody drags a divider.
 *
 * Equal shares would make "big left" a lie for two panes - a 50/50 split is what tiled
 * already does - so the layouts with a main pane start it at 62% of its axis. Everything
 * else starts equal, and a dragged size beats both.
 */
export const MAIN_SHARE = 0.62

export function layoutDefaults(kind: LayoutKind, cols: number, rows: number): GridSize {
  const split = (n: number): Fractions => [MAIN_SHARE * n, (1 - MAIN_SHARE) * n]
  if (kind === 'main-left' && cols === 2) return { cols: split(2), rows: equal(rows) }
  if (kind === 'main-top' && rows === 2) return { cols: equal(cols), rows: split(2) }
  return { cols: equal(cols), rows: equal(rows) }
}

/**
 * The key a dragged layout is saved under.
 *
 * Tiled keeps the bare `3x2` it has always used, so no saved layout is lost to this
 * change. The others are prefixed: a `2x3` reached by stacking three panes next to a big
 * one is not the same arrangement as a tiled `2x3`, and sharing a key would apply one's
 * column widths to the other.
 */
export const shapeKey = (cols: number, rows: number, kind: LayoutKind = 'tiled'): string =>
  kind === 'tiled' ? `${cols}x${rows}` : `${kind}:${cols}x${rows}`

/** n equal tracks: the default, and what a double-click on a divider goes back to. */
export const equal = (n: number): Fractions => Array(n).fill(1)

/**
 * The stored fractions for a shape, made safe to use.
 *
 * A saved layout can be the wrong length - the grid was 3x2 when it was saved and the
 * window now holds 3x3 - and a saved zero or NaN would collapse a track to nothing with no
 * way to drag it back. Anything that does not fit is the fallback, which is equal shares
 * unless the layout has a main pane, so a bad value costs a layout and never a usable grid.
 */
export function usable(f: Fractions | undefined, n: number, fallback: Fractions = equal(n)): Fractions {
  if (!f || f.length !== n || f.some((x) => !Number.isFinite(x) || x <= 0))
    return fallback.length === n ? fallback : equal(n)
  const sum = f.reduce((a, b) => a + b, 0)
  // Normalised to sum to n so one track's fraction reads as "how many equal panes wide".
  return f.map((x) => (x * n) / sum)
}

/** Pixel size of each track, given the box they share and the gap between them. */
export function trackPx(f: Fractions, total: number, gap: number): number[] {
  const usable = Math.max(0, total - gap * (f.length - 1))
  const sum = f.reduce((a, b) => a + b, 0) || 1
  return f.map((x) => (usable * x) / sum)
}

/**
 * Where the line between track i and track i+1 sits, measured from the start of the box.
 * The middle of the gap, which is the middle of the thing being grabbed.
 */
export function dividerPx(f: Fractions, total: number, gap: number, i: number): number {
  const px = trackPx(f, total, gap)
  let at = 0
  for (let k = 0; k <= i; k++) at += px[k] + (k < i ? gap : 0)
  return at + gap / 2
}

/**
 * Move the line between track i and i+1 by `deltaPx`, and return the new fractions.
 *
 * Only those two tracks change and their total is preserved, so dragging one divider never
 * moves any other pane on the screen - which is the whole reason this is not a general
 * layout solver. Neither side may go below MIN_TRACK_PX; pushing past that stops at the
 * limit rather than swapping the two tracks round.
 */
export function drag(f: Fractions, total: number, gap: number, i: number, deltaPx: number): Fractions {
  const px = trackPx(f, total, gap)
  const pair = px[i] + px[i + 1]
  if (pair <= 0) return f
  const min = Math.min(MIN_TRACK_PX, pair / 2)
  const left = Math.max(min, Math.min(pair - min, px[i] + deltaPx))
  const share = f[i] + f[i + 1]
  const next = f.slice()
  next[i] = (share * left) / pair
  next[i + 1] = share - next[i]
  return next
}

/** CSS for one axis. */
export const template = (f: Fractions): string => f.map((x) => `${x}fr`).join(' ')

// -------------------------------------------------- how many panes a grid can show

/**
 * The smallest tile a terminal is still readable in. 440px is 60 columns at the 7px a
 * 12px monospace glyph takes, plus the pane's own chrome; 240px is a header, ten rows
 * and the CLI's composer. Below either the pane draws a torn CLI that nobody can read
 * or act on, which is what fourteen panes in a 4x4 grid on a 1280px window was
 * (Robert 2026-09-10: "if i open it now its super small since so many sessions").
 */
export const MIN_PANE_W = 440
export const MIN_PANE_H = 240

/** How many readable tiles fit across a box `w` wide. Never 0; an unmeasured box is unbounded. */
export function gridCols(w: number, gap: number): number {
  if (!(w > 0)) return Infinity
  return Math.max(1, Math.floor((w + gap) / (MIN_PANE_W + gap)))
}

/** How many readable tiles fit in a box of `w` x `h` with `gap` between them. Never 0. */
export function gridRoom(w: number, h: number, gap: number): number {
  if (!(w > 0) || !(h > 0)) return Infinity
  const rows = Math.max(1, Math.floor((h + gap) / (MIN_PANE_H + gap)))
  return gridCols(w, gap) * rows
}

/**
 * Which panes the grid shows when there are more than fit: the ones that need a
 * person first, then the ones printing, then the quiet ones, and a pane whose agent is
 * asleep last - its screen is not moving, so hiding it loses nothing. Order inside a
 * rank is the desk's own, so a pane does not jump cells because another finished. The
 * active pane is always shown. The rest stay in the list on the left, where a press on
 * one makes it active and so brings it into the grid.
 */
export type GridPane = { id: string; rank: number }
export interface GridChoice {
  shown: string[]
  hidden: number
}
export function gridPick(panes: GridPane[], max: number, activeId: string | undefined): GridChoice {
  if (panes.length <= max) return { shown: panes.map((p) => p.id), hidden: 0 }
  const kept = panes
    .map((p, i) => ({ ...p, i, rank: p.id === activeId ? -1 : p.rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, Math.max(1, max))
    .sort((a, b) => a.i - b.i)
  return { shown: kept.map((p) => p.id), hidden: panes.length - kept.length }
}
