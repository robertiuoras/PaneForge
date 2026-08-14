/**
 * Which turns get a copy button, and where it goes.
 *
 * A pane draws a pair of copy icons beside every prompt that is on screen - the prompt
 * itself, and the answer it got. That used to follow the pointer, and the pointer version
 * is unusable: the pair is anchored to the row the turn STARTS on, so reaching for it
 * means crossing rows that belong to the turn before, which is a different turn, which
 * moves the buttons. Drawing every visible turn instead means nothing moves while a hand
 * is on the way to it, and the arithmetic stops depending on where the mouse is - which is
 * what lets it live out here and be checked without a window, the same as `rail.ts` and
 * `copyChip.ts`.
 *
 * Two rules, both about crowding rather than about copying:
 *  - a pair is drawn whole or not at all, because half a button hanging off the top edge
 *    points at a line that is not on screen;
 *  - two prompts a couple of rows apart cannot both have a pair, so the NEWER one keeps
 *    the space. It is the one being read, the rail still reaches the older prompt, and
 *    scrolling them apart brings the older pair back.
 */

export interface TurnGeom {
  /** First absolute buffer row on screen. */
  viewportY: number
  /** Pixel height of one row. */
  cellH: number
  /** Where the rows start inside the pane, in pane pixels. */
  offY: number
  /** How tall the drawn rows are. */
  height: number
}

export interface TurnCopy {
  /** Absolute buffer row the prompt is on. */
  row: number
  /** Pane pixels from the top of the wrap. */
  top: number
  /** Last absolute row of this turn, inclusive - the reply runs to here. */
  to: number
}

/**
 * `promptRows` in any order; `lastRow` is the last row with anything on it, so the newest
 * turn ends at the tail rather than running off the end of the buffer. `stackH` is how
 * tall one pair is - it differs between a pointer and a finger, so it is passed in.
 *
 * Newest first, which is the order the crowding rule needs.
 */
export function placeTurnCopies(
  promptRows: number[],
  geom: TurnGeom,
  stackH: number,
  lastRow: number
): TurnCopy[] {
  if (!(geom.cellH > 0)) return []
  const rows = [...new Set(promptRows.filter((r) => r >= 0))].sort((a, b) => a - b)
  const out: TurnCopy[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    const top = (row - geom.viewportY) * geom.cellH + geom.offY
    if (top < geom.offY - 1 || top + stackH > geom.offY + geom.height) continue
    const newer = out[out.length - 1]
    if (newer && newer.top - top < stackH + 4) continue
    out.push({ row, top, to: i + 1 < rows.length ? rows[i + 1] - 1 : lastRow })
  }
  return out
}
