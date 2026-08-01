// Is it safe to restart this app right now, without being asked to?
//
// The app updates itself several times a day, and a restart is not a blink for the
// panes: the installer path tears down every pty, so an agent mid-turn dies with the
// answer it was writing and comes back as a fresh session counting from zero. That is
// the "why did the running time reset" report, and it is also why the desk reopens over
// whatever was on screen.
//
// It lives here, on its own, so `npm run test:updatehold` can hold the rule against
// session shapes that actually occur - including the one that made a naive check wrong,
// an exited pane whose `runSince` was never cleared.

/** The two fields of a session this decision reads. Kept loose so a test can build one. */
export interface RunState {
  runSince?: number
  status: string
}

/**
 * How many panes have an agent in the middle of a turn.
 *
 * `status` is checked as well as `runSince`, and that is not belt-and-braces: a pane
 * whose agent exits mid-turn keeps the `runSince` it had - the run clock is stopped by
 * the idle sweep or by the footer going away, and an exited pane has neither. Counting
 * one of those would hold the restart for the rest of the session.
 */
export function agentsMidTurn(sessions: readonly RunState[]): number {
  return sessions.filter((s) => s.runSince && s.status !== 'exited').length
}
