/**
 * Where a copy affordance goes, and what it would copy.
 *
 * Two questions, both pure arithmetic, both kept out of the pane so they can be checked
 * without a window - the same reason `cursorMove.ts` and `rail.ts` live here.
 *
 * The first is the SELECTION chip: a highlight in a pty is not a DOM range, so there is no
 * element to hang a button off. All there is is a start cell and an end cell, and the chip
 * has to sit beside the FIRST line of the highlight - the shortest reach from anywhere in
 * the selection - without leaving the pane and without covering what was selected.
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
 * Directly ABOVE the FIRST selected line, left-aligned with where the highlight starts.
 * The end of the drag was the obvious anchor and it is the wrong one: the finger has to
 * travel the whole length of the selection to get back to it, and on a multi-line highlight
 * that is most of the pane. The start of the selection is where the eye already is, and
 * above the line rather than below it means the chip never covers the text that was just
 * highlighted.
 *
 * No room above (the selection starts on the top row) is the one case it drops BELOW the
 * first line - still beside the start, never the far end. A chip that would leave the
 * bottom of the pane is pulled back in, because the composer is the one row that must stay
 * visible.
 *
 * Returns null for an empty selection - there is nothing to copy and nothing to point at.
 */
export function chipSpot(from: Cell, to: Cell, box: ChipBox): { left: number; top: number } | null {
  if (from.x === to.x && from.y === to.y) return null
  // A selection is reported start-before-end in buffer order, but a drag upwards can hand
  // them over the other way round, so take the earlier cell as the first line rather than
  // trusting the order.
  const first = to.y < from.y || (to.y === from.y && to.x < from.x) ? to : from
  const rows = Math.max(1, Math.floor(box.height / box.cellH))
  // The highlight can begin above the viewport on a scrolled pane; the chip still belongs
  // on screen, at the top of what is visible, rather than clamped to a row nobody can see.
  const row = Math.min(rows - 1, Math.max(0, first.y - box.viewportY))

  let left = first.x * box.cellW
  if (left + box.chipW > box.width) left = box.width - box.chipW - 6
  if (left < 0) left = 0
  let top = row * box.cellH - box.chipH - 4
  // Nothing above the first row: drop under it, still beside the start.
  if (top < 0) top = (row + 1) * box.cellH + 4
  if (top + box.chipH > box.height) top = Math.max(0, box.height - box.chipH - 4)
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
