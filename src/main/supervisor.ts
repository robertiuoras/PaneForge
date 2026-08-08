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
import { WATCH_POLL_MS, diffKey, gateDue } from '../shared/dispatchWatch'
import type { SplitPlan } from '../shared/types'
import { runGate } from './agentGate'
import { cancelAgentRun, diffSince, headSha, runAgentTurn } from './agentRun'
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
  /** Wall clock per attempt. The dispatch plan's number; `TURN_BUDGET_MS` otherwise. */
  budgetMs?: number
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
      const lane = run.lanes[i]
      try {
        await driveLane(run, lane, input, claim, claimed)
      } catch (e) {
        // One lane throwing must not take the run with it. Everything inside `driveLane`
        // that talks to a process already handles its own failure, so what reaches here
        // is a programming error - a malformed plan, a claim that threw - and before this
        // it escaped through `Promise.all` into the `void drive(...)` in `startDrive` as
        // an unhandled rejection: the whole run died, the other lanes stopped mid-work,
        // and the board kept showing them as `working` for ever because nothing was left
        // to move them. Found by `test:goals` handing the supervisor a plan whose lanes
        // had no `owns`.
        lane.state = 'failed'
        lane.note = e instanceof Error ? e.message : String(e)
        lane.endedAt = Date.now()
        changed(run)
      }
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
      budgetMs: input.budgetMs ?? TURN_BUDGET_MS,
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

// --- D2: the run is a pane, because being watchable is the ask ---------------------------
//
// A dispatched goal opens a REAL pane on the lane worktree and types the prompt into it -
// the same door a person's typing goes through. The supervisor never reads the pane's
// text: it watches `diffSince` and the pty, and when `gateDue` says the turn is over it
// runs the same `agentGate` the headless path runs. The pane closes itself on success and
// stays on failure - a pane that vanished after a failed run takes the only readable
// account of the failure with it.

/**
 * What the pane path needs from the window side, injected for the same reason `ClaimLane`
 * is: panes live in `index.ts`'s session manager, and importing that here would make this
 * file need a window to be tested at all. The tests hand in a fake made of a temp repo.
 */
export interface PaneDriver {
  open(req: {
    cwd: string
    title: string
    agent: string
    model?: string
    prompt: string
  }): Promise<{ id: string; cwd: string; branch: string }>
  /** Type into the pane - the retry brief goes in through the same keyboard. */
  type(id: string, text: string): void
  close(id: string): void
  /** Is the pane's process still there? Polled, so no exit event has to be wired. */
  alive(id: string): boolean
}

/** Pane session id → the run watching it. How a person's keystroke finds its run. */
const watchedPanes = new Map<string, { runId: string; takenOver: boolean }>()

/**
 * A person typed into a watched pane. D2's rule: the run is DROPPED, never fought over -
 * the pane becomes an ordinary pane, the gate does not run, and nothing closes it.
 * Called from the `pty:write` handler, which only ever carries a person's bytes - the
 * prompt and the retry brief go through `PaneDriver.type`, not through that channel.
 */
export function notePaneInput(sessionId: string): void {
  const w = watchedPanes.get(sessionId)
  if (w) w.takenOver = true
}

const pollMs = (): number => Number(process.env.PF_DISPATCH_POLL_MS) || WATCH_POLL_MS
const quietMs = (): number | undefined =>
  Number(process.env.PF_DISPATCH_QUIET_MS) || undefined

/**
 * Drive a single-lane plan through a visible pane. Same contract as `startDrive`:
 * returns as soon as the run exists, progress arrives through `onDriveChange`, and the
 * result is a branch and a diff - never a merge.
 */
export function startPaneDrive(input: DriveInput, driver: PaneDriver): DriveRun {
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
    lanes: [
      {
        name: input.plan.lanes[0]?.name ?? 'dispatch',
        state: 'queued',
        cwd: '',
        branch: '',
        attempt: 0,
        note: ''
      }
    ]
  }
  runs.set(id, run)
  changed(run)
  void drivePane(run, input, driver).catch((e) => {
    // Same rule as `drive()`: a programming error must not leave the board reading
    // `working` for ever with nothing left to move it.
    const lane = run.lanes[0]
    lane.state = 'failed'
    lane.note = e instanceof Error ? e.message : String(e)
    lane.endedAt = Date.now()
    run.endedAt = Date.now()
    changed(run)
  })
  return run
}

