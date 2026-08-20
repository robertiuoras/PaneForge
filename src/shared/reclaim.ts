// Giving a full machine its memory back by closing panes nobody is using.
//
// `capacity.ts` measured where a desk's memory goes and then gave back the only part it
// could give back instantly: scrollback. That is the right first move and it is a small
// one. Measured on this desk 2026-08-14 with twelve panes open:
//
//   9 claude CLIs          1.19 GB   (64-233 MB each)
//   3 codex CLIs             50 MB   (16-17 MB each - an order of magnitude cheaper)
//   PaneForge, 5 processes  270 MB
//   trimming all 12 panes' scrollback   ~74 MB, about 5% of it
//
// So the agent inside the pane is the cost, and the only way to give an agent back is to
// close its pane. Every terminal refuses to do that for a good reason - closing somebody's
// work is not a memory optimisation, it is losing their work.
//
// What makes it defensible HERE, and nowhere else, is that closing a pane in this app is
// nearly free to undo. `kill()` calls `recordEnd`, so the pane keeps its History row; the
// row carries `resumeId` and `scrollbackId`; reopening restores the agent's conversation
// AND what was on the screen. That is `test:restore` and `test:scrollback`, both of which
// existed before this. A closed pane here is a minimised pane everywhere else.
//
// The policy is still deliberately timid, because "nearly free" is not free:
//
//   - It is triggered by PRESSURE, never by a clock. A pane idle for six hours on a
//     machine with room to spare is costing nobody anything, and closing it would be the
//     app tidying up after somebody who did not ask to be tidied up after. Idle time only
//     breaks ties between panes once the machine is already in trouble.
//   - It never touches a pane that is working, starting, stalled, or waiting for a person.
//     `needsYou` is the one that would feel like theft: the agent asked a question, the
//     answer is owed, and the pane looks idle precisely because it is waiting.
//   - It never touches the pane being looked at, or one on screen, or a mirror of another
//     device's pty (which costs this machine a socket and a buffer, not an agent).
//   - It closes at most a couple at a time and re-decides on the next reading, so the
//     machine's own recovery stops it rather than a number guessed here.
//
// Pure: no Electron, no `os`. `npm run test:reclaim`.

import { SESSION_MB, type Verdict } from './capacity'
import type { FleetState } from './fleet'

/**
 * States that may be closed to reclaim memory. Everything else is somebody's business.
 *
 * `needsYou` is in the list and `asking` is what keeps it honest. That state is two facts
 * wearing one name - an agent that ASKED something, and an agent that FINISHED and is
 * sitting at its composer - and refusing the whole state to protect the first refused the
 * second as well. A finished pane is the only pane anybody ever wants closed, so with
 * `ready | exited` this sweep could only ever reach a CLI nobody had typed into at all:
 * measured on this desk 2026-08-20, every pane on it was `needsYou` and the sweep had
 * therefore never closed anything in its life. The refusal that was actually meant is the
 * one below, and it reads the pane's own live question rather than the word for its state.
 */
const CLOSEABLE: ReadonlySet<FleetState> = new Set<FleetState>(['ready', 'exited', 'needsYou'])

export interface ReclaimConfig {
  /** Close idle panes when this machine runs out of memory. */
  enabled: boolean
  /**
   * How long a pane must have been quiet before it may be closed, in minutes.
   *
   * Measured from lastKeyboard (user input), not pty output (which repaints for status updates).
   * 15 minutes is short enough to reclaim under pressure without losing recent work, and long
   * enough to avoid closing a pane somebody is actively thinking about.
   */
  minIdleMinutes: number
  /** How many to close per reading. The next reading decides again. */
  maxPerSweep: number
  /**
   * Close a pane nobody has typed into for this many minutes, whatever the machine's
   * memory says. 0 is off, and off is the default.
   *
   * This is the one thing the paragraph above refuses to do on the desk you are sitting
   * at, and the refusal still stands there: a pane idle six hours on a machine with room
   * is costing nobody anything. What changes it is a machine nobody is sitting at - a
   * second desk driven over the device link, which fills up with panes that were finished
   * hours ago and has no person to close them. So the clock exists, it is off unless
   * somebody sets it, and every refusal that keeps the pressure sweep timid is shared with
   * it verbatim: never a pane that is working, starting, stalled or waiting for a person,
   * never a mirror of some other machine's pty, never the focused pane, never the last one.
   *
   * Long by default when it is turned on at all: the cost of closing too early is somebody
   * reopening from History, and the cost of never closing is a machine that is out of
   * memory in the morning. 120 minutes is the number set on this desk's PC.
   */
  idleCloseMinutes: number
}

/**
 * What the Settings switch sets `idleCloseMinutes` to when it is turned on.
 *
 * Two hours, which is eight times what the pressure sweep waits, for the reason the
 * field's own comment gives: being early under pressure costs a reopen from History, and
 * being early on a clock closes a pane somebody was coming back to. It is the number
 * already running on this desk's PC.
 */
