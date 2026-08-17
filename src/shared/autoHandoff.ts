// Moving panes to the other machine by itself, when this one is full.
//
// `capacity.ts` already knew when a desk was in trouble and already knew a paired device
// could help - `offloadTarget` sends the NEXT pane over there. But the pane that is eating
// the machine is one that is already open, and the only lever this app had for those was
// `reclaim.ts`, which CLOSES them. Closing is cheap to undo here and it is still the wrong
// answer while another machine is sitting idle with room: the work stops.
//
// So the ladder, cheapest and least destructive first, and each rung only runs when the one
// above it did not solve it:
//
//   1. trim scrollback            (capacity.ts)  - gives back ~5%, costs nothing
//   2. start the NEXT pane there  (capacity.ts)  - stops it getting worse
//   3. MOVE a finished pane there (this file)    - the work continues, on the other desk
//   4. close a finished pane      (reclaim.ts)   - the last resort, and only with no peer
//
// Rung 3 is only defensible because of what a handoff already is: the conversation, the
// code and the screen all travel, the sender's pane only closes once the far end says its
// replacement is running, and a pane whose repo cannot be pushed fails BY NAME and stays
// open. Nothing here can lose work that the manual button could not already lose.
//
// Two refusals decide whether this is safe rather than merely clever:
//
//   - **A pane mid-turn is never moved.** A handoff kills the pty, and killing a pty
//     mid-turn throws away the answer being written - the far end resumes from the
//     transcript, which only holds turns the CLI has already flushed. So a busy pane is
//     QUEUED and moved the instant its turn ends. That is what makes "hand off mid-turn"
//     mean the move happens as soon as it can rather than the turn being lost.
//   - **A pane holding a live question is never moved**, queued or otherwise. The chooser
//     is drawn on a screen, not in the transcript; resuming over there comes back with the
//     question gone and the agent waiting for something nobody was asked.
//
// Everything else is the same shape as `reclaim.ts`: pressure is the trigger, never a
// clock; the focused pane and anything on screen are left alone; a failure puts that pane
// on a cooldown so a repo that cannot be pushed is not retried every fifteen seconds.
//
// Pure. `npm run test:autohandoff`.

import type { OffloadCandidate, Verdict } from './capacity'
import type { FleetState } from './fleet'

export interface AutoHandoffConfig {
  /** Move finished panes to a paired device when this machine runs out of memory. */
  enabled: boolean
  /** How long a pane must have been quiet first, in minutes. */
  minIdleMinutes: number
  /** How many to move per reading. The next reading decides again. */
  maxPerSweep: number
  /** How long a pane that failed to move is left alone, in minutes. */
  cooldownMinutes: number
  /**
   * How long a pane queued mid-turn waits for its turn to end before the move is given up
   * on and said so. Never killed instead: the whole point of the queue is that a turn is
   * worth more than a megabyte.
   */
  waitMinutes: number
}

export const DEFAULT_AUTO_HANDOFF: AutoHandoffConfig = {
  // On by default, because the refusals above are what make it safe and they hold whether
  // or not anybody read a setting. It still cannot fire without a paired device that is
  // online AND holds the same project by name, which is a desk that was set up on purpose.
  enabled: true,
  minIdleMinutes: 10,
  maxPerSweep: 2,
  cooldownMinutes: 30,
  waitMinutes: 30
}

export interface AutoPane {
  id: string
  state: FleetState
  /** epoch ms of the last thing a person typed into it */
  lastKeyboard: number
  focused: boolean
  visible: boolean
  /** another device's pty, mirrored here - moving it frees nothing on this machine */
  remote: boolean
  /** already on its way somewhere, from an earlier sweep or the button */
  handingOff: boolean
  /**
   * The pane is sitting on a question the agent drew on screen: a chooser, or a rung bell.
   *
   * Separated from `state` on purpose. `fleetState` calls a pane `needsYou` both when a
   * turn simply ENDED and when a question is live, and those are opposites here: a finished
   * turn is the best possible moment to move a pane, and a live question is the one moment
   * that must not be.
   */
  asking: boolean
  /** what this pane's folder is called as a project - the only portable name for it */
  projectName: string
}