async function drivePane(run: DriveRun, input: DriveInput, driver: PaneDriver): Promise<void> {
  const lane = run.lanes[0]
  const set = (patch: Partial<DriveLane>): void => {
    Object.assign(lane, patch)
    changed(run)
  }
  const end = (patch: Partial<DriveLane>): void => {
    set({ ...patch, endedAt: Date.now() })
    run.endedAt = Date.now()
    changed(run)
  }

  set({ state: 'working', note: 'opening a pane', startedAt: Date.now() })
  const brief = laneBrief(input.plan, 0, run.mission)
  let pane: { id: string; cwd: string; branch: string }
  try {
    pane = await driver.open({
      cwd: input.cwd,
      title: lane.name,
      agent: input.agent,
      model: input.model,
      prompt: brief
    })
  } catch (e) {
    return end({ state: 'failed', note: `no pane: ${e instanceof Error ? e.message : String(e)}` })
  }
  watchedPanes.set(pane.id, { runId: run.id, takenOver: false })
  set({ cwd: pane.cwd, branch: pane.branch })

  try {
    const base = await headSha(pane.cwd)
    const budget = input.budgetMs ?? TURN_BUDGET_MS

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      set({ attempt, state: attempt === 0 ? 'working' : 'retrying', note: 'the pane is working' })

      // The watch loop. Nothing here reads the pane's text: the diff and the process are
      // the whole story, and both survive being asked from outside.
      const attemptStart = Date.now()
      let lastKey = ''
      let lastChangeAt = 0
      let exited = false
      for (;;) {
        await sleep(pollMs())
        const w = watchedPanes.get(pane.id)
        if (w?.takenOver) return end({ state: 'stopped', note: 'taken over - the pane is yours' })
        if (run.stopping) {
          driver.close(pane.id)
          return end({ state: 'stopped', note: 'stopped' })
        }
        exited = !driver.alive(pane.id)
        if (!exited) {
          const d = await diffSince(pane.cwd, base)
          const key = diffKey(d)
          if (key !== lastKey) {
            lastKey = key
            lastChangeAt = Date.now()
            set({ diffstat: d, note: d.files ? `${d.files} file${d.files === 1 ? '' : 's'} changed` : lane.note })
          }
        }
        const due = gateDue({
          startedAt: attemptStart,
          budgetMs: budget,
          lastChangeAt,
          exited,
          now: Date.now(),
          quietMs: quietMs()
        })
        if (due.due) break
      }

      set({ state: 'verifying', note: 'verifying' })
      const gate = await runGate({
        cwd: pane.cwd,
        base,
        mission: run.mission,
        brief,
        agent: input.agent,
        model: input.model,
        key: `${run.id}:${lane.name}`,
        skipReview: input.skipReview,
        bin: input.bin,
        argsPrefix: input.argsPrefix,
        stopped: () => run.stopping || Boolean(watchedPanes.get(pane.id)?.takenOver),
        onStep: (name) => set({ note: name === 'diff' ? 'checking what changed' : name })
      })
      set({ gate, diffstat: await diffSince(pane.cwd, base) })
      if (watchedPanes.get(pane.id)?.takenOver)
        return end({ state: 'stopped', note: 'taken over - the pane is yours' })
      if (run.stopping) {
        driver.close(pane.id)
        return end({ state: 'stopped', note: 'stopped' })
      }

      if (gate.ok) {
        // The pane closes itself on success - the work is on the branch and the board
        // says so; the pane has nothing left to show that the diff does not.
        driver.close(pane.id)
        return end({ state: 'passed', note: 'verified' })
      }

      const failed = gate.steps.find((s) => !s.ok)
      if (attempt + 1 >= MAX_ATTEMPTS || exited)
        // A pane whose CLI exited cannot be handed a retry brief; and either way the
        // pane STAYS - it is the only readable account of what went wrong.
        return end({
          state: 'failed',
          note: failed ? `${failed.name}: ${failed.detail}` : 'failed verification'
        })

      driver.type(pane.id, retryBrief(gate, attempt))
      set({ note: failed ? `retrying - ${failed.name} failed` : 'retrying' })
    }
  } finally {
    watchedPanes.delete(pane.id)
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120)
}

function short(target: string): string {
  const bits = target.replace(/\\/g, '/').split('/')
  return bits.length > 2 ? `…/${bits.slice(-2).join('/')}` : target.slice(0, 60)
}
