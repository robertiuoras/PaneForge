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

export const shapeKey = (cols: number, rows: number): string => `${cols}x${rows}`

/** n equal tracks: the default, and what a double-click on a divider goes back to. */
export const equal = (n: number): Fractions => Array(n).fill(1)

/**
 * The stored fractions for a shape, made safe to use.
 *
 * A saved layout can be the wrong length - the grid was 3x2 when it was saved and the
 * window now holds 3x3 - and a saved zero or NaN would collapse a track to nothing with no
 * way to drag it back. Anything that does not fit is equal shares, which is the old
 * behaviour, so a bad value costs a layout and never a usable grid.
 */
export function usable(f: Fractions | undefined, n: number): Fractions {
  if (!f || f.length !== n || f.some((x) => !Number.isFinite(x) || x <= 0)) return equal(n)
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
