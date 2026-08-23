// How a mirrored pane is drawn at somebody else's grid.
//
// The host owns the terminal's size - a mirror that resized the pty would trade
// SIGWINCHes with the far end forever - so this window has exactly one lever: how
// SMALL it draws that grid. It shrinks its font until the host's cols x rows fit.
//
// Two things were wrong with doing that in one line inside the component, and both
// are visible in the arithmetic rather than in a screenshot (2026-08-23, Robert:
// "when i have a remote viewing its half way cut across the screen ... the terminal
// looks broken with text"):
//
//   1. The step was `Math.round(current * k)`. A grid 4% too wide asks for 11.4px
//      from 12px, which rounds back to 12 - no change - and the caller reads "no
//      change" as CONVERGED. Measured: 159 cols into the space for 152 stalls at
//      font 11 with the last columns off screen, permanently. A shrink must always
//      shrink, so the step floors.
//
//   2. Below MIN_FONT there was nothing left to do and the code did nothing, which
//      leaves the pane drawing a grid wider than itself - the cut. 159 cols into the
//      space for 120 walks 10 -> 8 -> 6 and stops there still overflowing. A mirror
//      that shows two thirds of the far end's screen is worse than a small one: the
//      wrapped lines of a CLI drawn past the right edge are the "broken text". So
//      the last of the shrinking is done by SCALING the whole terminal element, which
//      has no lower bound and which xterm's own hit testing already understands
//      (it reads getBoundingClientRect, which includes transforms).

/** Smallest font worth setting. Below this, scaling takes over. */
export const MIN_FONT = 6

/**
 * The biggest a mirror may draw somebody else's grid, whatever the room.
 *
 * A mirror was capped at the USER's own font, which is right when the far end's grid is
 * the bigger of the two and wrong the moment it is smaller. Measured live 2026-08-23
 * against the PC: its pane is 69x35 (its window is small - the desk is a disconnected
 * RDP session), the Mac pane had room for 152x58 at 13px, and the cap meant the far
 * end's screen was drawn 518x525 inside 1191x880 - a small block of text in the top-left
 * corner of a mostly black pane, reported as the remote view being broken. There is
 * nothing else to put in that space: the pane IS that one screen, so it should fill it.
 *
 * A ceiling is still needed, because a host reporting a 20x5 grid would otherwise ask
 * for a font of ~90px and read as a fault of its own.
 */
export const MAX_FILL_FONT = 28

export interface MirrorFitIn {
  /** cols x rows this window has room for at the CURRENT font */
  fitCols: number
  fitRows: number
  /** the grid the host is drawing */
  hostCols: number
  hostRows: number
  /** the font this pane is set to right now */
  font: number
  /** the user's own font size - the size a mirror prefers when the grid fits as-is */
  maxFont: number
  /**
   * How big this pane may grow the font to FILL itself when the host's grid is smaller
   * than the room. Omitted (or below `maxFont`) keeps the old behaviour exactly: the
   * user's own font is the ceiling. Capped at `MAX_FILL_FONT`.
   */
  fillFont?: number
}

export interface MirrorFitOut {
  /** the font to set now; equal to `font` when nothing should change */
  font: number
  /**
   * 1 when the font alone is enough. Below 1 the terminal element is scaled by
   * this much so the whole host grid is on screen at a readable-or-not size,
   * rather than a portion of it at a readable one.
   */
  scale: number
}

/**
 * One step towards the right size, not the answer.
 *
 * `proposeDimensions()` answers for the font that is set right now, so the ratio it
 * implies is a step; the observer that called this runs again on the layout that
 * results. What makes the walk terminate is that the step never rounds UP.
 */
/**
 * The floors the CALLER applies to `t.resize`, mirrored here so this answers about the
 * grid that will actually be drawn. A host reporting 8 columns is resized to 20, and
 * asking this about 8 would size the font for a grid that does not exist.
 */
export const MIN_COLS = 20
export const MIN_ROWS = 5

export function mirrorFit(i: MirrorFitIn): MirrorFitOut {
  const hostCols = Math.max(MIN_COLS, i.hostCols)
  const hostRows = Math.max(MIN_ROWS, i.hostRows)
  const maxFont = Math.max(MIN_FONT, i.maxFont)
  // The ceiling: the user's font, or the fill ceiling when this pane was told it may
  // grow past it. `Math.min` with MAX_FILL_FONT is what stops a tiny host grid asking
  // for a font nobody would call a terminal.
  const ceiling = Math.max(maxFont, Math.min(MAX_FILL_FONT, i.fillFont ?? maxFont))

  if (!(i.fitCols > 0) || !(i.fitRows > 0)) return { font: i.font, scale: 1 }

  const k = Math.min(i.fitCols / hostCols, i.fitRows / hostRows)

  // FLOOR IN BOTH DIRECTIONS, and the grow half is the one that is easy to get wrong.
  //
  // Shipped was `Math.round` both ways, which STALLS: 159 columns in the room for 158
  // at 12px asks for 11.92, rounds back to 12, and the caller reads "no change" as
  // converged with the last column past the edge.
  //
  // The obvious repair - floor on the way down, round on the way up - is worse, and
  // this is the trap worth writing down. From 12 it floors to 11; at 11 there is room
  // for 172 columns, so k is 1.08 and round asks for 12; at 12 it floors to 11 again.
  // 11, 12, 11, 12 ... every frame, a mirrored pane re-wrapping and repainting for
  // ever, which is a far worse "the terminal looks broken with text" than the cut.
  //
  // Flooring a grow means a pane only takes a whole extra pixel when a whole extra
  // pixel genuinely fits, so the walk has a fixed point instead of a cycle. It still
  // returns to the user's own size the moment the room is really there.
  const want = Math.floor(i.font * k)
  const font = Math.max(MIN_FONT, Math.min(ceiling, want))

  // The scale is only ever read off a measurement taken AT the floor font. Deriving
  // it on the way down uses a `k` measured at 13px to describe a pane that is about
  // to be drawn at 6, which asks for a scale that is not needed - and then drops it
  // on the next frame, so it flaps 0.83, 1.00, 0.83 exactly like the font used to.
  // At the floor, `k` is the honest fraction of the host grid that fits.
  const atFloor = i.font <= MIN_FONT
  const scale = atFloor && k < 1 ? clamp01(k) : 1
  return { font, scale }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0.05
  return Math.min(1, n)
}
