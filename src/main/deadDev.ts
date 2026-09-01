// The two readings `shared/deadDev.ts` judges on, and the clock it judges against.
//
// One: which pids hold a LISTENING TCP socket. That is the whole feature - a dev server
// nothing can connect to is a dev server nobody is using, whoever started it and however
// long ago. Read with `lsof` on macOS/Linux and `netstat -ano` on Windows, resolved up the
// process tree because `npm run dev` never holds the socket its child bound.
//
// Two: which pids something else supervises. A launchd job or a Windows service comes
// straight back after a kill, so closing it wins nothing and loses the reason it went.
// Read from `launchctl list`, whose first column is the running pid.
//
// Both are read on a 60s sweep, and only while at least one dev server exists - `lsof` on
// this Mac is ~90 ms and `ps -Ao command=` is the expensive half, already paid by
// `listRunningDevs`.

import { execFile } from 'node:child_process'
import {
  DEAD_AFTER_MS,
  DEFAULT_DEAD_DEV,
  SWEEP_MS,
  deadDevs,
  stopPlan,
  trackDead,
  type DeadDev,
  type DeadDevConfig,
  type StopSoon
} from '../shared/deadDev'
import type { DevPane, RunningDev } from '../shared/devList'
import { descendants, listRunningDevs, stopDevServer, table, type Proc } from './devServers'

const WIN = process.platform === 'win32'

/** Run something short and hand back stdout, or '' - never a reason a sweep fails. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(err && !stdout ? '' : String(stdout || ''))
      )
    } catch {
      resolve('')
    }
  })
}

/**
 * Every pid holding a listening TCP socket.
 *
 * `lsof -Fpn` is the machine-readable form: `p<pid>` lines followed by `n<address>` lines.
 * Only the pid is wanted here - WHICH port it listens on does not matter, because a dev
 * server that fell back to another port is still reachable and still somebody's.
 */
export async function listeningPids(): Promise<Set<number>> {
  const out = new Set<number>()
  if (WIN) {
    const text = await run('netstat', ['-ano', '-p', 'tcp'])
    for (const line of text.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const m = /(\d+)\s*$/.exec(line.trim())
      if (m) out.add(Number(m[1]))
    }
    return out
  }
  const text = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp'])
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      if (n > 0) out.add(n)
    }
  }
  return out
}

/**
 * The pids something else keeps alive.
 *
 * macOS only: `launchctl list` prints `PID<TAB>STATUS<TAB>LABEL`, and a job that is not
 * running prints `-` for the pid. Windows returns an empty set, which is the honest
 * answer - Task Scheduler does not publish the pid of what it started, so nothing is
 * claimed rather than something guessed.
 */
export async function supervisedPids(): Promise<Set<number>> {
  const out = new Set<number>()
  if (WIN || process.platform !== 'darwin') return out
  const text = await run('launchctl', ['list'])
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+/.exec(line)
    if (m) out.add(Number(m[1]))
  }
  return out
}

/**
 * Which of these dev servers has anything listening, itself or below it.
 *
 * `devList.ts` folds a child dev process into the ancestor a person typed, so the pid it
 * reports is routinely the `npm run dev` that holds no socket at all. Judging that pid
 * alone would call every single npm-started dev server dead - the first version of this
 * did, on a desk with three healthy ones.
 */
export function servingDevs(devs: RunningDev[], procs: Proc[], listening: Set<number>): Set<number> {
  const out = new Set<number>()
  for (const d of devs) {
    if (listening.has(d.pid)) {
      out.add(d.pid)
      continue
    }
    for (const kid of descendants(procs, d.pid)) {
      if (listening.has(kid.pid)) {
        out.add(d.pid)
        break
      }
    }
  }
  return out
}

interface Deps {
  /** The panes, for attribution - the same list `devs:list` is answered with. */
  panes: () => DevPane[]
  cfg: () => DeadDevConfig
  /** Draw the countdown, or take it away with `null`. */
  publish: (soon: StopSoon | null) => void
  /** Say what happened, once it has. */
  noted: (dev: DeadDev) => void
}

let deps: Deps | null = null
let sweepTimer: NodeJS.Timeout | null = null
let fireTimer: NodeJS.Timeout | null = null
let deadSince = new Map<number, number>()
let soon: StopSoon | null = null
let kept = new Set<number>()
let firing = false

/** The countdown currently on screen, for a window that has just reloaded. */
export function currentStopSoon(): StopSoon | null {
  return soon
}

