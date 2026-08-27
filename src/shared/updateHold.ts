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

/** The fields of a session this decision reads. Kept loose so a test can build one. */
export interface RunState {
  runSince?: number
  status: string
  /** there is a conversation in this pane somebody may be in the middle of */
  engaged?: boolean
  /** epoch ms the pty last printed */
  lastOutput?: number
  /** epoch ms somebody last typed into it */
  lastKeyboard?: number
}

/**
 * How long a conversation has to have been quiet before a restart may take it.
 *
 * `agentsMidTurn` was the whole rule, and it is too narrow by exactly the case that
 * happened: 2026-08-27 11:41:48, three panes open, one of them nine asks into a
 * conversation and between turns. Nothing was mid-turn, so the automatic restart fired,
 * every pty died, and the desk came back with the conversations resumed but the screens
 * repainted from scratch - which reads as the app clearing a session nobody asked it to.
 * The pane's own words on the way back were "why did you just clear without doing a
 * handoff or anyhitng please fix this issue".
 *
 * A turn boundary is not a safe moment; it is the pause in the middle of somebody working.
 * So an ENGAGED pane also holds the restart until it has been quiet this long, which is
 * long enough that the desk is genuinely abandoned and short enough that an update still
 * lands the same day. A pane with no conversation in it holds nothing.
 */
export const DESK_QUIET_MS = 10 * 60_000

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

/**
 * Panes an unprompted restart would interrupt: mid-turn, or in a conversation that is
 * still warm.
 *
 * Deliberately NOT used by the clicked path. A person pressing Restart now has decided;
 * this is the rule for the restart nobody asked for.
 */
export function deskBusy(
  sessions: readonly RunState[],
  now: number,
  quietMs = DESK_QUIET_MS
): number {
  return sessions.filter((s) => {
    if (s.status === 'exited') return false
    if (s.runSince) return true
    if (!s.engaged) return false
    const seen = Math.max(s.lastOutput ?? 0, s.lastKeyboard ?? 0)
    // No timestamps at all is not a licence to restart over it: an engaged pane the caller
    // cannot date is treated as warm, because the expensive mistake is the other one.
    return !seen || now - seen < quietMs
  }).length
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
