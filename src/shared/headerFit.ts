/**
 * How much of a pane's header fits, decided by what it MEASURES rather than by how wide
 * the pane is.
 *
 * The header used to drop its controls on container-width breakpoints: below 760px the
 * clear button, the folder button, restart, fix and the git badge all went behind the ⋯,
 * below 560px the agent picker went too. That is right for a pane in a grid and wrong for
 * the app in a narrow window, which is the same width and almost entirely EMPTY: a pane
 * called `PaneForge` leaves ~400px of nothing between its name and the clock, and the two
 * controls a person reaches for most - clear, and open the folder - were in a menu anyway.
 * Robert, 2026-09-04, looking at a 700px window: "we have a lot of space in this top bar
 * ... theres enough space to have the most important buttons available in that header".
 *
 * So the ladder is the same and the trigger is different: the row is drawn whole, its
 * parts are measured once each, and a level is chosen from the space actually left. A long
 * pane name takes controls off the line exactly as a narrow window does, which is the same
 * arithmetic and the honest one.
 *
 * Pure, so `scripts/header-fit-test.mjs` runs it with no window.
 */

/** The narrowest a pane's name may be squeezed before a control is dropped instead. */
export const NAME_MIN = 110

/**
 * A few pixels of slack, so a header that is one pixel from its own threshold does not
 * flip a control in and out on every resize frame.
 */
export const SLACK = 8

/**
 * The lowest rung that FITS, asked of the row itself.
 *
 * The first version of this measured each part and did the arithmetic. It cannot work: a
 * header is a flex row, so once it is too narrow its own children are already shrunk, and
 * every width read back is the squeezed one - the row measures as fitting at 196px while
 * it wants 536px, which is exactly what `npm run test:cardfit` caught. So the question is
 * asked of the layout instead, one rung at a time from the top, and `probe(level)` answers
 * "does the row fit like this" after the browser has re-laid it out.
 *
 * `max` rungs is the end of the ladder: a header too narrow for its own name still draws
 * the name, because a control drawn off the edge of a pane cannot be pressed and nothing
 * says it is there.
 */
export function climbLevel(probe: (level: number) => boolean, max: number): number {
  for (let level = 0; level < max; level++) if (probe(level)) return level
  return max
}

/**
 * The ladder itself: which controls go at which rung, worst-first.
 *
 * Order is what a person reaches for, not what is easy to hide. The folder path and the
 * memory chip are said elsewhere on screen, so they go first; the git badge, handoff chip,
 * zoom, editor, fix and restart each open something else or repeat a chip; the agent
 * picker is the fat control that is not a control in a small pane. **Clear and open the
 * folder are the last two to go**, because they are the presses Robert makes without
 * thinking. The agent's mark goes last of all - by then the name is all that is left.
 *
 * Each entry is a CSS selector, relative to the header, that `styles.css` hides at the
 * matching `data-tight` level. The two lists are one fact and must not disagree: the test
 * reads both.
 */
export const TIGHT_GROUPS: ReadonlyArray<readonly string[]> = [
  ['.pt-path', '.chip.res', '.pt-open'],
  ['.git-badge', '.pt-handoff', '.pt-zoom', "[data-pt='editor']", '.icon.fix', '.pt-restart'],
  ['.agent-pick'],
  ['.pt-clear', '.pt-reveal'],
  ['.agent-logo']
]

/** From which rung the ⋯ has to be on the row, because something is now behind it. */
export const MORE_FROM = 2
