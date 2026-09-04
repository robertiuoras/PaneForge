/**
 * One line saying what a session was working on, for the History list.
 *
 * The point is picking which closed session to bring back, and a folder name plus a
 * timestamp does not answer that - eleven rows saying `PaneForge · 13:28` are eleven rows
 * you have to open one at a time.
 *
 * **It costs nothing.** No model, no tokens, no request: the text is the first thing that
 * was actually TYPED at the agent, which the app already sees on its way to the pty (the
 * same feed `promptArchive` is built from, and for the same reason - it works identically
 * for Claude, Codex and whatever ships next, because it reads keystrokes rather than any
 * one CLI's output). Everything here is the tidy-up that turns that into a line.
 *
 * Scraping the transcript was tried first and abandoned on the evidence: across this
 * machine's own pane logs, zero of them carried a recognisable prompt echo - a boxed
 * composer is redrawn character by character and interleaved with its own repaints, so
 * what lands in the log is not the sentence. Reading the keystrokes is not a shortcut,
 * it is the only source that is the same for every agent.
 */

/** Longer than a list row can show; the row clips, the tooltip does not. */
const CAP = 160

/**
 * Turn a submitted prompt into the line a row shows.
 *
 * A slash command is kept whole and short (`/clear` is a fine answer to "what was this"),
 * everything else loses its newlines, its shell noise and its trailing punctuation. Pasted
 * blocks - a stack trace, a diff, a wall of log - are the case worth naming: their first
 * line is usually meaningless, so the first line that reads like a SENTENCE wins, and if
 * none does the first line is used rather than nothing.
 */
