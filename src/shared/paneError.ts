// A pane that STOPPED, on a machine with nobody in front of it.
//
// `askNotify.ts` sends a pane's question off the machine for one reason: a question stops
// the run dead, the pane goes idle and green, and every idle reading in this app calls
// that pane finished. An error that stops a run is the same shape of failure and was NOT
// sent - and it is the worse half, because a question at least turns the pane red.
//
// This module is the decision and nothing else, the same contract as `recover.ts`: given
// what a pane last painted, is this a line that ENDED the run for a reason nothing in the
// app is going to fix.
//
// The split with `recover.ts` is the whole design, and neither file may grow the other's
// half:
//
//   - a turn the transport cut in half is `recover`'s. It types `continue`, the run
//     carries on, and nobody needs telling. A message about it would be a phone buzzing
//     for something already handled.
//   - a turn stopped by a usage limit, a credit balance, an auth failure or a 429 is the
//     one `recover` REFUSES by name (its `STOPS` list, imported here rather than copied -
//     two regexes that disagree about what "safe to continue" means is exactly the bug
//     this app has already paid for once, in `promptKey`). Nothing retries it, nothing
//     draws it in red, and the pane looks finished. That is what leaves the machine.
//
// Every rule here is a refusal. The expensive failure is not a missed error - the pane and
// its log still carry it - but a phone buzzing at prose, or at a person's own words.

import { frameAt } from './promptBox'
import { INCOMPLETE, SOMEBODY_SAID, STOPS } from './recover'

/** How much of the newest output is looked at. A screenful, not the scrollback. */
export const TAIL_CHARS = 4000

/**
 * The CLI's OWN report of a stop, as the CLI words it - at the start of the row, after the
 * gutter it draws in front of its output (`⎿` for Claude, `■` for Codex).
 *
 * `STOPS` is a list of words, and a word is not a report. The first version of this
 * required a `STOPS` word and a report shape anywhere in the row, and both lists carried a
 * bare 401/403/429 - so one number in a sentence satisfied both. 2026-09-27, a PC pane
 * researching Reddit sent Robert "stopped:" messages for `It returned 429 once, then 200
 * with 100 posts in rank order, but no upvote counts.` and for a tool result reading `not
 * a 403/rate-limit`: prose, every line a new message.
 *
 * So the whole line has to BE the vendor's sentence, anchored where the CLI starts it.
 * Wording from this Mac's own record, not from memory: Claude Code 2.1.283's transcripts
 * (`isApiErrorMessage` rows: `You've hit your weekly limit · resets Sep 24 at 3pm
 * (Australia/Brisbane)` x85, `Not logged in · Please run /login` x23, `You've hit your
 * session limit · resets 5pm ...` x13) and its binary (`API Error: 401 Invalid API key ·
 * Please run /login`, `Session expired. Please run /login`, `credit balance is too low`);
 * Codex's binary and pane history (`■ You've hit your usage limit. Visit https://...`,
 * `exceeded retry limit, last status: `, `unexpected status `).
 *
 * Matched with the whitespace squeezed out, because the painted stream is not the screen:
 * a CLI moves the cursor over a blank run instead of printing it, and once the escape codes
 * are stripped `import { X } from` reads `import{X}from` (measured in this desk's pane
 * history). The anchor is what keeps prose out, not the spacing.
 */
