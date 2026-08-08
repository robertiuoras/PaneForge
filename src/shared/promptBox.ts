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
      if (MARKERS.includes(text[i]) && text[i + 1] === ' ') {
        let j = i + 1
        while (j < cap && text[j] === ' ') j++
        return j
      }
    }
    return 0
  }
  let i = frame + 1
  while (i < cap && text[i] === ' ') i++
  if (i < cap && MARKERS.includes(text[i])) {
    i++
    while (i < cap && text[i] === ' ') i++
  }
  return i
}

/**
 * The column just past the last written character, so a selection or a click never runs
 * into the empty half of the row - or into the box's own right-hand rule, which is drawn
 * at the far end of a row that is otherwise blank.
 */
export function inputEnd(text: string): number {
  let end = text.length
  while (end > 0 && text[end - 1] === ' ') end--
  if (end > 0 && RULES.includes(text[end - 1])) {
    end--
    while (end > 0 && text[end - 1] === ' ') end--
  }
  const frame = frameAt(text)
  return frame < 0 ? end : Math.max(end, frame + 1)
}
