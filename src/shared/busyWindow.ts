/**
 * Where the busy read starts: the bottom `rows` rows, or higher when a tall composer
 * has pushed the working line above them.
 *
 * s15-mucz8c8j, 2026-09-22 18:03: a 698-character prompt sat unsent in Claude Code's box -
 * 15 rows of it, plus a 4-row footer - and the spinner `✻ Frolicking… (4m 21s)` sat 23
 * rows from the bottom. A 16-row read found nothing, main ended the turn, and the card
 * said "your move" for six minutes while the agent worked. The working line is drawn
 * directly above the composer's top rule, so the window reaches that far up whatever the
 * composer holds.
 */
const RULE = /^\s*[─━]{8,}\s*$/
const MARKER = /^\s*[❯›>](?:[ \u00a0]|$)/
/** How far above the composer's rule the working line can be (queued messages, a tip). */
const ABOVE_BOX = 8
/** How far up a composer is looked for at all. */
const MAX_UP = 60

export function busyWindowStart(read: (row: number) => string, last: number, rows: number): number {
  const bottom = Math.max(0, last - rows + 1)
  for (let r = last; r > Math.max(0, last - MAX_UP); r--) {
    if (MARKER.test(read(r)) && RULE.test(read(r - 1))) return Math.max(0, Math.min(bottom, r - 1 - ABOVE_BOX))
  }
  return bottom
}