/** Leave this one alone: it is never offered again while this app run lasts. */
export function keepDevServer(pid: number): void {
  kept.add(pid)
  if (soon?.dev.pid === pid) {
    soon = null
    deps?.publish(null)
  }
}

/** Stop it now rather than at the deadline - the card's other button. */
export async function stopNow(pid: number): Promise<void> {
  const dev = soon?.dev.pid === pid ? soon.dev : null
  soon = null
  deps?.publish(null)
  const res = await stopDevServer(pid)
  if (res.ok && dev) deps?.noted(dev)
}

/**
 * One sweep: read, judge, arm, and fire anything whose deadline has passed.
 *
 * The deadline is checked in the SAME pass that arms, so the countdown and the thing it
 * counts down to cannot disagree - two readings of one clock is the bug this app has
 * already been bitten by twice (`MoveSoon`, 2026-08-31).
 */
export async function sweepDeadDevs(now = Date.now()): Promise<void> {
  if (firing) return
  const cfg = deps?.cfg() ?? DEFAULT_DEAD_DEV
  if (!deps || !cfg.enabled) {
    if (soon) {
      soon = null
      deps?.publish(null)
    }
    return
  }

  firing = true
  try {
    const panes = deps.panes()
    const devs = await listRunningDevs(panes)
    if (!devs.length) {
      deadSince = new Map()
      if (soon) {
        soon = null
        deps.publish(null)
      }
      return
    }

    const [listening, supervised, procs] = await Promise.all([
      listeningPids(),
      supervisedPids(),
      table()
    ])
    // An empty socket table is a FAILED reading, not "nothing is listening" - `lsof` can
    // be missing, sandboxed or slow. Calling every dev server on the desk dead because a
    // command printed nothing is exactly the shape of failure this app refuses elsewhere
    // (an empty model list may never overwrite a good one), and here it would kill them.
    if (!listening.size) return

    const serving = servingDevs(devs, procs, listening)
    deadSince = trackDead(devs, serving, deadSince, now)
    const dead = deadDevs(devs, serving, deadSince, { now, kept, supervised })

    if (soon && !dead.some((d) => d.pid === soon?.dev.pid)) {
      // It started serving, exited, or was kept. Either way there is nothing to count.
      soon = null
      deps.publish(null)
    }
    if (soon && now >= soon.deadline) {
      const dev = soon.dev
      soon = null
      deps.publish(null)
      const res = await stopDevServer(dev.pid)
      if (res.ok) deps.noted(dev)
      return
    }
    const next = stopPlan(dead, soon, cfg, now)
    // Published even when it has not changed: a window that reloaded mid-countdown has no
    // card and no way to ask for one, and the thing is still going to happen.
    if (next !== soon || next) {
      soon = next
      deps.publish(next)
    }
  } finally {
    firing = false
  }
}

/**
 * Fire an armed countdown whose deadline has passed, cheaply.
 *
 * Separate from the sweep because the sweep costs a full `ps -Ao command=` plus an `lsof`
 * - about 120 ms on this Mac - and the countdown is five seconds long. Running the whole
 * sweep every second to notice a deadline would spend a minute of process-table reads per
 * minute of desk. This holds no readings at all: it compares two numbers, then does the
 * same re-validated `stopDevServer` the sweep would have done.
 */
async function fireDue(now: number): Promise<void> {
  if (!soon || firing || now < soon.deadline) return
  const dev = soon.dev
  soon = null
  deps?.publish(null)
  firing = true
  try {
    const res = await stopDevServer(dev.pid)
    if (res.ok) deps?.noted(dev)
  } finally {
    firing = false
  }
}

function stopTimers(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  if (fireTimer) clearInterval(fireTimer)
  sweepTimer = null
  fireTimer = null
}

/** Start the sweep. Called once from index.ts, after the window exists. */
export function watchDeadDevs(d: Deps): void {
  deps = d
  stopTimers()
  sweepTimer = setInterval(() => {
    void sweepDeadDevs()
  }, SWEEP_MS)
  sweepTimer.unref?.()
  // The countdown is seconds long and the sweeps are a minute apart, so the deadline gets
  // its own tick - a card that says 5s and acts 60s later is a lie. It reads nothing.
  fireTimer = setInterval(() => {
    void fireDue(Date.now())
  }, 500)
  fireTimer.unref?.()
  void sweepDeadDevs()
}

export function stopWatchingDeadDevs(): void {
  stopTimers()
  soon = null
  deadSince = new Map()
  kept = new Set()
}

export { DEAD_AFTER_MS, SWEEP_MS }
