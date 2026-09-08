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
 * The shapes a CLI reports a failure in, required alongside a `STOPS` word.
 *
 * `STOPS` on its own is not enough and the reason is already measured, in `recover.ts`'
 * own header: an agent that WROTE the words "rate limit" in an answer has not hit one. A
 * reply discussing billing, a README quoting a 401, a test name containing `usage limit`
 * are all prose. What separates the CLI's own report from prose about one is that the
 * report is shaped like a report.
 */
const REPORTED =
  /API Error|Request failed|Stream (error|interrupted)|usage limit reached|credit balance|Please run \/login|invalid[_ ]?api[_ ]?key|\berror\b|\b(401|403|429|529)\b/i

/**
 * The line that stopped this pane, or null.
 *
 * Four things have to be true of it, and three of them are refusals:
 *
 *  - it carries a `STOPS` word and is shaped like a report (`REPORTED`);
 *  - it is not inside a drawn input box. A person asking an agent about an error types
 *    that error, and a half-typed composer row is not a failure - `promptBox` already
 *    knows what a box is;
 *  - it is not a person's submitted line echoed back. Once submitted, the CLI prints the
 *    quoted error into the transcript with no box around it, and the app would page about
 *    a question ABOUT an error;
 *  - it is not a cut-off turn `recover` is about to finish by itself. `INCOMPLETE` with no
 *    `STOPS` word is that case exactly, and it belongs to the other file - so it ends this
 *    read rather than being skipped, which stops an older error further up the tail being
 *    reported as the reason this turn ended.
 */
export function stoppedLine(painted: string): string | null {
  const tail = painted.length > TAIL_CHARS ? painted.slice(-TAIL_CHARS) : painted
  const rows = tail.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!STOPS.test(row)) {
      if (row.includes(INCOMPLETE)) return null
      continue
    }
    if (!REPORTED.test(row)) continue
    if (frameAt(row) >= 0) return null
    if (SOMEBODY_SAID.test(row)) return null
    return row.trim()
  }
  return null
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
