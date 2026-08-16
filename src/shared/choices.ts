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

/** `❯ 1. Label`, `  2. Label`. The arrow is optional; exactly one line carries it. */
const OPTION = /^(\s*)(❯\s*|>\s*)?(\d{1,2})\.\s*(\S.*)$/

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
      if (!found.has(n)) found.set(n, { label: m[4].trim(), arrow: Boolean(m[2]), line: i })
      top = i
      continue
    }
    if (!line.trim()) {
      // A blank line above the list ends it; a blank line INSIDE it (between an option
      // and its description) is only allowed while more options are still to come.
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
    q.unshift(line.trim())
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
