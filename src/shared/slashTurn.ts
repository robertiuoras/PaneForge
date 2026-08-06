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

import { feedDraft, SLASH_OPTIONS } from './draft'

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
