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

export function promptEcho(line: string): string {
  const m = ECHO.exec(line.replace(/\s+$/, ''))
  if (!m) return ''
  const text = m[1].trim()
  // Same floor as the live rail: a single character is a menu key, not an ask.
  return text.length > 1 ? text : ''
}
