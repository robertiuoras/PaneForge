// A goal outlives the session that asked for it.
//
// I4 of `docs/agentic.md`. Everything below I3 is in-memory: `startDrive` puts a run in a
// Map, the Fleet board projects it, and quitting forgets all of it - including which lanes
// passed, which branch is sitting there reviewed and unmerged, and what the ask was in the
// first place. That is fine for a loop somebody is watching and useless for one that is
// supposed to run while nobody is.
//
// So a goal is written down. It carries the plan it was split into, every attempt at it,
// what each lane produced, and one sentence saying what the whole thing turned into. That
// last field is also the answer to the oldest null in this repo: `promptArchive` has never
// been able to fill `outcome` because nothing knew what an ask became. Now something does.
//
// This file is the half with no filesystem and no processes in it, for the same reason
// `shared/agentic.ts` is: it is the half that can be asserted on without spawning anything.
// `npm run test:goals`.
//
// Two rules worth reading before changing it:
//
//   - **A goal that was running when the process died did not finish, and did not fail
//     either.** Its agents were killed by `stopAllDrives` on the way out (or by the power
//     going off, which runs nothing at all), so the branch on disk is whatever the agent
//     had written by then. `interrupted` is a fourth outcome and the recovery is a person's
//     call - re-queueing it automatically would set an agent going over a worktree whose
//     state nobody has looked at.
//   - **One goal runs at a time.** Not a token decision - `MAX_PARALLEL` already caps the
//     lanes inside a run at three, and a second goal starting beside it would quietly make
//     that six against the same five-hour window and the same worktree pool. I5 is what
//     turns this into a reading of the real budget; until then the honest cap is one.

import type { DriveRun, DriveState } from './agentic'
import { runDone } from './agentic'
import type { Plan } from './dispatch'
import type { SplitPlan } from './types'

/**
 * Where a goal is.
 *
 * `queued` and `running` are live; the other three are terminal and differ in who ended it:
 * `done` means the loop ran to the end (some lanes may still have failed their gate -
 * see `attemptOutcome`), `cancelled` means a person pressed stop, and `interrupted` means
 * the app was not running any more.
 */
export type GoalState = 'queued' | 'running' | 'done' | 'cancelled' | 'interrupted'

/** What one lane of one attempt left behind, after the live notes have stopped moving. */
export interface GoalLane {
  name: string
  state: DriveState
  branch: string
  /** The last thing the lane said. Kept because for a failure it IS the reason. */
  note: string
  files: number
  added: number
  removed: number
  /**
   * The gate's per-step verdicts, kept because D3's report must carry them: a report
   * that says "verified" while its suite step was skipped is the failure mode
   * `agentGate` exists to avoid, so the steps travel rather than being summarised away.
   */
  gate?: Array<{ name: string; verdict: 'pass' | 'fail' | 'skipped' }>
}

/**
 * One run of this goal, frozen.
 *
 * A `DriveRun` is live - its lanes' `note` is rewritten on every tool call - so a goal
 * stores a snapshot rather than a reference. A retried goal keeps both, because "it took
 * two attempts" is the sort of thing that is only ever interesting after the fact.
 */
export interface GoalAttempt {
  runId: string
  startedAt: number
  endedAt: number
  lanes: GoalLane[]
  tokens: { input: number; output: number }
  costUsd: number
  /** `<repo> <branch@sha> <what happened>`, or as much of it as is known. */
  outcome: string
}

export interface Goal {
  id: string
  mission: string
  cwd: string
  agent: string
  model: string
  skipReview?: boolean
  plan: SplitPlan
  state: GoalState
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** The live `DriveRun` this goal is currently in, while `state === 'running'`. */
  runId?: string
  attempts: GoalAttempt[]
  /** The newest attempt's outcome, promoted so a reader never has to index the array. */
  outcome: string | null
  /** The router's decision, when this goal was dispatched rather than hand-configured. */
  dispatch?: Plan
}

/** What a caller has to say to ask for one. Everything else is decided here. */
export interface GoalInput {
  mission: string
  cwd: string
  agent: string
  model?: string
  skipReview?: boolean
  plan: SplitPlan
  dispatch?: Plan
}

/** Terminal, in the sense that nothing this file does will move it again. */
export function goalDone(g: Goal): boolean {
  return g.state === 'done' || g.state === 'cancelled' || g.state === 'interrupted'
}

/**
 * The next goal to start, or null.
 *
 * Null both when there is nothing waiting AND when something is already running, because
 * the caller's question is never "is one queued" - it is "may I start one now".
 */
export function nextGoal(goals: Goal[]): Goal | null {
  if (goals.some((g) => g.state === 'running')) return null
  return goals.find((g) => g.state === 'queued') ?? null
}

/** Where a queued goal sits in the line, 1-based. 0 when it is not waiting. */
export function queuePosition(goals: Goal[], id: string): number {
  const waiting = goals.filter((g) => g.state === 'queued')
  const at = waiting.findIndex((g) => g.id === id)
  return at < 0 ? 0 : at + 1
}

/** Freeze a live run into the record a goal keeps of it. */
export function snapshotRun(run: DriveRun, shas: Record<string, string> = {}): GoalAttempt {
  const lanes: GoalLane[] = run.lanes.map((l) => ({
    name: l.name,
    state: l.state,
    branch: l.branch,
    note: l.note,
    files: l.diffstat?.files ?? 0,
    added: l.diffstat?.added ?? 0,
    removed: l.diffstat?.removed ?? 0,
    ...(l.gate
      ? {
          gate: l.gate.steps.map((s) => ({
            name: s.name,
            verdict: (s.detail.startsWith('skipped') ? 'skipped' : s.ok ? 'pass' : 'fail') as
              | 'pass'
              | 'fail'
              | 'skipped'
          }))
        }
      : {})
  }))
  return {
    runId: run.id,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? Date.now(),
    lanes,
    tokens: { ...run.tokens },
    costUsd: run.costUsd,
    outcome: attemptOutcome(run.cwd, lanes, shas)
  }
}

