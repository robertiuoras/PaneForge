/**
 * Where a copy affordance goes, and what it would copy.
 *
 * Two questions, both pure arithmetic, both kept out of the pane so they can be checked
 * without a window - the same reason `cursorMove.ts` and `rail.ts` live here.
 *
 * The first is the SELECTION chip: a highlight in a pty is not a DOM range, so there is no
 * element to hang a button off. All there is is a start cell and an end cell, and the chip
 * has to sit near the end of the drag - where the finger let go and where the eye already
 * is - without leaving the pane and without covering the last line of what was selected.
 *
 * The second is the BLOCK: an agent's reply has no markup either, so the only thing that
 * says where one turn ends and the next begins is the prompt markers the rail already
 * keeps. A block is the span from one prompt to the line before the next, which makes
 * "copy what the agent just said" answerable from a row number.
 */

/** A cell in the terminal's own coordinates: column, absolute buffer row. */
export interface Cell {
  x: number
  y: number
}

export interface ChipBox {
  /** Pixel size of one cell. */
  cellW: number
  cellH: number
  /** The pane's drawable area, in pixels. */
  width: number
  height: number
  /** First absolute buffer row on screen. */
  viewportY: number
  /** The chip's own size, so it can be kept inside the pane. */
  chipW: number
  chipH: number
}

/**
 * Where to draw the chip for a selection running `from` -> `to`.
 *
 * Below and just right of the last selected cell, which is where a drag ends and where
 * nothing has been read yet. When that would go off an edge the chip flips to the other
 * side of the cell rather than being clamped flat against the border: a chip pinned to the
 * bottom edge covers the composer, which is the one row of a pane that must stay visible.
 *
 * Returns null for an empty selection - there is nothing to copy and nothing to point at.
 */
export function chipSpot(from: Cell, to: Cell, box: ChipBox): { left: number; top: number } | null {
  if (from.x === to.x && from.y === to.y) return null
  // xterm reports the end column as one PAST the last selected cell, and a selection that
  // wrapped ends at column 0 of the next row. Either way the cell to point at is the one
  // before it, and on a wrap that is the end of the row above.
  const endX = to.x > 0 ? to.x - 1 : Math.max(0, box.width / box.cellW - 1)
  const endY = to.x > 0 ? to.y : to.y - 1
  const row = endY - box.viewportY

  let left = (endX + 1) * box.cellW + 6
  let top = (row + 1) * box.cellH + 4
  if (left + box.chipW > box.width) left = box.width - box.chipW - 6
  if (left < 0) left = 0
  // Flip above the line rather than clamp: see above.
  if (top + box.chipH > box.height) top = row * box.cellH - box.chipH - 4
  if (top < 0) top = 0
  return { left: Math.round(left), top: Math.round(top) }
}

export interface Block {
  /** Absolute buffer row the prompt itself is on. */
  from: number
  /** Last absolute buffer row of this turn, inclusive. */
  to: number
  /** Index into the marks that were passed in. */
  index: number
}

/**
 * The turn that contains `row`, given the prompt rows in ascending order.
 *
 * `lastRow` is the last row that has anything on it, so the newest turn - the one with no
 * prompt after it - ends at the tail rather than running off the end of the buffer.
 *
 * A row ABOVE the first prompt is not a turn: it is whatever the CLI printed on startup,
 * or scrollback from before the marks were kept. Answering null there is deliberate -
 * offering "copy this reply" over a banner would copy the wrong thing silently.
 */
export function blockFor(promptRows: number[], row: number, lastRow: number): Block | null {
  const rows = promptRows.filter((r) => r >= 0).sort((a, b) => a - b)
  if (!rows.length || row < rows[0]) return null
  let i = 0
  while (i + 1 < rows.length && rows[i + 1] <= row) i++
  const to = i + 1 < rows.length ? rows[i + 1] - 1 : lastRow
  return { from: rows[i], to: Math.max(rows[i], to), index: i }
}
