// What an agent actually SAID, with the terminal's furniture taken off.
//
// A pane's buffer is not a document. Between the sentences an agent wrote sit the things
// the CLI draws around them: the boxed composer at the bottom, the horizontal rules that
// fence it, the status footer (`esc to interrupt`, `⏵⏵ bypass permissions on`), the
// spinner line it repaints while it thinks, and the `⏺`/`⎿` markers it puts in front of
// its own tool calls. Copying a reply used to hand every one of those to the clipboard, so
// what landed in a message to somebody else was an answer with a terminal wrapped round it.
//
// The rule here is CONSERVATIVE, and deliberately so: a dropped row cannot be got back by
// the person pasting, while one line of chrome they can delete costs them a keystroke. So
// every rule below matches a shape the CLI draws and nothing else, and anything this file
// is unsure about is kept.
//
// It takes ROWS rather than a blob because the decisions are per-row, and the caller has
// the rows already (a terminal buffer is rows). The join back into prose - undoing the
// wrapping the CLI did at its own width - is `unwrapCopy.ts`, which runs after this.

/** A rule the CLI draws to fence its composer: `─────…` or `━━━━━…`, nothing else on it. */
const RULE = /^[\s─━_]*[─━]{3,}[\s─━_]*$/

/** The top and bottom of a boxed composer: corners and dashes, nothing readable. */
const BOX_EDGE = /^\s*[╭╮╰╯┌┐└┘][─━╭╮╰╯┌┐└┘\s]*$/

/**
 * The composer's own input row. Boxed (`│ ❯ `) or bare (`❯` / `>` on a row of its own).
 *
 * A bare marker only counts when the row holds NOTHING else: `> npm run build` in an
 * answer is somebody quoting a command, and it is the reader's, not the CLI's.
 */
const COMPOSER = /^\s*(│\s*[❯>›]|[❯>›]\s*)$/

/** A prompt row inside the box, with a draft still in it. */
const BOXED_INPUT = /^\s*│\s*[❯>›]\s/

/**
 * The status footer under the composer. Matched on the PHRASE rather than the position,
 * because every CLI here puts its own row there and a positional rule would take the last
 * line of an answer with it.
 */
const FOOTER = /(esc to interrupt|\? for shortcuts|bypass permissions on|shift\+tab to cycle)/

/** The permission mode line, which starts with its own glyph. */
const MODE = /^\s*⏵⏵/

/**
 * The line the CLI repaints while it is working: a spinner glyph and a word or two.
 *
 * Two families - the asterisk shapes Claude Code cycles (`✻ Thinking…`, `✻ Worked for
 * 42s`) and the braille spinner (`⠋⠙⠹`, `⢿  Working...`). Both are capped in length: a
 * spinner line is short by construction, and a paragraph that happens to open with one of
 * those characters is prose.
 */
const SPINNER = /^\s*([✻✽✳✶✢✱∗]|[⠀-⣿])[\s⠀-⣿]/
const SPINNER_MAX = 60

/** The markers in front of an agent's own tool calls and their output. */
const MARKER = /^(\s*)[⏺⎿]\s?/

/** A run of this many blank rows or more is a repaint artefact, not a paragraph break. */
const BLANK_RUN = 3

function drop(row: string): boolean {
  if (RULE.test(row) && row.trim() !== '') return true
  if (BOX_EDGE.test(row) && row.trim() !== '') return true
  if (COMPOSER.test(row)) return true
  if (BOXED_INPUT.test(row)) return true
  if (MODE.test(row)) return true
  if (FOOTER.test(row)) return true
  if (SPINNER.test(row) && row.trim().length <= SPINNER_MAX) return true
  return false
}

/**
 * The readable part of a reply, as one string.
 *
 * Blank rows survive as paragraph breaks - one or two of them are how the CLI separates
 * paragraphs - but a run of three or more is what a repaint leaves behind, and those
 * collapse to one. The leading and trailing ones go entirely.
 */
export function cleanReply(rows: string[]): string {
  const kept: string[] = []
  for (const raw of rows) {
    const row = raw.replace(/\s+$/, '')
    if (drop(row)) continue
    kept.push(row.replace(MARKER, '$1'))
  }
  const out: string[] = []
  let blanks = 0
  for (const row of kept) {
    if (row.trim() === '') {
      blanks++
      continue
    }
    if (out.length && blanks) out.push(...Array(blanks >= BLANK_RUN ? 1 : blanks).fill(''))
    blanks = 0
    out.push(row)
  }
  return out.join('\n')
}

/**
 * One line of what a copy would put on the clipboard, for a menu row to show before it is
 * pressed. Empty when there is nothing readable there - the caller draws no row for that.
 */
export function previewOf(text: string, max = 48): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!line) return ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
