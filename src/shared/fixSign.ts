/**
 * What a pane's screen looks like at the moment somebody presses Fix.
 *
 * Fix repairs a torn pane, and it does - but nothing ever recorded what the pane looked
 * like BEFORE the press, so "panes break more often than they should" (Robert,
 * 2026-09-03) could not be answered: a resize storm on an idle pane and a resize storm on
 * a streaming pane were both driven in a test copy that day and neither tore anything.
 * The trigger is something else, and the only way to learn it is to look at the screen
 * the person is looking at when they reach for the button. This is that reading, kept
 * small enough to write on every press: counts, never rows.
 *
 * `footers` is the tell for a torn frame: a CLI draws one footer (`esc to interrupt`,
 * `? for shortcuts`, `bypass permissions on`) on its live frame and erases it on the next
 * paint, so a pane whose buffer holds more than one has old frames left behind in its
 * scrollback. `rules` counts the horizontal rules an agent's input box is drawn with,
 * for the same reason. `edge` counts rows that run to the terminal's last column, which
 * is what bytes painted for a wider grid and clamped into this one look like (see
 * `shared/paneGrid.ts`).
 */
export interface FixSignature {
  footers: number
  rules: number
  edge: number
  rows: number
}

const FOOTER = /esc to interrupt|\? for shortcuts|bypass permissions on|shift\+tab to cycle/
const RULE = /^[\s]*[─━]{20,}/

export function fixSignature(lines: string[], cols: number): FixSignature {
  let footers = 0
  let rules = 0
  let edge = 0
  for (const raw of lines) {
    const s = raw.replace(/\s+$/, '')
    if (!s) continue
    if (FOOTER.test(s)) footers++
    if (RULE.test(s)) rules++
    if (cols > 0 && s.length >= cols) edge++
  }
  return { footers, rules, edge, rows: lines.length }
}
