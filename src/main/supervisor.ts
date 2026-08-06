// The loop that finishes what Swarm today only starts.
//
// Split already decides the workstreams and who owns which files; lanes already give each
// one a checkout two agents cannot both write; `lane.mjs ready` already releases. What was
// missing between them was anybody watching: Split spawned panes and never looked again,
// so "did lane 2 do the work" was a question a person answered by reading four terminals.
//
// This drives the same plan with no panes at all. Per lane: claim a worktree, run one
// headless turn (`agentRun`), verify it (`agentGate`), hand a failure back to the same
// agent at most twice, and stop with a branch and a diff. It never merges and it never
// releases - decision 2 of `docs/agentic.md`: `ready` stays the person's word, and what
// autonomy buys is that by the time it is pressed the work is written, built, tested and
// read.
//
// Three rules it does not get to break:
//   - Nothing takes the screen. A lane that fails at 3am changes a row on the board and
//     nothing else. No dialog, no focus, no flash.
//   - Stop means stop now. `run.stopping` is read at every await point, including between
//     gate steps, so a stop does not have to wait for a test suite to finish.
//   - Nothing blocks the main process. Every child here is async, and the lanes run
//     concurrently against a cap rather than one at a time.

import { randomUUID } from 'node:crypto'
import type { DriveLane, DriveRun } from '../shared/agentic'
import { MAX_ATTEMPTS, TURN_BUDGET_MS, retryBrief, runDone } from '../shared/agentic'
import type { SplitPlan } from '../shared/types'
import { runGate } from './agentGate'
import { cancelAgentRun, headSha, runAgentTurn } from './agentRun'
import { laneBrief } from './split'

/**
 * How many lanes write code at once.
 *
 * Not a worktree limit - the pool already caps those - a plan limit. A Max subscription
 * has no concurrency cap at all; what it has is a five-hour token window, and three to
 * five sustained agents is what that window actually carries. Three is the floor of that
 * range because the fourth agent's contribution is the first one to arrive after the
 * window has already closed. I5 turns this constant into a reading of the real budget.
 */
export const MAX_PARALLEL = 3

/**
 * Between one lane's launch and the next.
 *
 * Each launch may have to create a worktree, and N `git worktree add` on one repository
 * at once is a fight over one index lock. The same 900ms the Split launch already uses,
 * for the same reason.
 */
const STAGGER_MS = 900

export interface DriveInput {
  cwd: string
  mission: string
  plan: SplitPlan
  agent: string
  model?: string
  /** Skip the reviewer agent. The two cheap gate steps still run. */
  skipReview?: boolean
  /**
   * The executable, and the arguments before the CLI's own, when PATH is not where it
   * lives. The seam `npm run test:agentic` drives the whole loop through - a stub that
   * fails its gate and then fixes it - so the retry path is exercised without a real
   * CLI. Never set in production.
   */
  bin?: string
  argsPrefix?: string[]
}

/**
 * How a lane gets its checkout.
 *
 * Injected rather than imported: the claim lives in `index.ts`, where the session list
 * that says which worktrees are taken lives, and importing it here would make this file
 * need a window to be tested at all.
 */
export type ClaimLane = (
  name: string,
  taken: string[]
) => Promise<{ cwd: string; branch: string } | null>

const runs = new Map<string, DriveRun>()
type Listener = (run: DriveRun) => void
let listener: Listener | null = null

/** One listener, because there is one board. Set by `index.ts` at startup. */
export function onDriveChange(fn: Listener | null): void {
  listener = fn
}

function changed(run: DriveRun): void {
  try {
    listener?.(run)
  } catch {
    /* a broken listener must not end the run it was watching */
  }
}

export function listDrives(): DriveRun[] {
  return [...runs.values()]
}

export function getDrive(id: string): DriveRun | undefined {
  return runs.get(id)
}

/**
 * Every worktree a live run is holding.
 *
 * A driven lane has no pane, so the session list - which is what a launch asks before
 * claiming - cannot see it. Without this, a second drive started while the first is still
 * working reads the pool as empty and hands out a worktree that already has an agent
 * writing in it: two agents in one checkout, which is the single thing lanes exist to make
 * impossible. Only live runs count; a finished lane's branch is nobody's.
 */
export function driveCwds(): string[] {
  const out: string[] = []
  for (const run of runs.values()) {
    if (runDone(run)) continue
    for (const lane of run.lanes)
      if (lane.cwd && lane.state !== 'passed' && lane.state !== 'failed' && lane.state !== 'stopped')
        out.push(lane.cwd)
  }
  return out
}

/**
 * Stop everything this run is doing, now.
 *
 * The flag first and the kills second: a lane between two awaits is stopped by the flag
 * alone, and a lane inside a spawn needs the kill. Doing it the other way round leaves a
 * window where a killed turn starts its gate.
 */
export function stopDrive(id: string): boolean {
  const run = runs.get(id)
  if (!run) return false
  run.stopping = true
  for (const lane of run.lanes) {
    cancelAgentRun(`${id}:${lane.name}`)
    cancelAgentRun(`${id}:${lane.name}:review`)
  }
  changed(run)
  return true
}

/** Stop every live run. The one switch I7 will hang unattended mode off. */
export function stopAllDrives(): number {
  let n = 0
  for (const run of runs.values()) if (!runDone(run)) n += stopDrive(run.id) ? 1 : 0
  return n
}

