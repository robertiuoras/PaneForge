// The agent asked a question with answers on it, and the answers become buttons.
//
// Every CLI here draws a choice the same way - a numbered list with one row marked by
// `❯`, and a footer saying which keys move and which key commits. Answering it means
// arrowing to the row you want and pressing return, which is fine at the desk and is
// most of why a pane waiting on a question sits unanswered for hours when the person is
// not at the desk: on a phone there are no arrow keys, and in a Telegram message there
// is no terminal at all. Reading the list out of the frame turns it into a row of
// buttons the phone client already knows how to draw, and turns "answer question 3" into
// something a bot can post over the phone server.
//
// This module is the part with no Electron, no Node and no xterm in it: given the text
// that is on a pane's screen, is a choice live, what are the options, and which keys
// would pick one. `src/main/sessions.ts` runs it over the painted tail it already keeps
// for the busy read, so a mirrored pane and a phone get the answer for free.
//
// The reading is deliberately narrow, because the failure mode is not a missed question
// (the pane still says "waiting for you") but a FALSE one: a numbered list inside an
// answer, drawn as buttons, that types arrow keys into a composer somebody is holding a
// draft in. Three things must all be true, and the frames in `npm run test:choices` are
// real captures from this machine's own pane logs.

/** One answer on offer. `n` is the number the CLI printed, always 1-based. */
export interface Choice {
  n: number
  label: string
}

/** A live question on a pane's screen. */
export interface PaneAsk {
  /** The question itself, when the CLI printed one above the list. */
  question: string
  options: Choice[]
  /** The option `❯` is currently on. */
  selected: number
}

/**
 * The footer a CLI prints under a live choice, and the one load-bearing signal here.
 *
 * A numbered list is not a question - an agent's answer is full of them - and `❯` on its
 * own is a composer's prompt marker in half these CLIs. What no answer ever contains is
 * the CLI stating which key commits the selection, because that line is drawn by the
 * chooser widget and by nothing else. Both wordings measured on this desk: Claude Code's
 * AskUserQuestion prints `Enter to select · ↑/↓ to navigate · Esc to cancel`, and its
 * built-in resume prompt prints `Enter to confirm · Esc to cancel`.
 */
const FOOTER = /^\s*(?:.*·\s*)?Enter to (?:select|confirm|choose)\b/im

/**
 * The last screen of a multi-question ask, which prints NO footer at all.
 *
 * Claude Code's AskUserQuestion asks its questions one at a time and then draws a review:
 * a tab strip, the answers so far, and `1. Submit answers / 2. Cancel`. Nothing is sent
 * until that list is answered - and the widget does not print the `Enter to select`
 * footer on it, measured off two real frames in this machine's own pane logs
 * (`s10-mt5pfcld`, `s11-mt2ptrhm`, 2026-08-23). So the footer, which is the load-bearing
 * signal everywhere else in this file, is simply absent for the one screen that commits
 * the whole exchange: every question in the set was answered, buttons and all, and then
 * the pane sat for ever holding answers nobody could send. What the app drew instead was
 * the PREVIOUS question's frame, whose footer is still the last one in the tail.
 *
 * So this screen gets a signal of its own, and it is the prompt line ABOVE the list
 * rather than a footer below it. That sentence is drawn by the review widget and by
 * nothing else, which is the same property the footer is trusted for.
 *
 * It cannot open the door to a false question. The list under it must still be 1..N with
 * exactly one `❯`, which an agent quoting this sentence in an answer never produces, and
 * `reviewTail` additionally refuses one that is not the last thing on the screen.
 */
const REVIEW = /^\s*Ready to submit your answers\?/i

/** `❯ 1. Label`, `  2. Label`. The arrow is optional; exactly one line carries it. */
const OPTION = /^(\s*)(❯\s*|>\s*)?(\d{1,2})\.\s*(\S.*)$/

/**
 * A side-by-side PREVIEW column, cut off the end of a row.
 *
 * Claude Code's AskUserQuestion draws previews (an ASCII mockup, a code snippet) in a
 * panel to the RIGHT of the option list, so one terminal row carries the option AND a
 * slice of somebody else's box: `1. Pane sprite (Recommended)    | ## |`. That slice is
 * not part of the label - it reached the buttons and the Telegram message as a row of
 * box characters that means nothing without the other rows around it.
 *
 * Cut at the first run of blanks followed by a box or block character: a real label is
 * one phrase and never contains those, and the gutter between the two columns is always
 * at least two spaces wide.
 */
const PREVIEW = /\s{2,}[│|┌┐└┘├┤┬┴┼─━═╭╮╰╯█▀▄▌▐░▒▓▏▕].*$/

/** A row with its preview column removed, or the row unchanged when the cut empties it. */
function stripPreview(line: string): string {
  const cut = line.replace(PREVIEW, '').trim()
  return cut || line.trim()
}

