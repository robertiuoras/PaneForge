/**
 * Finding the prompts in a pane that came back from disk.
 *
 * The rail's tags are made from KEYSTROKES on their way to the pty, which is what makes
 * them work for every agent - and it is also why a reopened pane has none. Restoring a
 * pane replays bytes into the terminal; nobody typed anything, so `feedDraft` never fires
 * and the rail is empty for the whole conversation that was just brought back. The app
 * restarts itself for every update and `restoreAfterRestart` is on, so in practice most
 * panes on this desk carry no tags at all: "the tag to scroll to my prompt does nothing"
 * is, most of the time, "there is no tag".
 *
 * What CAN be recovered is the CLI's own echo of what was submitted. Measured in a live
 * Claude Code pane on Windows 2026-08-18, a submitted prompt is drawn on its own line as
 * `❯ what is 2+2` - the same line the marker had anchored to (line 26 for the mark, line
 * 26 for the echo). So a restored buffer is scanned for those and the rail is rebuilt.
 *
 * Deliberately ONE marker, `❯`, and deliberately not `>`:
 *
 *   - `❯` is what Claude Code draws and nothing else on screen starts a line with it.
 *   - `>` starts a quoted line, a diff line, a shell prompt and a markdown blockquote in
 *     an ANSWER. A false tag is worse than a missing one here: the rail's promise is that
 *     its tags are the prompts, and burying six real ones under thirty quoted lines is how
 *     a feature stops being read. An agent whose echo this does not recognise is left
 *     exactly as it is today - no tags on a restored pane, and every tag from then on.
 *   - The live composer draws its own `❯` INSIDE a box (`│ ❯ typing...`), so only spaces
 *     may precede the marker: a framed line is refused.
 *
 * `npm run test:promptecho`.
 */

/** Up to four leading spaces, the marker, a space, then something worth tagging. */
const ECHO = /^ {0,4}❯ {1,3}(\S.*)$/

/**
 * A run of the box-drawing rule a CLI paints its frames and separators with.
 *
 * A replayed buffer is full of TORN rows: the CLI redraws its whole prompt block several
 * times per turn and the bytes of one repaint land across the bytes of the last, so a row
 * regularly holds the start of an echo and the tail of a rule or of tool output. Measured
 * against this desk's own logs 2026-08-24 (see `npm run test:promptecho`) that produced
 * `❯ also when i epen historymasd the previous session...` - one ask, with a half-erased
 * earlier keystroke in it - tagged beside the finished copy of the same ask.
 */
const RULE = /─{3,}/

export function promptEcho(line: string): string {
  const m = ECHO.exec(line.replace(/\s+$/, ''))
  if (!m) return ''
  const text = m[1].trim()
  // Same floor as the live rail: a single character is a menu key, not an ask.
  return text.length > 1 ? text : ''
}

export interface SeededPrompt {
  /** Index into the rows that were scanned. */
  line: number
  text: string
}

/**
 * Every prompt worth a rail tag in a replayed screen, at the row it is drawn on.
 *
 * `promptEcho` answers about ONE row, and a row at a time is not enough: a real
 * conversation replays with each prompt drawn several times and torn copies in between.
 * Reading every hit as a prompt gave THREE tags for one ask and a tag on a line of test
 * output - the rail being wrong rather than empty, and its whole promise is that its tags
 * are the prompts. Measured over this desk's own history logs, 2026-08-24.
 *
 * Three rules, each from a shape in those logs:
 *
 *   - A row carrying a rule, or followed by one, is a torn repaint and not an echo.
 *   - A real echo has a blank row above it: the CLI puts one there before every prompt
 *     block. That is what refuses `❯ aok    stash         21.3s`, the start of an echo
 *     painted over a finished test run's output.
 *   - The same prompt drawn several times gets ONE tag, on the LAST copy - the one still
 *     in the place the reader is looking at.
 */
export function seedPrompts(lines: string[]): SeededPrompt[] {
  const seen = new Map<string, SeededPrompt>()
  for (let i = 0; i < lines.length; i++) {
    const text = promptEcho(lines[i])
    if (!text) continue
    if (RULE.test(lines[i]) || RULE.test(lines[i + 1] ?? '')) continue
    if (i > 0 && lines[i - 1].trim() !== '') continue
    seen.set(text.replace(/\s+/g, ' ').toLowerCase(), { line: i, text })
  }
  return [...seen.values()].sort((a, b) => a.line - b.line)
}
