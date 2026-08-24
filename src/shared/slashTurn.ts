// Is the line being submitted a slash command (/clear, /help, /compact) rather than a
// prompt for the agent? Decided from the keystrokes the app relays anyway, not from the
// screen: the CLI echoes typed text into a styled input box that is different per agent,
// while the keys themselves look the same everywhere.
//
// Why it matters: /clear redraws the screen, flashes a spinner while its hooks run and
// settles - which walks through every "a turn just ended" gate and rang the bell over a
// pane the user had cleared two seconds earlier. A slash command is housekeeping typed
// AT the CLI, not a question asked OF the agent, so it must not arm the end-of-turn
// chime (unless it turns out to run long - that promotion lives in sessions.ts).
//
// That promotion is itself wrong for a few of them, which is what `isQuietSlash` is for:
// see its own note.
//
// `npm run test:slash` holds this against real keystroke shapes.
//
// The loop itself now lives in `shared/draft.ts` - one parser for the three things that
// reconstruct what is being typed. This file keeps only the question it asks and the
// narrow rules that question needs, as `SLASH_OPTIONS`.

import type { DraftState } from './draft'
import { feedDraft, newDraft, SLASH_OPTIONS, SUBMIT_OPTIONS } from './draft'

/**
 * Fold one chunk of keystrokes into the line-so-far. Backspace erases ("/cl" backspaced
 * away and replaced with a question must not read as a command). Escape-prefixed chunks
 * - arrows, function keys, bracketed paste - are skipped whole: anything this cannot
 * follow errs toward "a real prompt", which is the reading that keeps the bell armed.
 */
export function typeLine(typed: string, data: string): string {
  // Enter clears the line here as it does everywhere; the caller asks the question
  // before feeding the Enter, so a submitted line is read while it still exists.
  return feedDraft({ text: typed, certain: true, inPaste: false }, data, SLASH_OPTIONS).state.text
}

/** The question the whole file exists for, asked at Enter. */
export function isSlashCommand(typed: string): boolean {
  return typed.trimStart().startsWith('/')
}

/**
 * Commands that leave NOTHING to read when they finish.
 *
 * Every other slash command is denied the bell for 30 seconds and then promoted if it
 * ran longer than that (SLASH_TURN_MS in sessions.ts), on the reasoning that a long run
 * must have turned into real work. These three break that reasoning: `/clear` and
 * `/resume` swap which conversation the pane is in and `/compact` rewrites the one it is
 * already in, so however long they take, what is on screen at the end is a fresh empty
 * prompt - there is no answer waiting to be read, and the chime sends you to look at
 * one that does not exist. Reported as "it pings when I clear the session; it acts like
 * the turn ended but it just cleared".
 *
 * Duration is exactly what makes this misfire on this machine: `/clear` runs the
 * SessionStart hooks (memory symlinks, lane assignment, handoff injection), which is
 * seconds of visible spinner, and any of them being slow pushed the run past 30s and
 * rang the bell.
 *
 * The next prompt typed into the pane is a real submit and re-arms everything, so this
 * silences the clear itself, never the work after it.
 */
export function isQuietSlash(typed: string): boolean {
  return /^\s*\/(clear|compact|resume)\b/.test(typed.trimStart())
}

/**
 * Did this submitted line throw the conversation AWAY?
 *
 * `/clear` alone, out of the three quiet commands: `/compact` rewrites the conversation
 * the pane is still in and `/resume` swaps in another one, and both leave a pane with a
 * history somebody may want to read. Only `/clear` puts the pane back where a brand new
 * one starts, which is the whole of what the sessions list means by "Ready" - see
 * `fleet.ts`. Without it `engaged` is sticky for the life of the session and a pane sits
 * under "Your move" for ever after its first turn.
 *
 * Partial forms count, for the reason `keepScrollback.mayClearScreen` documents at
 * length: what was TYPED is not what was SENT, and `/cle` picked out of the CLI's own
 * completion menu runs `/clear`. Only prefixes that can be nothing else - `cl`, `cle`,
 * `clea` - so `/c` (which is also `/compact`, `/config`, `/cost`) is left alone. Being
 * wrong in this direction costs a card reading Ready one turn early; being wrong the
 * other way is a pane that can never leave Your move.
 */
export function clearsConversation(typed: string): boolean {
  const t = typed.trimStart()
  if (/^\/clear\b/i.test(t)) return true
  const m = /^\/(cl[a-z]*)$/i.exec(t.trim())
  return Boolean(m && 'clear'.startsWith(m[1].toLowerCase()))
}

/**
 * The other half of the same keystroke: was anything actually SENT?
 *
 * `typeLine` answers "is this a slash command" and is deliberately blind to a paste and
 * to a history recall - it errs toward "a real prompt", which is the safe reading for
 * the bell. That blindness cannot answer "was the composer EMPTY", because a pasted
 * prompt and a bare return look identical to it, and reading an empty line as "nothing
 * was asked" would then park a pasted prompt in Ready.
 *
 * So this is a second, fuller reconstruction of the same keystrokes (`SUBMIT_OPTIONS`),
 * and `isBareReturn` is only true when the line is empty AND the parser has followed
 * every edit made to it. A paste, an up-arrow and a Tab completion each fail one of
 * those and are treated as a real prompt, exactly as before.
 */
export function newSubmitLine(): DraftState {
  return newDraft()
}

export function feedSubmitLine(prev: DraftState, data: string): DraftState {
  return feedDraft(prev, data, SUBMIT_OPTIONS).state
}

/** Nothing in the box, and nothing arrived that this could not follow. */
export function isBareReturn(line: DraftState): boolean {
  return line.text.trim() === '' && line.certain && !line.inPaste
}
