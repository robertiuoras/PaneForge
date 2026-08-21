/**
 * Replaying a pane's own bytes at the width they were PAINTED at.
 *
 * A restored pane comes back with what was on its screen (`restoredTail` in
 * `main/sessions.ts`): the raw tail of its log, written into a fresh xterm. Those bytes
 * are not text. Every agent CLI here draws with ABSOLUTE column moves - measured off this
 * machine's own log on 2026-08-22, one line of a Claude Code answer is
 *
 *   `Cause:\x1b[10G\x1b[1mTLS/JA3 ...\x1b[50G\x1b[22mProbed\x1b[57Gthe\x1b[61G12 ...`
 *
 * out to `\x1b[143G`, because the pane was 159 columns wide. A terminal CLAMPS a column
 * move to its own last column, so replaying that into an 85-column pane piles every jump
 * past 85 onto the right-hand edge, one word on top of the last. That is the report: the
 * text at the top of a reopened pane is interleaved nonsense, half of it right-aligned.
 *
 * **And Fix cannot repair it.** `runRestoreFix` asks the CLI to repaint, which redraws the
 * SCREEN; the mangled rows are in the scrollback, where the agent has nothing to say. The
 * pane had a comment saying the replay "regularly arrives at the wrong width" and answered
 * it with that repaint, which fixes the live frame and leaves the history broken for good.
 *
 * So the replay is written at the width it was written at, and the terminal is put back
 * afterwards - xterm re-wraps what is already in its buffer, so a 159-column line becomes
 * two 85-column rows with the sentence intact. Measured with a real headless xterm over
 * the real bytes (`scripts/replay-width-test.mjs`): written at 85 the sentence is
 * destroyed, written at 159 and resized to 85 it reads back whole.
 *
 * Only the part BEFORE the restore mark is old-width - everything after it was printed by
 * this pane's own new process, at this pane's own size - which is why the mark is required
 * rather than assumed. Once a pane has printed enough to push the mark out of the ring
 * buffer there is nothing old left in it, and this must then do nothing at all.
 */

/**
 * The dim caption `restoredTail` puts between the old pane's output and the new process's.
 * Here rather than in `main/sessions.ts` because the renderer has to find it to know where
 * the old width stops applying, and two copies of this string is the kind of drift that
 * shows up as a pane full of garbage rather than as an error.
 */
export const RESTORE_MARK_TEXT = '—— above: this pane before the restart ——'

export interface ReplaySplit {
  /** everything up to and including the restore mark: painted at `cols` */
  before: string
  /** what this pane's own process has printed since: painted at the pane's real width */
  after: string
  /** the width `before` was painted at */
  cols: number
}

/**
 * How to replay `bytes` into a terminal that is `now` columns wide, or null for "just
 * write it".
 *
 * Null whenever there is nothing to gain or nothing to trust: no recorded width, a width
 * that already matches, a width too small to be a real pane, or a buffer with no restore
 * mark in it (a live pane's own output, or a restored one that has since printed past it).
 */
export function splitReplay(bytes: string, wroteAt: number | undefined, now: number): ReplaySplit | null {
  if (!bytes || !wroteAt || wroteAt < 20 || !(now > 0) || wroteAt === now) return null
  // The LAST mark, not the first: a log tail can carry a mark from an earlier restart, and
  // everything before the newest one is old output either way.
  const i = bytes.lastIndexOf(RESTORE_MARK_TEXT)
  if (i === -1) return null
  const cut = i + RESTORE_MARK_TEXT.length
  return { before: bytes.slice(0, cut), after: bytes.slice(cut), cols: wroteAt }
}
