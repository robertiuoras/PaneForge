// Is the agent still working? Read off the bottom of its own screen.
//
// This is the single fact the whole "is this pane busy" mechanism rests on: the run
// clock, the green dot, and whether the bell is allowed to ring. It lived as two
// regexes inside TerminalPane and went silently wrong when Claude Code changed its
// working line - every pane read as finished four seconds after its last frame, so the
// turn clock froze mid-turn and the sidebar said "waiting for you" over a running
// agent. Nothing failed loudly, because "no footer" is a legal reading.
//
// It is here, on its own, so `npm run test:busy` can hold it against real captured
// frames from the CLIs this app drives. Add a frame to that test whenever a CLI
// changes its footer - that is cheaper than finding out from a frozen clock.

/**
 * The older, explicit form: the CLI says how to stop it. Claude Code used to print
 * this, Codex still does, and it stays first because it is unambiguous.
 */
const SAYS_INTERRUPT =
  /esc to interrupt|esc to cancel|ctrl\+c to (stop|interrupt|cancel)|press esc to stop|esc interrupt|working…|thinking…/i

/**
 * Claude Code 2.1 dropped the hint and prints a spinner glyph, an invented gerund and
 * an ellipsis instead: "✢ Smooshing… (8s · ↓ 282 tokens)", "✶ Cultivating…". The
 * ellipsis is the load-bearing part - the same line in the past tense is how that CLI
 * reports a turn that ENDED ("✻ Sautéed for 10s · 1 shell still running"), and matching
 * that would leave a finished pane counting forever.
 *
 * Glyphs only, never a bullet or an asterisk: a markdown list in an answer sits in the
 * same rows, and "* one of the things we tried…" must not read as a running agent.
 */
const SPINNING = /^[^\S\n]*[✢✳✶✻✽✷✺◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S[^\n]*…/m

/**
 * The live counter that ticks beside the spinner - "(8s · ↓ 282 tokens)", and the
 * "(esc to interrupt · 12s)" of older builds. Independent of whatever word the CLI
 * decided to spin today, which is the point: one of these three has to survive the
 * next rename.
 */
const COUNTING = /\(\d+s\s*·/

/**
 * The agent is asking *you* something: a permission prompt, a tool approval, a choice.
 * This outranks everything above, because the two are on screen together - the CLI is
 * technically mid-turn, but nothing moves until you answer, and the pane claiming to be
 * working is what makes you leave it sitting there. Numbered-choice lines are matched
 * with their selection arrow only, so a numbered list in an answer cannot trigger it.
 */
export const ASK_PROMPT =
  /do you want to (proceed|continue|make|create|allow|run)|allow (this )?(command|tool|edit)\?|❯\s*\d+\.\s|\(y\/n\)\s*$|press enter to (confirm|continue)|waiting for your (input|reply)/im

/** True while the frame says an agent is running and is not waiting on an answer. */
export function readsBusy(text: string): boolean {
  if (ASK_PROMPT.test(text)) return false
  return SAYS_INTERRUPT.test(text) || SPINNING.test(text) || COUNTING.test(text)
}

/**
 * How long the AGENT says this turn has been running.
 *
 * The app's own run clock is a guess at when the turn began - it starts at whichever of
 * "a prompt was submitted" or "the footer said busy" this app noticed first. Anything
 * that hides a turn boundary (a pane opened mid-turn, a session restored from disk, a
 * frame the busy read missed for a second and a half) leaves that guess late, and a
 * late start is a readout that is quietly too small: a turn Claude Code was calling
 * 24m showed as 12m in the sidebar, with nothing anywhere saying which was right.
 *
 * The CLI is printing the true number in its own footer, so read that instead and use
 * it as the origin. Claude Code's formatter is `8s`, `24m 3s`, `24m`, `1h 2m 3s`,
 * `1h 2m`, `1h`; older builds put the same thing beside the interrupt hint,
 * "(esc to interrupt · 2m 14s)".
 *
 * Only ever read from INSIDE parentheses. A statusline is full of bare durations
 * ("5h 48% · wk 69%"), and one of those read as a turn clock would move the sidebar's
 * number by hours.
 */
const DURATION = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/

export function readsElapsedMs(text: string): number | null
export function readsElapsedMs(text: string, withGrain: true): { ms: number; grain: number } | null
export function readsElapsedMs(
  text: string,
  withGrain = false
): number | { ms: number; grain: number } | null {
  let found: { ms: number; grain: number } | null = null
  // Every parenthesised run on the frame, last one wins: the footer is at the bottom.
  for (const paren of text.matchAll(/\(([^)\n]{1,80})\)/g)) {
    for (const part of paren[1].split('·')) {
      const s = part.trim()
      if (!/^\d/.test(s)) continue
      const m = DURATION.exec(s)
      if (!m || (!m[1] && !m[2] && !m[3])) continue
      const h = Number(m[1] ?? 0)
      const min = Number(m[2] ?? 0)
      const sec = Number(m[3] ?? 0)
      found = {
        ms: (h * 3600 + min * 60 + sec) * 1000,
        // What the CLI rounded to. A reading of "24m" says nothing about the seconds,
        // so a clock anchored to it must not be corrected by less than a minute.
        grain: m[3] ? 1000 : m[2] ? 60_000 : 3_600_000
      }
    }
  }
  if (!found) return null
  return withGrain ? found : found.ms
}

/**
 * Where the run clock should have started, given what the agent says.
 *
 * Returns null when the current start time is already right - which is most ticks, and
 * the reason this is a check rather than a straight assignment: a reading of "24m" says
 * nothing about the seconds inside it, so re-deriving the start from every frame would
 * drag the readout backwards and forwards by up to a minute while nothing was wrong.
 */
export function anchoredStart(now: number, runSince: number, clock: TurnClock): number | null {
  const want = now - clock.ms
  return Math.abs(want - runSince) > clock.grain + 2000 ? want : null
}

export interface TurnClock {
  ms: number
  grain: number
}
