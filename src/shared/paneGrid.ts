/**
 * The grid a pane starts life at, on BOTH ends of it.
 *
 * A pane is two things that each have a size: the pty in main, spawned before anything
 * has been measured, and the xterm in the renderer, created before its host element has
 * been laid out. Until the first fit lands they are guesses - and for as long as the two
 * guesses DISAGREE, every byte the CLI prints is drawn at the pty's width into a grid of
 * the terminal's width.
 *
 * That is not a cosmetic beat. Measured 2026-08-23 against this machine's own pane log:
 * the pty spawned at 120 columns, xterm opens at its library default of 80, and a
 * `claude --resume` dumps the whole conversation the moment it starts - so an answer
 * drawn in absolute column moves out to column 119 landed in an 80-column grid, where a
 * terminal CLAMPS a column it cannot reach and piles word on word at the right-hand
 * edge. The pane then fitted to 157 and the wreckage froze there: xterm can unwrap a row
 * it wrapped itself, but nothing can undo a clamp. Replaying that log at 80 and widening
 * to 157 reproduces the reported screen exactly; replaying it at 120 and widening does
 * not, and neither does any width at or above the pty's.
 *
 * So the two ends open at the same number and the first fit moves both. The value itself
 * is not important - what matters is that only ONE of them exists. See
 * `shared/replayWidth.ts` for the same failure with a restored pane's old bytes.
 */
export const START_COLS = 120
export const START_ROWS = 30
