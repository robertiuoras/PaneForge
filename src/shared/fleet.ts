// One pane, reduced to the three things you want without opening it: what it is doing,
// who is expected to act, and how much it has changed.
//
// This is the arithmetic half of the Fleet view, kept out of the component for the same
// reason `place.ts` is - it is a pile of small judgements about words and ordering, every
// one of which is worth pinning, and none of which needs a window. `npm run test:fleet`.
//
// The state list is deliberately LONGER than `SessionStatus`. A session's status answers
// "is the pty printing", which is a fact about a process; this answers "does anybody need
// to do anything", which is the question a person actually opens the app with. Two panes
// both reading `idle` are a finished turn and a CLI nobody has typed into yet, and those
// are not the same screen at all.

import type { GitInfo, Session } from './types'

export type FleetState =
  | 'needsYou'  // a turn ended, or the terminal rang: your move
  | 'stalled'   // a turn is still running and the pane has gone quiet mid-run
  | 'working'   // printing
  | 'starting'  // spawned, nothing on screen yet
  | 'ready'     // a CLI that has been asked nothing - quiet, but it has finished nothing
  | 'exited'    // the process ended

/**
 * Who the motion is for.
 *
 * Every competitor signals a running job with a spinner per row, which is a lot of
 * movement that all means the same thing. The one pattern worth copying (Vercel's status
 * dot, Cursor's Dynamic Island) is the opposite: whether a thing moves at all is the
 * signal, and the movement STOPPING is the event. So there are exactly two motions and
 * they mean different things - `pulse` is the app working, `call` is the app waiting on
 * you - and a terminal state is perfectly still.
 */
export type FleetMotion = 'pulse' | 'call' | 'still'

export interface FleetRow {
  state: FleetState
  /** what the row says out loud */
  label: string
  motion: FleetMotion
  /**
   * Epoch ms the row's clock counts from, undefined when a duration would say nothing.
   * Which moment that is changes with the state: a working pane counts its turn, a
   * stalled one counts the silence, a finished one counts how long it has been waiting.
   */
  since?: number
  /** sort key - the whole point of the screen is that the top row is the one to look at */
  rank: number
}

const LABEL: Record<FleetState, string> = {
  needsYou: 'waiting for you',
  stalled: 'quiet mid-turn',
  working: 'working',
  starting: 'starting',
  ready: 'ready - type to start',
  exited: 'exited'
}

const MOTION: Record<FleetState, FleetMotion> = {
  needsYou: 'call',
  stalled: 'call',
  working: 'pulse',
  starting: 'pulse',
  ready: 'still',
  exited: 'still'
}

/** Sorted the way the screen reads: whoever needs a person is at the top. */
const RANK: Record<FleetState, number> = {
  needsYou: 0,
  stalled: 1,
  working: 2,
  starting: 3,
  ready: 4,
  exited: 5
}

export function fleetState(s: Session): FleetState {
  if (s.status === 'exited') return 'exited'
  // A rung bell outranks everything a live process could be doing: the CLI is asking a
  // question, and it can ask one mid-turn.
  if (s.bell) return 'needsYou'
  // Checked before `working`, because a stalled pane IS working as far as the pty knows -
  // that is exactly what makes it worth a row of its own.
  if (s.stalledSince !== undefined) return 'stalled'
  if (s.status === 'working') return 'working'
  if (s.status === 'starting') return 'starting'
  return s.engaged ? 'needsYou' : 'ready'
}

export function fleetRow(s: Session): FleetRow {
  const state = fleetState(s)
  const since =
    state === 'stalled'
      ? s.stalledSince
      : state === 'working'
        ? (s.runSince ?? s.lastOutput)
        : state === 'needsYou'
          ? s.lastOutput
          : state === 'starting'
            ? s.createdAt
            : undefined
  return {
    state,
    label: state === 'exited' && s.exitCode ? `exited (${s.exitCode})` : LABEL[state],
    motion: MOTION[state],
    since,
    rank: RANK[state]
  }
}

/**
 * The order the rows are drawn in.
 *
 * By state first, then by how long the row has been in that state, oldest first - the
 * pane that has been waiting on you for eleven minutes is more interesting than the one
 * that finished four seconds ago, and a stall gets worse with age. Panes with no clock
 * keep the order they were opened in, so the screen does not reshuffle under the mouse.
 */
export function fleetOrder(sessions: Session[]): Session[] {
  const rows = new Map(sessions.map((s) => [s.id, fleetRow(s)]))
  const at = new Map(sessions.map((s, i) => [s.id, i]))
  return [...sessions].sort((a, b) => {
    const ra = rows.get(a.id)!
    const rb = rows.get(b.id)!
    if (ra.rank !== rb.rank) return ra.rank - rb.rank
    if (ra.since !== undefined && rb.since !== undefined && ra.since !== rb.since)
      return ra.since - rb.since
    return at.get(a.id)! - at.get(b.id)!
  })
}

/** How many rows want a person right now - the number the button wears. */
export function fleetWaiting(sessions: Session[]): number {
  return sessions.filter((s) => {
    const st = fleetState(s)
    return st === 'needsYou' || st === 'stalled'
  }).length
}

export interface Density {
  /** 0-1, how wide the whole bar is drawn - log-scaled, see below */
  weight: number
  /** 0-1 of the drawn bar, the two ends always summing to 1 when there is anything */
  added: number
  removed: number
  total: number
}

/**
 * How much this pane has changed, as one bar.
 *
 * Linear rather than log would make every ordinary diff invisible: 40 lines beside one
 * 3,000-line refactor is 1.3% of the bar, which is the same picture as no changes at all.
 * The log holds a 20-line change at about a third of the width and a 2,000-line one at
 * full, which is the range where "a bit" and "a lot" are the answer anyone wants.
 */
export function density(added: number, removed: number): Density {
  const total = added + removed
  if (total <= 0) return { weight: 0, added: 0, removed: 0, total: 0 }
  const weight = Math.min(1, Math.log10(total + 1) / Math.log10(2000))
  return { weight, added: added / total, removed: removed / total, total }
}

/**
 * The one line of git under a row, or null when git has nothing to say.
 *
 * Written as a sentence rather than a row of counters because the counters are already
 * on the badge in the pane header; what this screen is for is reading eight panes at once
 * without decoding eight sets of arrows.
 */
export function gitLine(info: GitInfo | null | undefined): string | null {
  if (!info) return null
  const bits: string[] = []
  if (info.dirty) bits.push(`${info.dirty} changed`)
  if (info.ahead) bits.push(`${info.ahead} to push`)
  if (info.behind) bits.push(`${info.behind} to pull`)
  if (!bits.length) return 'clean'
  return bits.join(' · ')
}
