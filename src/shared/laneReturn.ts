// Giving a copy of the project back when a chat clears itself.
//
// A pane that types `/clear` has finished with whatever it was doing, so the copy of the
// project it was sitting in can go back to the pool. Moving it is `manager.moveTo`, which
// RESTARTS the CLI in the new folder - and a restart drops the turn that is running plus
// any prompt queued behind it.
//
// 2026-09-10 00:54Z: a hand-typed `/clear` landed while the autoclear's own resume turn
// was running in the second copy. Two seconds later the pane was moved home, the turn was
// killed (exit 129), and the resume prompt was left unsent in a composer still wearing the
// old copy's name. The work was lost; the pane looked idle and green.
//
// So the move waits for the pane to be QUIET. A pane mid-turn keeps its copy and is told
// so; the copy is given back the next time that pane clears with nothing running.
//
// `npm run test:lanereturn`.

/** What the decision reads off a pane. Nothing else about a session matters here. */
export interface LanePane {
  /** The copy this pane is sitting in, if any. Nothing to give back without one. */
  lane?: string
  /** `exited` means the pane is gone; the sweep handles that folder, not this. */
  status?: string
  /** Set while a turn is running - the reason a move would destroy work. */
  runSince?: number
  /** The folder the pane is in now. A pane that has already moved is not ours. */
  cwd?: string
}

export type LaneReturn =
  | { move: false; why: 'no-lane' | 'gone' | 'moved-already' }
  | { move: false; why: 'mid-turn'; say: string }
  | { move: true }

/** What the pane is told when it keeps its copy. Plain words: no lane, no worktree. */
export const MID_TURN_WORDS = 'Cleared mid-turn - this pane stays in its copy until the turn ends'

/**
 * Whether a pane that just cleared may hand its copy of the project back.
 *
 * `before` is the pane as it was when the `/clear` was typed, `now` the same pane after
 * the wait for the CLI to settle. A pane that changed folder in between is somebody
 * else's business.
 */
export function mayReturnLane(before: LanePane | undefined, now: LanePane | undefined): LaneReturn {
  if (!before?.lane) return { move: false, why: 'no-lane' }
  if (!now || now.status === 'exited' || !now.lane) return { move: false, why: 'gone' }
  if (now.cwd !== before.cwd) return { move: false, why: 'moved-already' }
  if (now.runSince || now.status === 'working') {
    return { move: false, why: 'mid-turn', say: MID_TURN_WORDS }
  }
  return { move: true }
}
