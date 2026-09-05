// Where a CLI's input box is on the screen, read off the drawn text.
//
// `cursorMove.ts` answers "how do I get the caret there" and refuses to emit an up or a
// down for a bare click, because in a plain shell an up-arrow is the previous command and
// not a movement. That refusal is right, and it is also why clicking around a half-typed
// prompt felt "very limited": every agent CLI in this app draws a MULTI-LINE input box,
// and a second line of a draft is a hard newline, not a wrap - so `isWrapped` says the
// rows are unrelated and a click on line two of what you are typing did nothing at all.
//
// Inside such a box an up-arrow IS a movement: the box is a text field the CLI is drawing
// itself, and it handles the arrows rather than the line editor. So the question is only
// "are these two rows the same box", and the box says so - it is drawn with a vertical
// rule down each side. A plain shell draws nothing, so nothing here can fire in one, which
// is what makes it safe to allow the arrows a bare click may otherwise never send.
//
// Text in, numbers out, no terminal: `npm run test:promptbox`.

/**
 * The glyphs every CLI in `agents.ts` draws its input frame with. Claude Code and Codex
 * use the light box (`│`), Gemini the same, and a few themes use the heavy or double rule.
 * A `>` on its own is deliberately NOT here: a bare `>` is also a shell continuation
 * prompt and a redirect in something scrolling past.
 */
const RULES = '│┃║▏▕'

/** How far in the frame may start. A box is drawn at the very left, give or take padding. */
const MARGIN = 4

/** The row is one line of a drawn input box: a vertical rule near its left edge. */
export function boxedRow(text: string): boolean {
  const at = frameAt(text)
  return at >= 0
}

/** Column of the box's left rule, or -1 when this row is not part of a box. */
export function frameAt(text: string): number {
  for (let i = 0; i < Math.min(MARGIN, text.length); i++) {
    if (RULES.includes(text[i])) return i
  }
  return -1
}

/**
 * Two rows belong to one input box.
 *
 * Deliberately weak: same frame column, both boxed. Anything stronger (matching the right
 * rule, counting width) breaks on a box that a wide character or an emoji has pushed out
 * of true, and the cost of being wrong here is small - an arrow key inside a text field.
 */
export function sameBox(a: string, b: string): boolean {
  const fa = frameAt(a)
  return fa >= 0 && fa === frameAt(b)
}

/**
 * How many rows above the cursor the composer starts, or 0 when this pane draws none.
 *
 * A prompt tag is anchored to the TOP of what was typed, because the cursor at submit time
 * sits on the last row of it and a long prompt would otherwise tag a line several rows
 * below its own first word. The top is found rather than estimated: the composer's own rule
 * is still on screen at submit time.
 *
 * The trap is that a rule is not automatically the composer's. Measured in a live Codex
 * pane (v0.146.0, `scripts/prompt-box-test.mjs` carries the rows): Codex draws its input as
 * a bare `› what you typed` with NO rule above it, and the nearest box-drawing line is the
 * BOTTOM of the startup banner six rows further up, with two blank rows and a tip in
 * between. Walking to it anchored every Codex prompt six to twenty-one rows too high - and
 * a tag that lands on line 0 is dropped by `markAnchor`'s trim rule at the next repaint,
 * which is "Codex shows no prompt tags" as reported.
 *
 * So the walk stops at anything that is plainly NOT the composer:
 *
 *   - a bottom rule or corner (`╰ ╯ └ ┘ ┴`) closes a box that was drawn above this one;
 *   - two blank rows in a row are the gap between the transcript and the composer.
 *
 * Claude Code, whose composer IS a rule directly above the prompt row, is untouched: it
 * matches on the first row of the walk. A pane that draws no composer at all - a shell -
 * finds nothing and the tag stays on the cursor's own row, which is already right.
 */
export function promptTop(rows: string[], maxUp = rows.length): number {
  let blanks = 0
  for (let up = 1; up < Math.min(rows.length, maxUp + 1); up++) {
    const s = (rows[up] ?? '').trim()
    if (!s) {
      if (++blanks >= 2) return 0
      continue
    }
    blanks = 0
    if (BOTTOM_RULE.test(s)) return 0
    if (s.length >= 8 && TOP_RULE.test(s)) return up
  }
  return 0
}

