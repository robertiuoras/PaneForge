// The queue that outlives the window.
//
// `shared/goals.ts` is the arithmetic; this is the half that touches the disk, the
// supervisor and the prompt archive. Three jobs, and they are worth keeping apart when
// reading:
//
//   1. **A file.** `goals.json` under userData, written atomically and debounced, holding
//      every goal, its plan, its attempts and what each turned into.
//   2. **A pump.** One goal runs at a time; when a run finishes the next queued one starts
//      by itself, with nobody at the keyboard. This is the whole feature: before it, Drive
//      it started something and there was no line behind it.
//   3. **A stamp.** When a goal ends, `promptArchive` learns what the ask became. That
//      field has been null for every row this app has ever written.
//
// Two things it deliberately does NOT do. It never retries an interrupted goal by itself -
// see `reviveGoals` for why - and it never merges anything, because nothing in this
// subsystem may (decision 2 of `docs/agentic.md`).

import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DriveRun } from '../shared/agentic'
import { runDone } from '../shared/agentic'
import type { Goal, GoalInput, GoalState } from '../shared/goals'
import {
  goalDone,
  nextGoal,
  pruneGoals,
  reviveGoals,
  snapshotRun,
  sortGoals,
  stateForFinishedRun
} from '../shared/goals'
import { headSha } from './agentRun'
import { recordOutcome } from './promptArchive'
import type { ClaimLane, DriveInput, PaneDriver } from './supervisor'
import { startDrive, startPaneDrive, stopDrive } from './supervisor'

/**
 * How long a burst of changes is allowed to collect before the file is written.
 *
 * A driven lane changes its note on every tool call, and a goal's stored copy moves with
 * it, so an unbuffered write is a file rewritten several times a second for tens of
 * minutes. Nothing here is worth an fsync per tool call; the only writes that must not be
 * lost are the state transitions, and `flushGoals()` forces one at each of those.
 */
const WRITE_DEBOUNCE_MS = 500

let goals: Goal[] = []
let loaded = false
let timer: NodeJS.Timeout | null = null

type Listener = (goals: Goal[]) => void
let listener: Listener | null = null
/**
 * A factory, not a claim.
 *
 * The pool a lane comes out of is the goal's OWN repository, and a queue holds goals for
 * several. Capturing one claim at wiring time would hand a goal in `taskdriver` a worktree
 * of whichever repo happened to be first.
 */
let claimFor: ((cwd: string) => ClaimLane) | null = null
/** Set by `index.ts`; without it the pump has no way to start anything. */
let driveOptions: { bin?: string; argsPrefix?: string[] } = {}
/** The window side of D2. Absent (tests, headless futures) every goal runs headless. */
let paneDriver: PaneDriver | null = null
/** D3. Called with every finished dispatched goal; posting is `dispatchReport.ts`'s job. */
let reporter: ((goal: Goal) => void) | null = null

export function onGoalReport(fn: ((goal: Goal) => void) | null): void {
  reporter = fn
}

function file(): string {
  const dir = app.getPath('userData')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* it is the app's own data dir - if this fails, nothing else in the app works either */
  }
  return join(dir, 'goals.json')
}

function load(): Goal[] {
  if (loaded) return goals
  loaded = true
  let raw = ''
  try {
    raw = readFileSync(file(), 'utf8')
  } catch {
    goals = []
    return goals
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    goals = Array.isArray(parsed) ? (parsed as Goal[]).filter((g) => g && typeof g.id === 'string') : []
  } catch {
    // A torn file loses the queue, which is bad, and a throw here loses the app, which is
    // worse. The next write replaces it.
    goals = []
  }
  const { goals: revived, revivedCount } = (() => {
    const r = reviveGoals(goals, Date.now())
    return { goals: r.goals, revivedCount: r.revived }
  })()
  goals = revived
  if (revivedCount) write()
  return goals
}

/**
 * Write through a temp file and rename.
 *
 * The read happens once at startup and a half-written file at that moment is the whole
 * queue gone. `rename` is atomic on both platforms' filesystems, so a kill mid-write
 * leaves the previous file rather than a truncated one.
 */
function write(): void {
  const path = file()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(pruneGoals(goals), null, 2))
    renameSync(tmp, path)
  } catch {
    /* a queue that cannot be written still runs; it just will not survive a restart */
  }
}

