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
 *
 * ANCHORED, and capped, because the rows handed in are unwrapped logical lines: the phrase
 * on its own matched a sentence of an answer that happened to quote `esc to interrupt` or
 * `? for shortcuts` - and dropping a row of somebody's reply is the one thing this file
 * says it must never do. A real footer is a short row holding the phrase and terminal
 * punctuation, nothing else.
 */
const FOOTER =
  /^[\s·•⏵⏺⎿()[\]?─━✻✽✳✶✢✱∗⠀-⣿]*(esc to interrupt|\? for shortcuts|bypass permissions on|shift\+tab to cycle)/

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
/** A footer row is short by construction, the same way a spinner row is. */
const FOOTER_MAX = SPINNER_MAX

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
  if (FOOTER.test(row) && row.trim().length <= FOOTER_MAX) return true
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

/**
 * The drafted message inside a reply: an email, a DM, a quote - the thing an agent wrote
 * FOR somebody else, which is the one part of the answer that gets pasted somewhere.
 *
 * Claude Code sets a draft off from the sentences around it by giving it a left margin, so
 * that margin is the tell. The LAST such block is the one wanted: a reply that revises a
 * draft holds the old one above the new one, and the new one is what is being asked for.
 * Blank rows inside a block belong to it - a message has paragraphs - but a row back at
 * the left edge ends it, because that is the agent talking again.
 *
 * Empty when there is no such block, and the caller then offers no row for it.
 */
export function draftBlock(rows: string[]): string {
  const lines = cleanReply(rows).split('\n')
  const indented = (l: string): boolean => /^ {2,}\S/.test(l)
  let best: string[] | null = null
  let run: string[] = []
  const close = (): void => {
    // Trailing blanks belong to whatever came after the block, not to the message.
    while (run.length && run[run.length - 1].trim() === '') run.pop()
    if (run.filter((l) => l.trim() !== '').length >= 2) best = run
    run = []
  }
  for (const line of lines) {
    if (indented(line) || (run.length && line.trim() === '')) run.push(line)
    else close()
  }
  close()
  if (!best) return ''
  // The margin comes off here rather than being left to the unwrap: the point of the row
  // is that what lands on the clipboard is the message on its own.
  const block = best as string[]
  const margin = Math.min(
    ...block.filter((l) => l.trim() !== '').map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length)
  )
  return block.map((l) => l.slice(margin)).join('\n')
}