export function gistOf(prompt: string): string {
  const lines = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const sentence = lines.find((l) => /^[A-Za-z/@#][^]*\s[A-Za-z]/.test(l) && !isNoise(l))
  const pick = sentence ?? lines[0]
  const clean = pick
    // A file path or a pasted URL is the whole line often enough to be worth keeping, so
    // nothing is stripped from the middle - only the decoration at either end.
    .replace(/^[-*>\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:]+$/, '')
    .trim()
  return clean.length > CAP ? clean.slice(0, CAP - 1).trimEnd() + '…' : clean
}

/** Lines that are a machine talking, not a person asking. */
function isNoise(line: string): boolean {
  return (
    /^(?:[+-]{3}|@@|\d+:\d+|at\s+\S+\(|\s*at\s)/.test(line) ||
    /^[A-Za-z]*Error\b/.test(line) ||
    /^\W+$/.test(line)
  )
}

/**
 * The words under a History row: what it was asked, and how much followed.
 *
 * The count is there because "one ask" and "forty asks" are different sessions to come
 * back to, and it is the cheapest possible signal of how far a session got.
 */
export function gistLine(gist: string | undefined, asks: number | undefined): string {
  if (!gist) return ''
  const more = (asks ?? 1) - 1
  // PROMPT, never `ask` - see `summaryOf` below for why.
  return more > 0 ? `${gist}  ·  +${more} more ${more === 1 ? 'prompt' : 'prompts'}` : gist
}

// ---------------------------------------------------------------------------
// What a whole session was about
//
// One line taken from the FIRST ask answers "what was this" for a session that asked one
// thing. It is wrong for the sessions worth coming back to: a long one is several jobs in
// a row, and `/clear` is where one ends and the next begins - the context is thrown away
// and what follows is a new subject in the same window. A row reading `fix the tunnel`
// for a session that went on to do four other things is not a summary, it is the first
// sentence of a long document.
//
// So every ask that opens a CHAPTER is kept: the first one, and the first one after each
// clear. Still no model, no request and no token - the same keystrokes History already
// sees. The decision is here rather than in `main/history.ts` because it is arithmetic
// over a small record and is worth pinning by test (`npm run test:gist`); main reads the
// JSON, hands it to `noteAskInto` and writes what comes back.

import { mayClearScreen } from './keepScrollback'

/** Chapters kept per session. Past this the count is kept and the text is not. */
export const MAX_CHAPTERS = 12

/** How many chapters a one-line row shows before it starts counting instead. */
const ROW_CHAPTERS = 3

/** A chapter's share of a row when it is sharing that row with others. */
const SHORT = 70

/**
 * Every ask a session made, kept for `Show all asks` - chapters only keep the FIRST ask of
 * each subject, and a session worth reopening is often one where the follow-ups are the
 * useful half ("now the other file", "and the tests"). Past this the list stops growing
 * rather than paying to keep counting what did not make it in - `chapters` already carries
 * the honest count for the row, and this is a convenience list, not a ledger.
 */
export const MAX_ASK_LINES = 80

/** An ask line's own cap - longer than a row ever shows, so the list reads whole. */
const ASK_LINE_CAP = 200

/** What History remembers about what a session was asked. */
export interface SessionNotes {
  /** the first thing typed at the agent, kept for every row that has one */
  gist?: string
  /** the ask that opened each chapter, oldest first */
  chapters?: string[]
  /**
   * Asks that were WORK: `/clear`, `/model` and friends are not counted.
   *
   * The number is on the row as "+12 more asks", and it is there to say how far a session
   * got - a count made mostly of slash commands says the opposite of what it looks like.
   */
  asks?: number
  /** chapters that happened after the cap; their count is the honest part */
  dropped?: number
  /** a clear threw the context away, so the next real ask opens a chapter */
  fresh?: boolean
  /**
   * Every submitted ask, oldest first - `chapters` only keeps the first ask of each
   * subject, this keeps all of them for `Show all asks`. A bare slash command
   * (`/clear`, `/model`) never appears here for the same reason it never opens a chapter:
   * it is something done TO the pane, not work asked of it.
   */
  askLines?: string[]
}

/** A slash command says what was DONE to the pane, never what it was working on. */
function isCommand(line: string): boolean {
  return line.startsWith('/')
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap - 1).trimEnd() + '…' : text
}

/**
 * Fold one submitted prompt into a session's notes.
 *
 * Pure, and it never throws: the caller is a fire-and-forget IPC on a pane's keystroke
 * path, and a note is a nicety.
 *
 * A clear is a boundary and not a topic - `/clear` as a chapter heading says nothing about
 * the work - so it only arms the next one. Every other slash command (`/model`, `/doctor`)
 * is counted as an ask and heads nothing, for the same reason. The first ask still becomes
 * `gist` whatever it is, because a row with one command in it is better than a blank one.
 */
export function noteAskInto(notes: SessionNotes, prompt: string): SessionNotes {
  const line = gistOf(prompt)
  if (!line) return notes
  const out: SessionNotes = { ...notes }
  if (!out.gist) out.gist = line
  if (!isCommand(line)) {
    const askLines = out.askLines ? [...out.askLines] : []
    if (askLines.length < MAX_ASK_LINES) askLines.push(clip(line, ASK_LINE_CAP))
    out.askLines = askLines
  }
  if (mayClearScreen(prompt)) {
    out.fresh = true
    return out
  }
  if (isCommand(line)) return out
  out.asks = (out.asks ?? 0) + 1
  const chapters = out.chapters ? [...out.chapters] : []
  const opens = chapters.length === 0 || Boolean(out.fresh)
  out.fresh = false
  if (opens && chapters[chapters.length - 1] !== line) {
    if (chapters.length < MAX_CHAPTERS) chapters.push(line)
    else out.dropped = (out.dropped ?? 0) + 1
  }
  out.chapters = chapters
  return out
}

/**
 * The one line under a History row: what the session worked on, and how much of it.
 *
 * Several chapters share the row, so each is clipped - three whole asks do not fit and the
 * one that would survive is the oldest, which is the least useful half of the answer.
 * Everything past the third is counted rather than shown, and `summaryFull` is what the
 * hover and the opened transcript print.
 */
export function summaryOf(notes: SessionNotes): string {
  const topics = notes.chapters?.length ? notes.chapters : notes.gist ? [notes.gist] : []
  if (!topics.length) return ''
  const shown = topics.slice(0, ROW_CHAPTERS).map((t) => (topics.length > 1 ? clip(t, SHORT) : t))
  const bits = [shown.join('  ·  ')]
  const extra = Math.max(0, topics.length - ROW_CHAPTERS) + (notes.dropped ?? 0)
  if (extra > 0) bits.push(`+${extra} more ${extra === 1 ? 'topic' : 'topics'}`)
  const more = (notes.asks ?? 1) - 1
  // PROMPT, not `ask`. An ask is this codebase's word for one thing typed at an agent, and
  // it reached the row as `+2 more asks` - a count of something the reader has no name for
  // (Robert 2026-09-04, reading History from the tour). The button under it says the same
  // word: `Show every prompt`.
  if (more > 0) bits.push(`+${more} more ${more === 1 ? 'prompt' : 'prompts'}`)
  return bits.join('  ·  ')
}

/** Every chapter, one per line, numbered - the hover and the opened session's header. */
export function summaryFull(notes: SessionNotes): string {
  const topics = notes.chapters?.length ? notes.chapters : notes.gist ? [notes.gist] : []
  if (!topics.length) return ''
  const lines = topics.map((t, i) => `${i + 1}. ${t}`)
  if (notes.dropped) lines.push(`… and ${notes.dropped} more after this`)
  return lines.join('\n')
}
