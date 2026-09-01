// A pane whose commands are being REFUSED, and by which gate.
//
// The agent CLIs on this desk run under a stack of hooks that can refuse a command
// before it executes. A refusal is not an error the agent made and not something the
// app did - it is a third party in the pane saying no - and until now it left no trace
// anywhere a person looks. It is invisible on the card, invisible in History, and the
// only record is the transcript, which is exactly the place nobody reads while the work
// is happening.
//
// Why it is worth drawing at all, measured 2026-09-01 on this machine: one gate
// (`run-guard`'s PreToolUse deny) fired 991 times in seven days, 573 of those at its own
// hardest setting, and a single clients pane that morning had 7 of its 57 tool calls
// refused. Each refusal costs a full round trip and buys nothing when the gate is
// mis-tuned, so a gate firing over and over in one pane is the tell that the GATE is
// wrong, not the agent. That reading is only available by counting.
//
// So: count them per pane, and when the pane stops being refused, write ONE line saying
// which gate refused how many. One row per stretch, never one per refusal - a list with
// seven rows saying the same thing is the noise this is supposed to replace.
//
// This decorates and refuses. It reaches no busy reading, no status, no clock; the same
// contract `Session.backJob` and `shared/handoffSteps.ts` keep.

/** The gates this desk actually runs, named the way their own output names them. */
export type DenyGate = 'run-guard' | 'command-lessons' | 'bash-guard' | 'a hook'

export interface DenySeen {
  gate: DenyGate
  /** Where in the scanned text it was found, so a caller can dedupe a re-render. */
  line: string
}

/**
 * A stretch is over once the pane has gone this long without another refusal. Chosen
 * to be longer than one generation (~7s) so a run that is being refused every second or
 * third call still reads as ONE stretch, and short enough that the row appears while the
 * person is still looking at what caused it.
 */
export const STRETCH_QUIET_MS = 45_000

/** Below this, a refusal is a one-off and says nothing about the gate. No row. */
export const MIN_FOR_ROW = 2

/** Terminal escapes, so a marker split by a colour change is still read. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n')
}

/**
 * Everything a CLI is allowed to print in FRONT of the marker on the same line.
 *
 * Load-bearing refusal: once a refusal has been submitted back to the agent, the CLI
 * echoes the whole text again as part of the conversation, and a person can paste one
 * into a prompt. Both of those arrive behind a `>` prompt marker or inside a quote, so a
 * line carrying anything other than the tool-result furniture is somebody TALKING about
 * a refusal, not a refusal. Same lesson as `shared/recover.ts`.
 */
// Furniture is anything that is not a letter or a digit - the CLIs draw a different box
// character every release, so listing them was a maintenance trap - plus the one word
// `Error:` they put in front of a tool result. A prompt marker or a quote character
// anywhere in front of the marker disqualifies the line outright.
const FURNITURE = /^(?![^]*[>"'`])[^A-Za-z0-9]*(Error:\s*)?[^A-Za-z0-9]*$/

interface Rule {
  gate: DenyGate
  at: RegExp
}

// Ordered: the first rule that matches names the gate. `a hook` is last and catches a
// refusal from a gate this build has never heard of rather than dropping it - a new gate
// firing constantly is exactly the thing worth seeing.
const RULES: Rule[] = [
  { gate: 'run-guard', at: /BLOCKED: \d+ consecutive Bash calls/ },
  { gate: 'bash-guard', at: /BLOCKED by bash-guard:/ },
  { gate: 'command-lessons', at: /command-lessons: .*(DENIED|denied)/ },
  { gate: 'a hook', at: /BLOCKED: / }
]

/**
 * Read the refusals out of a chunk of what a pane printed.
 *
 * Pure, and deliberately cheap: this runs on the pty's own data path, where anything
 * expensive is paid once per painted frame of every pane on the desk.
 */
export function readDenies(text: string): DenySeen[] {
  if (!text || !text.includes('BLOCKED') && !text.includes('command-lessons:')) return []
  const out: DenySeen[] = []
  for (const line of plain(text).split('\n')) {
    for (const rule of RULES) {
      const m = rule.at.exec(line)
      if (!m) continue
      if (!FURNITURE.test(line.slice(0, m.index))) break
      out.push({ gate: rule.gate, line: line.trim().slice(0, 200) })
      break
    }
  }
  return out
}

export interface Stretch {
  gate: DenyGate
  count: number
  /** Last refusal, epoch ms. The stretch ends `STRETCH_QUIET_MS` after this. */
  at: number
}

/** Is this stretch over, and does it have enough in it to be worth a row? */
export function stretchDue(s: Stretch, now: number): boolean {
  return now - s.at >= STRETCH_QUIET_MS && s.count >= MIN_FOR_ROW
}

/**
 * The sentence for the bell. The row's own left column carries the verb, so this must
 * not start with one - `Refused refused (4) clients` was the first thing the sibling
 * list drew on a real desk.
 */
export function denyWords(gate: DenyGate, count: number): string {
  return `${count} commands in a row, by ${gate}`
}