/** The last path segment, whatever the separator. The repo's name as a person says it. */
export function repoName(cwd: string): string {
  const bits = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return bits[bits.length - 1] || cwd
}

/**
 * The one line that says what this ask turned into.
 *
 * Shaped to match what `promptArchive` already stores in `out` - `<repo> <ref> <subject>` -
 * because an external archive writes that same field and a reader must not have to know
 * which of the two wrote a given row. `<ref>` is the branch, with the head sha when it is
 * known, since a branch name alone does not say WHICH commit was reviewed.
 *
 * It reports the passed lanes and it counts the rest. A goal where two lanes were verified
 * and one failed its gate is neither a success nor a failure, and flattening it to either
 * is how a person ends up merging a branch nothing read.
 */
export function attemptOutcome(
  cwd: string,
  lanes: GoalLane[],
  shas: Record<string, string> = {}
): string {
  const repo = repoName(cwd)
  const passed = lanes.filter((l) => l.state === 'passed')
  const failed = lanes.filter((l) => l.state === 'failed')
  const stopped = lanes.filter((l) => l.state === 'stopped')

  if (!lanes.length) return `${repo} - nothing to do`
  if (!passed.length) {
    const why = failed[0]?.note || stopped[0]?.note || 'nothing was verified'
    return `${repo} - no branch to review: ${why}`
  }

  const refs = passed.map((l) => {
    const sha = shas[l.name] || ''
    return sha ? `${l.branch}@${sha.slice(0, 7)}` : l.branch
  })
  const files = passed.reduce((n, l) => n + l.files, 0)
  const added = passed.reduce((n, l) => n + l.added, 0)
  const removed = passed.reduce((n, l) => n + l.removed, 0)
  const size = `${files} file${files === 1 ? '' : 's'}, +${added} −${removed}`

  const rest: string[] = []
  if (failed.length) rest.push(`${failed.length} failed`)
  if (stopped.length) rest.push(`${stopped.length} stopped`)
  const tail = rest.length ? `, ${rest.join(' and ')}` : ''

  return `${repo} ${refs.join(' ')} verified, ${size}${tail}`
}

/**
 * A goal is `done` when its run is over. It is not "passed" - there is no such state,
 * deliberately: the app finished driving it, and whether the work is good is the gate's
 * answer per lane and a person's answer overall.
 */
export function stateForFinishedRun(run: DriveRun): GoalState {
  if (!runDone(run)) return 'running'
  return run.stopping && run.lanes.every((l) => l.state === 'stopped') ? 'cancelled' : 'done'
}

/**
 * What a stored goal becomes when the app starts and finds it mid-flight.
 *
 * Nothing survives the process: the driven agents are detached children killed by
 * `stopAllDrives` on the way out, and after a crash they are orphans `strays.ts` reaps.
 * Either way the run is not resumable, so the honest move is to say so and stop. The
 * branch is still on disk and still has whatever was written; `retry` re-queues it, and
 * that is a person's press.
 */
export function reviveGoals(goals: Goal[], now: number): { goals: Goal[]; revived: number } {
  let revived = 0
  const out = goals.map((g) => {
    if (g.state !== 'running') return g
    revived++
    return {
      ...g,
      state: 'interrupted' as GoalState,
      endedAt: g.endedAt ?? now,
      runId: undefined,
      outcome: g.outcome ?? `${repoName(g.cwd)} - the app stopped while this was running`
    }
  })
  return { goals: out, revived }
}

/** Newest-first, live before finished - the order a board wants and a file does not care. */
export function sortGoals(goals: Goal[]): Goal[] {
  const rank = (g: Goal): number =>
    g.state === 'running' ? 0 : g.state === 'queued' ? 1 : 2
  return [...goals].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
}

/**
 * Keep every live goal and the newest `cap` finished ones.
 *
 * A cap rather than an age cutoff because the file is read whole on startup and a goal
 * carries its plan, which is the biggest thing in it. Live goals are never dropped however
 * many there are - a queue that silently forgets what it was asked to do is worse than a
 * long file.
 */
export const GOAL_CAP = 60

export function pruneGoals(goals: Goal[], cap = GOAL_CAP): Goal[] {
  const live = goals.filter((g) => !goalDone(g))
  const finished = goals.filter(goalDone).sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
  const keep = new Set([...live, ...finished.slice(0, cap)])
  return goals.filter((g) => keep.has(g))
}

/**
 * The line a board puts under a goal.
 *
 * Same contract as `driveLine`: a sentence, because this screen is read across several
 * rows at once and rows of counters are decoded rather than read.
 */
export function goalLine(g: Goal, position = 0): string {
  if (g.state === 'queued') return position > 1 ? `waiting - ${position} in line` : 'waiting to start'
  if (g.state === 'running') {
    const lanes = g.plan.lanes.length
    return `running - ${lanes} lane${lanes === 1 ? '' : 's'}`
  }
  if (g.state === 'cancelled') return 'stopped by hand'
  if (g.state === 'interrupted') return 'the app stopped while this was running - retry to pick it up'
  return g.outcome ?? 'finished'
}