/**
 * A run of box-drawing characters, which is what these CLIs frame a prompt with - `────` in
 * Claude Code's current build, `╭───╮` in the rounded ones. Anchored at the start so a line
 * of text that merely contains one cannot match.
 */
const TOP_RULE = /^[─-╿]{4}[─-╿\s]*$/
/** The same, but closing a box: whatever it belongs to is above the composer, not in it. */
const BOTTOM_RULE = /^[╰╯└┘┴┸┺┷┻╧╩]/

/**
 * What counts as blank between the frame, the marker and the text.
 *
 * A plain space is not enough, and this cost the whole feature: measured off a live
 * Claude Code 2.1.x pane, its composer draws `❯` followed by **U+00A0**, a non-breaking
 * space. Testing for `' '` alone made `inputStart` answer 0 on the row the prompt is on -
 * so a select-all highlighted the CLI's own marker, and the composer walk, which proves
 * it found a composer by finding that marker, found none and refused every multi-row
 * delete. The bug was invisible in every test and in every reading: the two characters
 * are drawn identically and JSON prints them the same.
 */
const BLANKS = ' \u00a0\u2007\u202f'

/** The prompt markers a CLI draws between the frame and what you typed. */
const MARKERS = ['>', '❯', '›', '»', '$', '#', '%']

/**
 * The column the typed text starts at on a row - past the frame and past the prompt
 * marker, if that row carries one.
 *
 * Used to select "everything you have typed" without selecting the box that is drawn
 * around it. A row of a box with no marker (the second line of a draft) starts right after
 * the frame and its padding.
 */
export function inputStart(text: string): number {
  const frame = frameAt(text)
  // Capped at the far end, or an empty box row - a frame, twenty spaces, a frame - walks
  // the start straight past the end and reports a negative length as a huge one.
  const cap = inputEnd(text)
  if (frame < 0) {
    // A shell writes its prompt on the same row as what you type - `bash-3.2$ echo x`,
    // `robert@mac PaneForge % npm run build` - and selecting from column 0 highlighted the
    // prompt as if it were yours. Measured live: a select-all in a real pane read back
    // "bash-3.2$ echo HELLOWORLD". The backspaces were harmless (a line editor refuses to
    // delete its own prompt) but the highlight was a lie about what would go.
    //
    // The FIRST marker followed by a space, not the last: the prompt always precedes what
    // was typed, so a `$` inside the text cannot win - and under-selecting is the one
    // failure that would leave characters behind.
    for (let i = 0; i + 1 < cap; i++) {
      if (MARKERS.includes(text[i]) && BLANKS.includes(text[i + 1])) {
        let j = i + 1
        while (j < cap && BLANKS.includes(text[j])) j++
        return j
      }
    }
    return 0
  }
  let i = frame + 1
  while (i < cap && BLANKS.includes(text[i])) i++
  if (i < cap && MARKERS.includes(text[i])) {
    i++
    while (i < cap && BLANKS.includes(text[i])) i++
  }
  return i
}

/**
 * How far the indent runs on a row that carries no marker - the continuation rows of a
 * composer, which are indented to line up under the first one. Blank means `BLANKS`, not
 * `' '`: see the note there.
 */
export function leadingBlanks(text: string): number {
  let i = 0
  while (i < text.length && BLANKS.includes(text[i])) i++
  return i
}

/**
 * The column just past the last written character, so a selection or a click never runs
 * into the empty half of the row - or into the box's own right-hand rule, which is drawn
 * at the far end of a row that is otherwise blank.
 */
export function inputEnd(text: string): number {
  let end = text.length
  while (end > 0 && BLANKS.includes(text[end - 1])) end--
  if (end > 0 && RULES.includes(text[end - 1])) {
    end--
    while (end > 0 && BLANKS.includes(text[end - 1])) end--
  }
  const frame = frameAt(text)
  return frame < 0 ? end : Math.max(end, frame + 1)
}