/** Forget finished runs. Memory only - a goal that survives a restart is I4. */
export function clearFinishedDrives(): number {
  let n = 0
  for (const [id, run] of runs)
    if (runDone(run)) {
      runs.delete(id)
      n++
    }
  return n
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Start driving a plan. Returns as soon as the run exists, not when it finishes.
 *
 * The caller is an IPC handler and the work is measured in tens of minutes, so awaiting
 * it would be a renderer waiting on a build. Progress arrives through `onDriveChange`.
 */
export function startDrive(input: DriveInput, claim: ClaimLane): DriveRun {
  const id = randomUUID().slice(0, 8)
  const run: DriveRun = {
    id,
    mission: input.mission,
    cwd: input.cwd,
    agent: input.agent,
    model: input.model ?? '',
    startedAt: Date.now(),
    stopping: false,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    lanes: input.plan.lanes.map((l) => ({
      name: l.name,
      state: 'queued',
      cwd: '',
      branch: '',
      attempt: 0,
      note: ''
    }))
  }
  runs.set(id, run)
  changed(run)

  void drive(run, input, claim)
  return run
}

async function drive(run: DriveRun, input: DriveInput, claim: ClaimLane): Promise<void> {
  const claimed: string[] = []
  const queue = run.lanes.map((_, i) => i)
  let next = 0

  const worker = async (slot: number): Promise<void> => {
    // Staggered by slot rather than by lane, so the cap and the stagger do not fight:
    // three workers start 900ms apart and each then takes lanes as fast as it can.
    await sleep(slot * STAGGER_MS)
    for (;;) {
      if (run.stopping) return
      const i = next++
      if (i >= queue.length) return
      await driveLane(run, run.lanes[i], input, claim, claimed)
    }
  }

  const workers = Math.min(MAX_PARALLEL, run.lanes.length)
  await Promise.all(Array.from({ length: workers }, (_, s) => worker(s)))

  // Anything still queued when the run stops was never started, and must not sit on the
  // board reading "waiting for a worktree" for ever.
  for (const lane of run.lanes)
    if (lane.state === 'queued' || lane.state === 'working' || lane.state === 'verifying' || lane.state === 'retrying') {
      lane.state = 'stopped'
      lane.endedAt = Date.now()
    }
  run.endedAt = Date.now()
  changed(run)
}

async function driveLane(
  run: DriveRun,
  lane: DriveLane,
  input: DriveInput,
  claim: ClaimLane,
  claimed: string[]
): Promise<void> {
  const index = run.lanes.indexOf(lane)
  const set = (patch: Partial<DriveLane>): void => {
    Object.assign(lane, patch)
    changed(run)
  }

  set({ state: 'working', note: 'claiming a worktree', startedAt: Date.now() })
  const spot = await claim(lane.name, claimed)
  if (!spot) return set({ state: 'failed', note: 'no free worktree for this lane', endedAt: Date.now() })
  claimed.push(spot.cwd)
  set({ cwd: spot.cwd, branch: spot.branch })
  if (run.stopping) return set({ state: 'stopped', endedAt: Date.now() })

  const base = await headSha(spot.cwd)
  const brief = laneBrief(input.plan, index, run.mission)
  const key = `${run.id}:${lane.name}`
  // The next attempt's instruction. A local, NOT the lane's `note`: `note` is the line
  // the board shows and every tool call overwrites it, so parking a prompt there means
  // the second attempt is started with whatever the first one was doing when it stopped.
  let prompt = brief

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (run.stopping) return set({ state: 'stopped', endedAt: Date.now() })
    set({
      attempt,
      state: attempt === 0 ? 'working' : 'retrying',
      note: attempt === 0 ? 'starting' : 'fixing what failed'
    })

    const turn = await runAgentTurn({
      cwd: spot.cwd,
      agent: input.agent,
      model: input.model,
      prompt,
      key,
      budgetMs: TURN_BUDGET_MS,
      bin: input.bin,
      argsPrefix: input.argsPrefix,
      onEvent: (e) => {
        if (e.kind === 'tool') set({ note: e.target ? `${e.name} ${short(e.target)}` : e.name })
        else if (e.kind === 'text') set({ note: firstLine(e.text) })
      }
    })
    run.tokens.input += turn.tokens.input
    run.tokens.output += turn.tokens.output
    run.costUsd += turn.costUsd
    set({ turn, diffstat: turn.diffstat })

    if (turn.exit === 'cancelled' || run.stopping) return set({ state: 'stopped', endedAt: Date.now() })
    if (turn.exit === 'unavailable')
      return set({ state: 'failed', note: turn.detail, endedAt: Date.now() })

    // A turn that was killed or errored still gets its gate: it may have left good work
    // behind it, and the gate is the only thing that can tell. What it does not get is a
    // pass on the strength of having exited zero.
    set({ state: 'verifying', note: 'verifying' })
    const gate = await runGate({
      cwd: spot.cwd,
      base,
      mission: run.mission,
      brief,
      agent: input.agent,
      model: input.model,
      key,
      skipReview: input.skipReview,
      bin: input.bin,
      argsPrefix: input.argsPrefix,
      stopped: () => run.stopping,
      onStep: (name) => set({ note: name === 'diff' ? 'checking what changed' : name })
    })
    set({ gate })
    if (run.stopping) return set({ state: 'stopped', endedAt: Date.now() })

    if (gate.ok)
      return set({
        state: 'passed',
        note: turn.exit === 'done' ? 'verified' : `verified, though the turn ${turn.detail}`,
        endedAt: Date.now()
      })

    const failed = gate.steps.find((s) => !s.ok)
    if (attempt + 1 >= MAX_ATTEMPTS)
      return set({
        state: 'failed',
        note: failed ? `${failed.name}: ${failed.detail}` : 'failed verification',
        endedAt: Date.now()
      })

    prompt = retryBrief(gate, attempt)
    set({ note: failed ? `retrying - ${failed.name} failed` : 'retrying' })
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120)
}

function short(target: string): string {
  const bits = target.replace(/\\/g, '/').split('/')
  return bits.length > 2 ? `…/${bits.slice(-2).join('/')}` : target.slice(0, 60)
}
