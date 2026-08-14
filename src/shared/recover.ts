// A turn the transport cut in half, and the one keystroke that finishes it.
//
// An agent CLI whose stream dies mid-answer prints an error and returns to its composer.
// Nothing is wrong with the session - the context is intact, the CLI is healthy, the pane
// is green and idle - and the only thing standing between that pane and the rest of its
// answer is somebody typing "continue". So the pane sits there, finished-looking and
// unfinished, until a person notices. On a desk running twelve panes that is most of them
// at some point in a day, and noticing is the expensive part.
//
// This module is the decision and nothing else: given what a pane last painted, is this a
// turn that was TRUNCATED, and may the app finish it. Everything dangerous about the idea
// is in that question, so all of it is here, pure, and pinned by `npm run test:recover`.
//
// Measured before it was written, over the 557 MB of real pane logs on this desk - which
// is the reason it keys on the sentence it does. Five different first sentences have
// already shipped:
//
//   API Error: Connection closed mid-response. The response above may be incomplete.   x6
//   API Error: Response stalled mid-stream. The response above may be incomplete.      x2
//   API Error: Connection lost mid-response. The response above may be incomplete.     x2
//   API Error: The response stopped arriving. The response above may be incomplete.    x1
//   API Error: Server error mid-response. The response above may be incomplete.        x1
//
// Every one of them ends in the same sentence, and that sentence is not decoration: it is
// the CLI stating the precise thing that makes continuing safe - the answer was cut off
// rather than refused, declined, rate-limited or unauthorised. Matching the first sentence
// would mean chasing a vendor's wording for ever and would still be matching the wrong
// half. `INCOMPLETE` is the contract.

import { frameAt } from './promptBox'

/**
 * The sentence a truncated turn ends with, and the whole trigger.
 *
 * Deliberately the SECOND sentence of the error. See the header: the first one has five
 * shipped spellings and counting, and none of them is the part that means "safe to
 * resume".
 */
export const INCOMPLETE = 'The response above may be incomplete.'

/** The error family this belongs to, required alongside INCOMPLETE so prose cannot match. */
const ERROR_LINE = /API Error|Request failed|Stream (error|interrupted)/i

/**
 * A line that is somebody's MESSAGE rather than the CLI's report, and the guard that
 * turned out to be load-bearing.
 *
 * Asking an agent about one of these errors means pasting it, and once that is submitted
 * the CLI echoes it back into the transcript as a user message - out of the composer, with
 * no box left around it, and carrying the full `API Error: ... may be incomplete.` string.
 * This desk's own logs contain exactly that, twice. Read naively it is indistinguishable
 * from a real failure, and the app would answer a question about the bug by triggering it.
 *
 * What still separates them is the marker every CLI draws in front of a person's words and
 * never in front of its own errors (`> `, `› `, `❯ `). An error line starts with the CLI's
 * own bullet, or with nothing.
 */
const SOMEBODY_SAID = /^\s*[>❯›»$#%]\s/

/**
 * Errors that carry the incomplete sentence and must still never be auto-continued.
 *
 * A retry is not free and is not always harmless. Sending "continue" into a pane that just
 * hit a usage limit spends the next window's first request on a message that will be
 * refused the same way; into an auth failure it is a loop that never converges. The CLI
 * retries the things that deserve a retry (429, overloaded) by itself and says so, so the
 * app has no business racing it.
 *
 * Checked against the error line only, never the answer above it - an agent that WROTE the
 * words "rate limit" in its reply has not hit one.
 */
const NEVER =
  /rate.?limit|usage limit|quota|credit balance|insufficient|billing|overloaded|authenticat|unauthoris|unauthoriz|invalid[_ ]api|api[_ ]key|\b(401|403|429)\b/i

/** How much of the newest output is looked at. A screenful, not the scrollback. */
export const TAIL_CHARS = 4000

export interface RecoverConfig {
  /** Finish a truncated turn without being asked. */
  enabled: boolean
  /**
   * How many times in a row this may fire on one pane before it stops and leaves it for a
   * person.
   *
   * Three, because the failure it recovers from is transient by definition: a connection
   * that has died three times in a row on the same turn is not a blip, and the fourth
   * "continue" is the app talking to itself. The counter resets the moment a turn ends
   * without a truncation, so a pane that drops once an hour never runs out.
   */
  maxTries: number
  /** What to send. The CLI's own composer receives it exactly as a person's keystrokes. */
  text: string
}

export const DEFAULT_RECOVER: RecoverConfig = {
  enabled: true,
  maxTries: 3,
  text: 'continue'
}

export interface RecoverCtx {
  /** The newest output, ANSI already stripped. Only the last TAIL_CHARS are read. */
  painted: string
  /** Is the pane printing right now? A busy pane is never interrupted, at any cost. */
  busy: boolean
  /** Auto-continues already sent since this pane last finished a turn cleanly. */
  tries: number
}

export interface Recovery {
  /** The keystrokes to put in the composer. */
  text: string
  /** The error line that justified it, for the log and the chip. Never invented. */
  because: string
}

/**
 * The last line of the tail that reports a truncated turn, or null.
 *
 * Three things have to be true of it, and the second and third are the ones that keep this
 * from firing on a person:
 *
 *  - it carries `INCOMPLETE`, and an error word beside it;
 *  - it is not inside a drawn input box. Both times this desk's own logs contain the
 *    sentence outside a real failure, it is somebody QUOTING the error at an agent, sitting
 *    in the composer. A box row is the difference between the CLI saying it and a person
 *    saying it, and `promptBox` already knows what a box is;
 *  - it says nothing from `NEVER`.
 */
export function truncatedLine(painted: string): string | null {
  const tail = painted.length > TAIL_CHARS ? painted.slice(-TAIL_CHARS) : painted
  const rows = tail.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!row.includes(INCOMPLETE)) continue
    // The composer echo, still being typed. A quoted error is a question about the error.
    if (frameAt(row) >= 0) return null
    // The same quote after it was submitted, echoed back with no box around it.
    if (SOMEBODY_SAID.test(row)) return null
    if (!ERROR_LINE.test(row)) continue
    if (NEVER.test(row)) return null
    return row.trim()
  }
  return null
}

/**
 * Should the app finish this turn, and with what.
 *
 * Null is the answer for everything that is not unambiguously a cut-off turn on an idle
 * pane with tries left. The caller must also have established that the turn ENDED - this
 * reads what is on screen and cannot tell a finished pane from one that is about to print
 * its next frame, which is exactly the distinction `sweepIdle` already owns.
 */
export function recover(c: RecoverCtx, cfg: RecoverConfig = DEFAULT_RECOVER): Recovery | null {
  if (!cfg.enabled) return null
  if (c.busy) return null
  if (!(cfg.maxTries > 0) || c.tries >= cfg.maxTries) return null
  if (!cfg.text) return null
  const because = truncatedLine(c.painted)
  if (!because) return null
  return { text: cfg.text, because }
}
