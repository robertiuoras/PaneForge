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
  return more > 0 ? `${gist}  ·  +${more} more ${more === 1 ? 'ask' : 'asks'}` : gist
}