function schedule(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    write()
  }, WRITE_DEBOUNCE_MS)
  timer.unref?.()
}

/** Write now. Every state transition calls this - a debounce may not eat one of those. */
export function flushGoals(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  write()
}

function changed(now = false): void {
  if (now) flushGoals()
  else schedule()
  try {
    listener?.(sortGoals(goals))
  } catch {
    /* a broken board must not stop the queue it was watching */
  }
}

/** One listener, because there is one board. */
export function onGoalsChange(fn: Listener | null): void {
  listener = fn
}

/**
 * Wire the queue to the things it needs to run anything.
 *
 * Injected rather than imported for the same reason `ClaimLane` is: the session list that
 * says which worktrees are taken lives in `index.ts`, and reaching for it here would make
 * this file need a window before it could be tested at all.
 */
export function configureGoals(
  claim: (cwd: string) => ClaimLane,
  options: { bin?: string; argsPrefix?: string[]; paneDriver?: PaneDriver } = {}
): void {
  claimFor = claim
  driveOptions = options
  paneDriver = options.paneDriver ?? null
  load()
  pump()
}

export function listGoals(): Goal[] {
  return sortGoals(load())
}

export function getGoal(id: string): Goal | undefined {
  return load().find((g) => g.id === id)
}

/** Put one in the line. It starts by itself when the one in front of it finishes. */
export function addGoal(input: GoalInput): Goal {
  load()
  const goal: Goal = {
    id: randomUUID().slice(0, 8),
    mission: input.mission,
    cwd: input.cwd,
    agent: input.agent,
    model: input.model ?? '',
    skipReview: input.skipReview,
    plan: input.plan,
    state: 'queued',
    createdAt: Date.now(),
    attempts: [],
    outcome: null,
    ...(input.dispatch ? { dispatch: input.dispatch } : {})
  }
  goals.push(goal)
  changed(true)
  pump()
  return goal
}

/**
 * Stop a goal, whether it has started or not.
 *
 * A queued goal is simply marked; a running one has its drive stopped, and the run's own
 * finish path is what records the attempt - so a cancel and a natural end walk the same
 * code, and there is no second place that has to remember to snapshot lanes.
 */
export function cancelGoal(id: string): boolean {
  const g = getGoal(id)
  if (!g || goalDone(g)) return false
  if (g.state === 'running' && g.runId) {
    stopDrive(g.runId)
    return true
  }
  g.state = 'cancelled'
  g.endedAt = Date.now()
  changed(true)
  pump()
  return true
}

/**
 * Put a finished goal back in the line.
 *
 * The same plan and the same mission, keeping every previous attempt. The lanes it gets
 * are claimed fresh, so a retry after an interruption does NOT necessarily land in the
 * worktree the dead agent was writing in - which is the right way round: that worktree's
 * branch is still there to look at, and starting a second agent in it is the one thing
 * lanes exist to prevent.
 */
export function retryGoal(id: string): boolean {
  const g = getGoal(id)
  if (!g || !goalDone(g)) return false
  g.state = 'queued'
  g.startedAt = undefined
  g.endedAt = undefined
  g.runId = undefined
  changed(true)
  pump()
  return true
}

export function removeGoal(id: string): boolean {
  load()
  const g = goals.find((x) => x.id === id)
  if (!g || !goalDone(g)) return false
  goals = goals.filter((x) => x.id !== id)
  changed(true)
  return true
}

export function clearFinishedGoals(): number {
  load()
  const before = goals.length
  goals = goals.filter((g) => !goalDone(g))
  if (goals.length !== before) changed(true)
  return before - goals.length
}

/**
 * A live run said something.
 *
 * Called from the single `onDriveChange` listener in `index.ts` rather than registered
 * here, because the supervisor takes one listener and the board already holds it. All this
 * needs is to notice the run it started reaching the end.
 */
export function noteDriveChange(run: DriveRun): void {
  const g = load().find((x) => x.runId === run.id && x.state === 'running')
  if (!g) return
  if (!runDone(run)) return
  void finish(g, run)
}

let finishing = new Set<string>()

