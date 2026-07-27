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