export interface AutoHandoff {
  id: string
  device: string
  deviceName: string
  /** THAT device's path for the same project, so the far end opens the right folder */
  cwd: string
  idleMs: number
}

/** States a pane may be moved out of. Everything else is a turn in flight. */
export function movable(p: Pick<AutoPane, 'state' | 'asking'>): boolean {
  if (p.asking) return false
  // `exited` is left to reclaim: there is no agent to move, only a row to close.
  return p.state === 'ready' || p.state === 'needsYou'
}

/** The peer that can take this project, or null. Same rules as `offloadTarget`. */
export function hostFor(
  peers: OffloadCandidate[],
  projectName: string
): { device: string; deviceName: string; cwd: string } | null {
  if (!projectName) return null
  for (const c of peers) {
    if (!c.online) continue
    const hit = c.projects.find((p) => p.name === projectName)
    if (hit) return { device: c.device, deviceName: c.deviceName, cwd: hit.path }
  }
  return null
}

/**
 * Which panes to move, and where, or an empty list.
 *
 * `blocked` is id -> epoch ms until which that pane is not to be retried, which is how a
 * repo with an unpushable checkout stops being asked about on every reading.
 */
export function autoHandoffPlan(
  panes: AutoPane[],
  v: Verdict,
  peers: OffloadCandidate[],
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  blocked: Record<string, number> = {},
  now = 0
): AutoHandoff[] {
  if (!cfg.enabled) return []
  // The same trigger as every other rung: `ok` means the kernel is content, and moving
  // somebody's pane to another machine while there is room here is not a tidy-up, it is
  // the app deciding where they work.
  if (v.level === 'ok') return []
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = Math.max(0, cfg.minIdleMinutes) * 60_000

  const out: AutoHandoff[] = []
  const eligible = panes
    .filter((p) => !p.focused && !p.visible && !p.remote && !p.handingOff && movable(p))
    .filter((p) => now - p.lastKeyboard >= minIdle)
    .filter((p) => !((blocked[p.id] ?? 0) > now))
    .sort((a, b) => a.lastKeyboard - b.lastKeyboard)

  // Never the last pane, for the same reason reclaim never empties the window: a desk with
  // nothing on it has not been helped.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  for (const p of eligible.slice(0, room)) {
    const host = hostFor(peers, p.projectName)
    if (!host) continue
    out.push({ id: p.id, ...host, idleMs: now - p.lastKeyboard })
    if (out.length >= cfg.maxPerSweep) break
  }
  return out
}

// ---------------------------------------------------------------------------
// The queue: a pane asked for mid-turn, moved when the turn ends

export interface Queued {
  id: string
  device: string
  /** epoch ms it was asked for */
  since: number
  closeReceiverWhenDone?: boolean
}

/** What to do with a queued pane on this tick. */
export type QueueVerdict =
  /** its turn has ended and no question is on screen: move it now */
  | 'go'
  /** still working, or holding a question: leave it queued */
  | 'wait'
  /** it waited longer than the budget: give up and say so, never kill it */
  | 'expired'
  /** the pane is gone - closed, or exited on its own */
  | 'drop'

export function queueVerdict(
  q: Queued,
  pane: Pick<AutoPane, 'state' | 'asking'> | undefined,
  cfg: AutoHandoffConfig = DEFAULT_AUTO_HANDOFF,
  now = 0
): QueueVerdict {
  if (!pane || pane.state === 'exited') return 'drop'
  if (movable(pane)) return 'go'
  if (now - q.since >= Math.max(1, cfg.waitMinutes) * 60_000) return 'expired'
  return 'wait'
}

/** The line the pane's report prints while it is waiting. */
export function queuedNote(deviceName: string): string {
  return `Working - moving to ${deviceName} as soon as this turn ends`
}