const REPORT_SHAPES: RegExp[] = [
  // Claude's API error line. The words after it say whether anything will retry it: the
  // `STOPS` list is `recover`'s refusal, shared so the two files cannot disagree.
  /^APIError:/i,
  // Claude's session/weekly/fast/spend limits and team budget, Codex's usage limit.
  /^You['’]?ve(hit|reached)your/i,
  /^(ClaudeAI|Claude)usagelimitreached/i,
  /^\d+-hourlimitreached/i,
  /^(Your)?creditbalanceistoolow/i,
  /^(Error:)?(Notloggedin|InvalidAPIkey|(Your)?session(has)?expired).*run\/login/i,
  /^YourorganizationhasdisabledClaudesubscriptionaccess/i,
  // Codex, after its own retries ran out, and its auth refusal.
  /^(streamerror:)?exceededretrylimit,laststatus:(401|403|429)/i,
  /^unexpectedstatus(401|403|429)/i
]

/** The gutter a CLI draws before its own output. A person's `>` is not one of them. */
const GUTTER = /^[⎿■●⏺✗✘×│]+/

/** Is this row, whole, a CLI's report that it stopped? */
export function isStopReport(row: string): boolean {
  const squeezed = row.replace(/\s+/g, '').replace(GUTTER, '')
  if (!REPORT_SHAPES.some((shape) => shape.test(squeezed))) return false
  // An API error that is NOT a stop - a cut-off turn, a 400 about tool ids - is somebody
  // else's: `recover` finishes the first, and the second is not a wall.
  return !/^APIError:/i.test(squeezed) || STOPS.test(row)
}

/**
 * The line that stopped this pane, or null.
 *
 * Four things have to be true of it, and three of them are refusals:
 *
 *  - it is the CLI's own report of a stop (`isStopReport`), not prose that mentions one;
 *  - it is not inside a drawn input box. A person asking an agent about an error types
 *    that error, and a half-typed composer row is not a failure - `promptBox` already
 *    knows what a box is;
 *  - it is not a person's submitted line echoed back. Once submitted, the CLI prints the
 *    quoted error into the transcript with no box around it, and the app would page about
 *    a question ABOUT an error;
 *  - it is not a cut-off turn `recover` is about to finish by itself. `INCOMPLETE` on a
 *    row that is not a stop is that case exactly, and it belongs to the other file - so it
 *    ends this read rather than being skipped, which stops an older error further up the
 *    tail being reported as the reason this turn ended.
 */
export function stoppedLine(painted: string): string | null {
  const tail = painted.length > TAIL_CHARS ? painted.slice(-TAIL_CHARS) : painted
  const rows = tail.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!isStopReport(row)) {
      if (row.includes(INCOMPLETE)) return null
      continue
    }
    if (frameAt(row) >= 0) return null
    if (SOMEBODY_SAID.test(row)) return null
    return row.trim()
  }
  return null
}

/**
 * One message per stop, per pane.
 *
 * A pane that has stopped keeps painting: the CLI redraws, retries by itself and says so
 * again, an agent's own last words scroll past. Each of those is a new line, and a key
 * that differs gets past `AskNotifier`'s five-minute hold - which is how one stopped pane
 * became a phone buzzing over and over. After one message nothing more leaves for that
 * pane until a turn is submitted into it, whatever the next line says.
 */
export interface StopLatch {
  /** A stop was reported for this pane and no turn has been submitted since. */
  reported: boolean
}

/** The line to send for this read, or null - including for every read after the first. */
export function nextStop(latch: StopLatch, painted: string): string | null {
  if (latch.reported) return null
  const line = stoppedLine(painted)
  if (line) latch.reported = true
  return line
}

/** A turn was submitted into the pane: its next stop is news again. */
export function turnSubmitted(latch: StopLatch): void {
  latch.reported = false
}

/**
 * The message itself.
 *
 * Same manners as `askMessage`: plain text, the pane's name first because "which one" is
 * the first thing anybody asks on a desk with eight panes, and a last line saying what the
 * state actually is. The error line is quoted VERBATIM and never summarised - the whole
 * value of it is the vendor's own sentence, which is what says whether this is a five
 * minute wait or a card that needs topping up.
 */
export function errorMessage(title: string, line: string, device?: string): string {
  return [
    `${title}${device ? ` on ${device}` : ''} stopped:`,
    '',
    line,
    '',
    'Nothing is retrying this one.'
  ].join('\n')
}