/**
 * The rows of the CLI's own composer, when the cursor is inside one.
 *
 * `sameBox` answers this for a CLI that frames its input with vertical rules, and for
 * three releases that was every CLI here. Claude Code 2.1.x draws no frame at all: a
 * horizontal rule, then `❯ what you typed` with each further row indented two spaces,
 * then another rule. Measured live at 157 columns, a 244-character prompt drew across two
 * rows and NEITHER carried a frame and NEITHER said `isWrapped` - so "are these one input"
 * was answered no by both tests the pane had, and a selection across them deleted a single
 * character. That is the whole of "it doesn't delete all the highlighted text".
 *
 * The walk is bounded on both sides and refuses rather than guesses: a top rule above, a
 * rule of the SAME width below, a prompt marker on the first row, and the cursor between
 * them. A pane scrolling ordinary output has no such sandwich, and a shell draws neither
 * rule - so nothing here can fire in one.
 */
export interface Composer {
  /** first row of what was typed, counted the way the caller counts rows */
  top: number
  /** last row of it */
  bottom: number
  /** how wide the composer is drawn, so a row that FILLS it can be told from one that does not */
  width: number
}

export function composerAt(
  read: (row: number) => string,
  cursorRow: number,
  opts: { maxUp?: number; maxDown?: number; codexCols?: number } = {}
): Composer | null {
  // Codex 0.146 draws a borderless draft and explicitly positions each row;
  // none is an xterm wrap. Require its own marker, the gap above it, and the
  // status row below. Only the Codex caller opts in, so shell text cannot match.
  if (opts.codexCols && opts.codexCols > 0) {
    let top = -1
    for (let r = cursorRow; r >= Math.max(0, cursorRow - (opts.maxUp ?? 12)); r--) {
      const text = read(r)
      if (/^›[ \u00a0]/.test(text) && !read(r - 1).trim()) {
        top = r
        break
      }
      if (text.trim() && !text.startsWith('  ')) break
    }
    if (top >= 0) {
      for (let r = top + 1; r <= cursorRow + (opts.maxDown ?? 8); r++) {
        const text = read(r)
        if (!text.trim() && /^ {2}\S.* · /.test(read(r + 1))) {
          if (cursorRow < r) return { top, bottom: r - 1, width: opts.codexCols }
          break
        }
        if (text.trim() && !text.startsWith('  ')) break
      }
    }
  }
  const here = read(cursorRow)
  // A framed box says what it is on every row of itself - that is `sameBox`, unchanged.
  if (frameAt(here) >= 0) {
    let top = cursorRow
    while (top > 0 && sameBox(read(top - 1), here)) top--
    let bottom = cursorRow
    while (sameBox(read(bottom + 1), here)) bottom++
    return { top, bottom, width: trimmed(here).length }
  }
  const maxUp = opts.maxUp ?? 12
  const maxDown = opts.maxDown ?? 8
  let top = -1
  let width = 0
  let blanks = 0
  for (let up = 1; up <= maxUp; up++) {
    const r = cursorRow - up
    if (r < 0) return null
    const s = trimmed(read(r)).trim()
    if (!s) {
      // Two blank rows are the gap between the transcript and the composer, so anything
      // above them belongs to something else - the same stop `promptTop` walks under.
      if (++blanks >= 2) return null
      continue
    }
    blanks = 0
    if (BOTTOM_RULE.test(s)) return null
    if (frameAt(read(r)) >= 0) return null
    if (isRule(s)) {
      top = r + 1
      width = s.length
      break
    }
  }
  if (top < 0 || top > cursorRow) return null
  // The first row of a composer carries the CLI's own prompt marker. Requiring it is what
  // keeps a paragraph sandwiched between two rules in an ANSWER from reading as one.
  if (inputStart(read(top)) === 0) return null
  let bottom = -1
  for (let down = cursorRow + 1; down <= cursorRow + maxDown; down++) {
    const s = trimmed(read(down)).trim()
    if (!s) return null
    if (isRule(s)) {
      // A closing rule of another width closes something else.
      if (s.length !== width) return null
      bottom = down - 1
      break
    }
  }
  if (bottom < cursorRow) return null
  return { top, bottom, width }
}

/** Trailing blanks off, which is how every row here is compared. */
function trimmed(text: string): string {
  let end = text.length
  while (end > 0 && BLANKS.includes(text[end - 1])) end--
  return text.slice(0, end)
}

/** A drawn rule, long enough that a line of prose cannot be mistaken for one. */
function isRule(s: string): boolean {
  return s.length >= 8 && TOP_RULE.test(s)
}