/** Box drawing, rules and the like: never a question, whatever else is on the line. */
const RULE = /^[\s─━═\-_·|┌┐└┘├┤┬┴┼]*$/

/** How far back up the frame a question's own text may sit. */
const QUESTION_LINES = 4

/** The tail of the pane that is read. Anything older has been scrolled past. */
export const ASK_TAIL_CHARS = 4000

/**
 * The gap between the keystrokes that answer a question.
 *
 * One write carrying every arrow and the return arrives at a widget that has not
 * finished redrawing between them, which is the same reason `queuePrompt` sends its
 * return separately from its text. Slow enough to be a person's hand, fast enough that
 * six options are answered in half a second.
 */
export const CHOOSE_GAP_MS = 90

/**
 * The submit/cancel list under a review prompt, walking DOWN from the prompt line.
 *
 * Down rather than up, because this list has no footer beneath it to walk up from - the
 * prompt sentence above it is the anchor. Everything else is the same reading as the main
 * walk: 1..N with no gaps, exactly one arrow, descriptions indented under their option.
 *
 * The refusal that keeps this honest is `only blanks below`. Once the answers are sent the
 * CLI prints its transcript under the very same rows - `⏺ User answered Claude's
 * questions:` and the echo of every answer - and those rows stay in the painted tail for a
 * while. A review with anything but blank rows and rules beneath it has already been
 * answered, and pressing return at it would put a stray newline into a composer somebody
 * may be holding a draft in. While it is live it owns the screen and nothing follows it.
 */
function readReview(lines: string[], lead: number): PaneAsk | null {
  const found = new Map<number, { label: string; arrow: boolean }>()
  let last = -1
  for (let i = lead + 1; i < lines.length && i - lead < 20; i++) {
    const line = lines[i]
    const m = OPTION.exec(line)
    if (m) {
      const n = Number(m[3])
      if (!found.has(n)) found.set(n, { label: stripPreview(m[4]), arrow: Boolean(m[2]) })
      last = i
      continue
    }
    if (!line.trim() || RULE.test(line)) {
      if (found.has(1)) break
      continue
    }
    // A description indented under its own option, exactly as in the main walk.
    if (found.size && /^\s{4,}\S/.test(line)) continue
    break
  }
  if (last < 0) return null

  const ns = [...found.keys()].sort((a, b) => a - b)
  if (ns.length < 2 || ns[0] !== 1 || ns[ns.length - 1] !== ns.length) return null
  const arrows = ns.filter((n) => found.get(n)!.arrow)
  if (arrows.length !== 1) return null

  // Nothing but BLANK rows below the list, and a rule is not blank.
  //
  // A live chooser owns the screen: the CLI draws no composer under it and no frame after
  // the last option, so the rows beneath are empty. Once the answers are sent it prints
  // `⏺ User answered Claude's questions:` and the whole echo over those same rows, and its
  // composer's own rules land there too - which is why this cannot be as generous as the
  // main walk and let a `─` through. A stale review whose transcript has scrolled away but
  // whose composer rule has not would otherwise read as live, and the return pressed at it
  // lands in a draft somebody is holding.
  for (let i = last + 1; i < lines.length; i++) {
    if (lines[i].trim()) return null
  }

  return {
    question: lines[lead].trim(),
    options: ns.map((n) => ({ n, label: found.get(n)!.label })),
    selected: arrows[0]
  }
}

/**
 * The question on this pane's screen, or null.
 *
 * `text` is ANSI-stripped output - the same painted tail the busy read uses, not the
 * whole scrollback. Reading the scrollback would find every choice the session has ever
 * answered and offer the oldest of them as live.
 */