async function finish(g: Goal, run: DriveRun): Promise<void> {
  // `runDone` goes true once and then stays true, and the supervisor emits several times
  // around the last lane ending, so without this the same goal is finished repeatedly and
  // gains a duplicate attempt for each emission.
  if (finishing.has(g.id)) return
  finishing.add(g.id)
  try {
    // The head of each lane's branch, so the outcome names the commit that was reviewed and
    // not just the branch it is on. Read after the run has ended, never during it.
    const shas: Record<string, string> = {}
    for (const lane of run.lanes) {
      if (lane.state !== 'passed' || !lane.cwd) continue
      try {
        shas[lane.name] = await headSha(lane.cwd)
      } catch {
        /* a branch whose head cannot be read is described by its name alone */
      }
    }

    const attempt = snapshotRun(run, shas)
    g.attempts.push(attempt)
    g.outcome = attempt.outcome
    g.state = stateForFinishedRun(run) as GoalState
    g.endedAt = attempt.endedAt
    g.runId = undefined
    changed(true)

    // The oldest null in the archive. `recordOutcome` is a no-op for an ask it has never
    // seen, so a mission typed into Swarm rather than into a pane simply does not match -
    // that is a miss, not an error.
    try {
      recordOutcome(g.mission, attempt.outcome)
    } catch {
      /* the archive is a convenience; a goal must not fail because a lookup did */
    }

    // D3: the report goes back where the ask came from. Only dispatched goals - the
    // router's plan is what named the tier the message carries.
    if (g.dispatch) {
      try {
        reporter?.(g)
      } catch {
        /* a report is a courtesy; a goal must not fail because a POST did */
      }
    }
  } finally {
    finishing.delete(g.id)
    pump()
  }
}

/**
 * What the last dispatched attempt at this exact mission looked like, if any.
 *
 * The router's history signal. Goals are the right memory for it - unlike `priorPrompt`,
 * which deliberately ignores anything under six hours old, a dispatch retried a minute
 * after failing is exactly the case where the tier must move up. Exact text match on
 * purpose: a reworded ask is a judgement call, and the router must not escalate on one.
 */
export function priorDispatch(mission: string): { tier?: 'A' | 'B' | 'C'; failed: boolean } | null {
  const past = load()
    .filter((g) => g.mission === mission && g.dispatch && goalDone(g))
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
  const last = past[0]
  if (!last) return null
  // Cancelled and interrupted are a person's or the power's doing, not the tier's.
  const failed = last.state === 'done' && !(last.outcome ?? '').includes('verified')
  return { tier: last.dispatch?.tier, failed }
}

/**
 * Start the next goal if there is one and nothing is running.
 *
 * Safe to call at any time and from anywhere - it is the only place a goal moves from
 * `queued` to `running`, and `nextGoal` answers null the moment anything is live.
 */
export function pump(): Goal | null {
  if (!claimFor) return null
  const g = nextGoal(load())
  if (!g) return null

  const input: DriveInput = {
    cwd: g.cwd,
    mission: g.mission,
    plan: g.plan,
    agent: g.agent,
    model: g.model || undefined,
    skipReview: g.skipReview,
    budgetMs: g.dispatch?.budgetMs,
    bin: driveOptions.bin,
    argsPrefix: driveOptions.argsPrefix
  }

  // D2: a dispatched single-ask goal runs as a visible pane when there is a window to
  // put one in. Multi-lane plans stay headless - three panes racing three worktrees is
  // the Swarm launch, and the supervisor already drives that without any.
  const watchable =
    Boolean(g.dispatch?.watch) && g.plan.lanes.length === 1 && paneDriver !== null

  let run: DriveRun
  try {
    run = watchable
      ? startPaneDrive(input, paneDriver as PaneDriver)
      : startDrive(input, claimFor(g.cwd))
  } catch (e) {
    // A goal that cannot even be started is finished, with the reason on it. Leaving it
    // `queued` would stall every goal behind it for ever, which is the one failure a queue
    // is not allowed to have.
    g.state = 'done'
    g.endedAt = Date.now()
    g.outcome = `could not start: ${e instanceof Error ? e.message : String(e)}`
    changed(true)
    return pump()
  }

  g.state = 'running'
  g.runId = run.id
  g.startedAt = Date.now()
  changed(true)
  return g
}

/** Drop the in-memory copy. Only for the tests, which point `userData` somewhere else. */
export function resetGoals(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  goals = []
  loaded = false
  finishing = new Set()
  listener = null
  claimFor = null
  driveOptions = {}
  paneDriver = null
  reporter = null
}
