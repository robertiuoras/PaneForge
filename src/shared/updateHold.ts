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

/** What a press of "Restart now" comes to. `wait` carries what the card has to name. */
export type InstallDecision =
  | { act: 'install' }
  | { act: 'wait'; busy: number }
  | { act: 'nothing' }

/**
 * The whole of what the click decides, kept here so it can be tested at all.
 *
 * In `npm run dev` there is no update metadata, so `phase` never reaches 'ready' and the
 * running app can never take the branch below - the one place this rule actually fires
 * is a real installed build with a real download waiting. A decision that can only be
 * exercised in production is a decision that ships untested, which is how the automatic
 * path came to retry three full teardowns inside three minutes over eight busy panes.
 */
export function decideInstall(opts: {
  phase: string
  installStarted: boolean
  sessions: readonly RunState[]
}): InstallDecision {
  // Already going. A second click is not a second restart.
  if (opts.installStarted) return { act: 'install' }
  if (opts.phase !== 'ready') return { act: 'nothing' }
  const busy = agentsMidTurn(opts.sessions)
  return busy > 0 ? { act: 'wait', busy } : { act: 'install' }
}
