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
// `npm run test:slash` holds this against real keystroke shapes.

/**
 * Fold one chunk of keystrokes into the line-so-far. Backspace erases ("/cl" backspaced
 * away and replaced with a question must not read as a command). Escape-prefixed chunks
 * - arrows, function keys, bracketed paste - are skipped whole: anything this cannot
 * follow errs toward "a real prompt", which is the reading that keeps the bell armed.
 */
export function typeLine(typed: string, data: string): string {
  if (!data || data.startsWith('\x1b')) return typed
  for (const ch of data) {
    if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1)
    else if (ch >= ' ') typed = (typed + ch).slice(-200)
  }
  return typed
}

/** The question the whole file exists for, asked at Enter. */
export function isSlashCommand(typed: string): boolean {
  return typed.trimStart().startsWith('/')
}
