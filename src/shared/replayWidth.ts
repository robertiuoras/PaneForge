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
 * So the replay is written at the width those bytes were painted for, and the terminal
 * is put back afterwards - xterm re-wraps what is already in its buffer, so a 159-column
 * line becomes two 85-column rows with the sentence intact.
 *
 * **The recorded width is not that width.** `history/<id>.json` is written at launch
 * (START_COLS) and again only at a clean end, so every crash or watchdog relaunch records
 * 120 over a log that paints to 156 - 9 of 9 live panes on this machine, measured
 * 2026-09-19 - and even a clean end records the LAST width, not the one the tail was
 * painted at (71 of 71 Claude Code logs here paint to 154-157 against a recorded 80-120).
 * So the width is `max(recorded, paintedWidth(the bytes))`: the bytes say what they were
 * drawn for and cannot be stale.
 *
 * Rows travel too. Claude Code and Codex draw in absolute column moves and do not care
 * how tall the terminal is; antigravity's frame is cursor-UP arithmetic against the
 * terminal HEIGHT, and the same bytes at the same width lose 50/59/51/83 logical lines at
 * 24/30/47/56 rows and none at the 40 they were painted at.
 *
 * Only the part BEFORE the restore mark is old-width - everything after it was printed by
 * this pane's own new process, at this pane's own size. A buffer with NO mark in it is all
 * old: the mark is written by the restore, and a pane that has printed past it has pushed
 * it out of the ring buffer.
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
  /** the height it was painted at, or undefined when nothing recorded one */
  rows?: number
}

/**
 * The widest column these bytes ADDRESS: `CSI n G` (CHA) and the column of `CSI r;c H` /
 * `f` (CUP). 0 when they name none, which is a CLI that only wraps.
 *
 * One linear scan with one regex - this runs on the replay path of every reopened pane,
 * before a byte is written, over as much as 400 KB.
 */
export function paintedWidth(bytes: string): number {
  let max = 0
  MOVES.lastIndex = 0
  for (let m = MOVES.exec(bytes); m; m = MOVES.exec(bytes)) {
    const col = m[1] === undefined ? Number(m[2]) : Number(m[1])
    if (col > max) max = col
  }
  return max
}

// eslint-disable-next-line no-control-regex
const MOVES = /\x1b\[(?:(\d{1,4})G|\d{1,4};(\d{1,4})[Hf])/g

/**
 * How to replay `bytes` into a terminal that is `now` columns wide, or null for "just
 * write it".
 *
 * The staged width is the wider of what was recorded and what the bytes themselves paint,
 * and `rows` is the height they were painted at, carried through untouched.
 *
 * Staged for either reason: the bytes want more COLUMNS than the pane has, or they were
 * painted at a different HEIGHT - antigravity prints no column move at all, so its frame
 * is never too wide and is ruined by the rows alone. A rows-only stage keeps the pane's
 * own width (`Math.max`), so nothing is ever written narrower than it already is.
 *
 * Null whenever there is nothing to gain or nothing to trust: no bytes, a terminal with no
 * width yet, nothing to widen and no height to correct, or a width too small to be a real
 * pane. A buffer with no restore mark in it is not a refusal - it is all old.
 */
export function splitReplay(
  bytes: string,
  wroteAt: number | undefined,
  now: number,
  rows?: number,
  nowRows?: number
): ReplaySplit | null {
  if (!bytes || !(now > 0)) return null
  // ONE PAST the widest move, because a pane exactly that wide still clamps the word
  // written AT its last column: measured 2026-09-19 on a real Claude log painting to 156,
  // replayed into a 90-column pane - staged at 156 it loses 20 logical lines, at 157 none.
  const painted = paintedWidth(bytes)
  const wide = Math.max(wroteAt ?? 0, painted ? painted + 1 : 0)
  if (wide < 20) return null
  const wrongHeight = Boolean(rows && rows > 0 && nowRows && nowRows > 0 && rows !== nowRows)
  if (wide <= now && !wrongHeight) return null
  const cols = Math.max(wide, now)
  // The LAST mark, not the first: a log tail can carry a mark from an earlier restart, and
  // everything before the newest one is old output either way.
  const i = bytes.lastIndexOf(RESTORE_MARK_TEXT)
  const cut = i === -1 ? bytes.length : i + RESTORE_MARK_TEXT.length
  return { before: bytes.slice(0, cut), after: bytes.slice(cut), cols, rows: rows && rows > 0 ? rows : undefined }
}