export function readAsk(text: string): PaneAsk | null {
  if (!text) return null
  const lines = text.slice(-ASK_TAIL_CHARS).split(/\r?\n/)

  // The LAST footer, not the first: a session that answered a question an hour ago still
  // has that frame in the tail, and the newest one is the one still on screen.
  let foot = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      foot = i
      break
    }
  }

  // The review screen, when it is newer than the last footer. Newer matters: the frame
  // that carries a review also carries the footer of the question asked just before it,
  // and reading that one leaves the app drawing buttons for a question the CLI has
  // already moved past.
  let lead = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REVIEW.test(lines[i])) {
      lead = i
      break
    }
  }
  if (lead > foot) return readReview(lines, lead)

  if (foot < 0) return null

  // Walk up from the footer collecting numbered rows. A description line under an option
  // is indented past its own number and carries no number of its own, so it is skipped
  // rather than ending the walk - which is what makes the AskUserQuestion shape (label
  // plus a paragraph under it) read the same as the bare resume prompt.
  const found = new Map<number, { label: string; arrow: boolean; line: number }>()
  let top = foot
  for (let i = foot - 1; i >= 0 && foot - i < 60; i--) {
    const line = lines[i]
    const m = OPTION.exec(line)
    if (m) {
      const n = Number(m[3])
      // First sighting wins going up, so a row repainted higher in the frame cannot
      // replace the one nearest the footer.
      if (!found.has(n))
        found.set(n, { label: stripPreview(m[4]), arrow: Boolean(m[2]), line: i })
      top = i
      continue
    }
    if (!line.trim() || RULE.test(line)) {
      // A blank line above the list ends it; a blank line INSIDE it (between an option
      // and its description) is only allowed while more options are still to come.
      //
      // A RULE is read exactly the same way, and that is not cosmetic: Claude Code 2.1.235
      // draws a full-width `-` between the real answers and the trailing ones it always
      // offers ("Type something.", "Chat about this"), wrapped over two rows in a wide
      // pane. Reading that as prose ended the walk one option in, so `found` held only
      // {4}, the 1..N check failed, and EVERY AskUserQuestion on this desk read as no
      // question at all - no buttons, no red card, no Telegram message and nothing for
      // `autoAnswer` to press. Measured off a real 157-column pane frame on 2026-08-19
      // and kept as a fixture in `npm run test:choices`.
      //
      // It cannot open the door to a false question: a numbered list in an ANSWER is
      // refused by the footer, which is the load-bearing signal and is drawn by the
      // chooser widget alone.
      if (found.has(1)) break
      continue
    }
    // Any other prose ends the list unless it is a description belonging to the option
    // below it, which is indented past where a number would start.
    if (found.size && /^\s{4,}\S/.test(line)) continue
    if (found.has(1)) break
    // Prose above a list that has not reached 1 yet means the numbers we collected are
    // not a choice block at all.
    if (found.size) return null
  }

  const ns = [...found.keys()].sort((a, b) => a - b)
  // 1..N with nothing missing. A gap means the walk crossed something that was not this
  // list, and a list that does not start at 1 is a fragment scrolled half off the top.
  if (ns.length < 2 || ns[0] !== 1 || ns[ns.length - 1] !== ns.length) return null

  const arrows = ns.filter((n) => found.get(n)?.arrow)
  // Exactly one row is selected. None means the frame was caught mid-repaint or this is
  // a plain numbered list; several means `>` in the text was read as a marker.
  if (arrows.length !== 1) return null

  const options = ns.map((n) => ({ n, label: found.get(n)!.label }))

  // The question is the prose immediately above the list: the contiguous non-blank,
  // non-rule lines, joined. Capped, because a CLI that printed a paragraph of its own
  // above the list would otherwise put the whole paragraph on a button's tooltip.
  const q: string[] = []
  for (let i = top - 1; i >= 0 && q.length < QUESTION_LINES; i--) {
    const line = lines[i]
    if (!line.trim()) {
      if (q.length) break
      continue
    }
    if (RULE.test(line)) break
    // A CLI that draws its question inside a box leaves the frame's own gutter on every
    // row, and that gutter is not the question: it reached the buttons, the card's hover
    // and the Telegram message as a literal `|` at the start of each line.
    q.unshift(stripPreview(line.replace(/^\s*[│|]\s?/, '')))
  }

  return { question: q.join(' ').trim(), options, selected: arrows[0] }
}

/**
 * The keystrokes that pick option `n`, given where the arrow is now.
 *
 * Arrows and a return, never the digit. Typing `3` picks the third option in Claude
 * Code and does nothing at all in a chooser that only reads the arrows, and the two are
 * indistinguishable from the frame - so this sends what a person's hands would send,
 * which every chooser here understands by construction. An empty array means the arrow
 * is already there and only the return is needed.
 */
export function keysForChoice(ask: PaneAsk, n: number): string[] | null {
  if (!ask.options.some((o) => o.n === n)) return null
  const step = n - ask.selected
  const key = step > 0 ? '\u001b[B' : '\u001b[A'
  const keys = new Array(Math.abs(step)).fill(key) as string[]
  keys.push('\r')
  return keys
}

/**
 * A cheap string that changes whenever anything a caller could act on has changed -
 * the question, the options, or WHERE THE ARROW IS.
 *
 * The arrow is in it on purpose. Answering walks from the current selection, so a
 * person arrowing at the desk while a phone is looking at the same pane would otherwise
 * leave the phone holding a stale starting point and pick a row the distance they moved
 * it away from the one they pressed - silently, and only sometimes.
 */
export function askSignature(text: string): string {
  const ask = readAsk(text)
  if (!ask) return ''
  return `${ask.selected}|${ask.question}|${ask.options.map((o) => `${o.n}.${o.label}`).join('|')}`
}

/** True when two readings are the same question, so a re-read does not re-notify. */
export function sameAsk(a: PaneAsk | null | undefined, b: PaneAsk | null | undefined): boolean {
  if (!a || !b) return !a && !b
  if (a.question !== b.question || a.options.length !== b.options.length) return false
  return a.options.every((o, i) => o.n === b.options[i].n && o.label === b.options[i].label)
}