export const IDLE_CLOSE_MINUTES = 120

export const DEFAULT_RECLAIM: ReclaimConfig = {
  enabled: true,
  minIdleMinutes: 15,
  maxPerSweep: 2,
  idleCloseMinutes: 0
}

export interface ReclaimPane {
  id: string
  state: FleetState
  /** Epoch ms of this pane's most recent user input (better idle signal than pty output, which repaints). */
  lastKeyboard: number
  /** The pane being read. Never closed, at any pressure. */
  focused: boolean
  /** Drawn in the grid right now. Never closed - it is on somebody's screen. */
  visible: boolean
  /** Another device's pty, mirrored here. Closing it frees no agent on this machine. */
  remote: boolean
  /**
   * The agent has a question on screen that nobody has answered.
   *
   * This is the one that would feel like theft, and it is the reason `needsYou` alone is
   * not a refusal: the pane is quiet BECAUSE it is owed an answer, and every idle reading
   * in the app says yes about it. It comes from the pane's own `ask`, never from its state.
   */
  asking?: boolean
  /**
   * Already on its way to another device - see shared/autoHandoff.ts.
   *
   * Closing it would be the same memory saved and the work lost: the move is mid-flight,
   * so the far end is about to start the pane this one would have been reopened from.
   * Moving beats closing whenever both are available, which is why the ladder puts the
   * handoff sweep above this one.
   */
  handingOff?: boolean
}

export interface Reclaim {
  id: string
  /** How long it had been quiet, ms. Goes in the log line so the choice is auditable. */
  idleMs: number
  /** Whether closing it frees an agent, or only a buffer. */
  hadAgent: boolean
}

/**
 * Which panes to close, oldest-quiet first, or an empty list.
 *
 * Empty is the answer for everything except a machine that is actually in trouble with
 * panes that are actually finished. `now` is passed rather than read so this is testable.
 */
export function reclaimPlan(
  panes: ReclaimPane[],
  v: Verdict,
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): Reclaim[] {
  if (!cfg.enabled) return []
  // The trigger. `ok` means the kernel is content and the budget has room; anything the
  // app did there would be tidying, not reclaiming.
  if (v.level === 'ok') return []
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = Math.max(0, cfg.minIdleMinutes) * 60_000

  const eligible = panes
    .filter((p) => !p.focused && !p.visible && !p.remote && !p.handingOff && !p.asking && CLOSEABLE.has(p.state))
    .filter((p) => now - p.lastKeyboard >= minIdle)
    // Oldest quiet first: of two finished panes, the one nobody has looked at since this
    // morning is the safer one to close than the one that finished a minute ago.
    .sort((a, b) => a.lastKeyboard - b.lastKeyboard)

  // Never the last pane. An app that empties its own window under memory pressure has
  // not solved the problem, it has removed the reason the window is open.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  return eligible.slice(0, Math.min(cfg.maxPerSweep, room)).map((p) => ({
    id: p.id,
    idleMs: now - p.lastKeyboard,
    // An exited pane's process is already gone: closing it returns a buffer, not an agent.
    // Saying so keeps the log line honest about what was actually bought.
    hadAgent: p.state !== 'exited'
  }))
}

/**
 * Which panes have simply been quiet too long, or an empty list.
 *
 * The clock the sweep above refuses to have, for the machine that has no person: same
 * refusals, one different trigger, and off unless `idleCloseMinutes` says otherwise.
 *
 * `visible` is deliberately NOT a refusal here, and it is the only one dropped. It exists
 * up there because closing something on somebody's screen while their machine is busy is
 * theft; down here the clock has already established that nobody has typed into this pane
 * for hours, and on a desk nobody is sitting at every pane in the grid is "on screen". Keep
 * it and the feature can never fire on the machine it was built for.
 */
export function idleClosePlan(
  panes: ReclaimPane[],
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): Reclaim[] {
  if (!cfg.enabled) return []
  const minutes = Math.max(0, cfg.idleCloseMinutes ?? 0)
  if (!minutes) return []
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = minutes * 60_000

  const eligible = panes
    .filter((p) => !p.focused && !p.remote && !p.handingOff && !p.asking && CLOSEABLE.has(p.state))
    .filter((p) => now - p.lastKeyboard >= minIdle)
    .sort((a, b) => a.lastKeyboard - b.lastKeyboard)

  // Same last-pane rule as the pressure sweep: an app that empties its own window has not
  // saved anything, it has removed the reason the window is open.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  return eligible.slice(0, Math.min(cfg.maxPerSweep, room)).map((p) => ({
    id: p.id,
    idleMs: now - p.lastKeyboard,
    hadAgent: p.state !== 'exited'
  }))
}

/** MB the plan is expected to return, for the line that says whether it was worth doing. */
export function reclaimedMb(plan: Reclaim[]): number {
  return plan.reduce((mb, p) => mb + (p.hadAgent ? SESSION_MB : 0), 0)
}
