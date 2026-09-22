// How many `git` processes the main process may have alive at once, and when a lane sweep
// is allowed to start.
//
// 2026-09-22, installed 0.8.221: load average 390-430 on the Mac, every Claude Code hook
// timing out, and 135-270 `git` children of the PaneForge main process - `worktree list`
// x19, `status --untracked-files=all` x18, `rev-parse --abbrev-ref HEAD` x18 - plus 28
// zombies. The lane sweep had no single-flight and every `sessions` event (fifty emit
// sites) zeroed its five-minute throttle, so each slow sweep was overtaken by the next one
// three seconds later, and each of those spawned every git of every lane of every project
// at once. On a loaded machine each git got slower, which made more of them overlap.
//
// Two rules close that loop, both pure so `scripts/git-gate-test.mjs` can hold them:
//
//   GitGate    one queue for every git the main process runs: the same command in the
//              same folder already running or waiting is JOINED rather than started again,
//              and at most `max` run at once (fewer while the machine is loaded).
//   sweepDue   a sweep never starts while one is running, never sooner than a minute
//              after the last one began, and waits longer after a slow sweep or while the
//              machine is loaded.

/** Git processes the main process may run at once on an unloaded machine. */
export const GIT_MAX = 4

/**
 * How many may run at once for a given one-minute load average per core. Windows reports
 * a load average of 0, which reads as unloaded: the cap still holds there.
 */
export function capFor(max: number, loadPerCore: number): number {
  if (!(loadPerCore > 0)) return max
  if (loadPerCore >= 4) return 1
  if (loadPerCore >= 2) return Math.max(1, Math.floor(max / 2))
  return max
}

interface Waiting {
  key: string | null
  start: () => void
}

/**
 * A FIFO with a concurrency cap and single-flight by key.
 *
 * `key` null = never joined (a command that changes something - two merges are two
 * merges). The gate never looks at what a job does, so it is testable with plain promises.
 */
export class GitGate {
  private readonly max: number
  private readonly load: () => number
  private running = 0
  private readonly queue: Waiting[] = []
  private readonly byKey = new Map<string, Promise<unknown>>()
  /** Most at once, ever. Read by the test to prove the cap held. */
  peak = 0
  /** Jobs that joined one already running or waiting instead of starting their own. */
  joined = 0

  constructor(max: number = GIT_MAX, load: () => number = () => 0) {
    this.max = max
    this.load = load
  }

  get active(): number {
    return this.running
  }

  get waiting(): number {
    return this.queue.length
  }

  run<T>(key: string | null, job: () => Promise<T>): Promise<T> {
    if (key !== null) {
      const same = this.byKey.get(key)
      if (same) {
        this.joined++
        return same as Promise<T>
      }
    }
    const p = new Promise<T>((resolve, reject) => {
      this.queue.push({
        key,
        start: () => {
          this.running++
          if (this.running > this.peak) this.peak = this.running
          let settled: Promise<T>
          try {
            settled = Promise.resolve(job())
          } catch (err) {
            settled = Promise.reject(err)
          }
          settled.then(resolve, reject).finally(() => {
            this.running--
            if (key !== null && this.byKey.get(key) === p) this.byKey.delete(key)
            this.pump()
          })
        }
      })
    })
    if (key !== null) this.byKey.set(key, p)
    this.pump()
    return p
  }

  private pump(): void {
    const cap = capFor(this.max, this.load())
    while (this.running < cap && this.queue.length) this.queue.shift()!.start()
  }
}

/** The ordinary gap between two lane sweeps. */
export const SWEEP_EVERY_MS = 5 * 60_000
/** The soonest a sweep asked for by a pane ending may follow the last one. */
export const SWEEP_SOON_MS = 60_000
/** The longest backoff: a sweep still happens twice an hour whatever the machine is doing. */
export const SWEEP_MAX_MS = 30 * 60_000
/** A sweep that took this long is waited out ten times over before the next one. */
export const SWEEP_SLOW_MS = 20_000
/** Load per core at which the gap is multiplied by four. */
export const SWEEP_BUSY_LOAD = 2

export interface SweepClock {
  now: number
  /** When the last sweep started; 0 = never. */
  startedAt: number
  /** How long the last one took; 0 = unknown. */
  tookMs: number
  running: boolean
  /** A pane ended and asked for a sweep sooner than the ordinary gap. */
  soon: boolean
  loadPerCore: number
}

export function sweepGap(c: Pick<SweepClock, 'tookMs' | 'soon' | 'loadPerCore'>): number {
  let gap = c.soon ? SWEEP_SOON_MS : SWEEP_EVERY_MS
  if (c.tookMs >= SWEEP_SLOW_MS) gap = Math.max(gap, c.tookMs * 10)
  if (c.loadPerCore >= SWEEP_BUSY_LOAD) gap *= 4
  return Math.min(SWEEP_MAX_MS, gap)
}

export function sweepDue(c: SweepClock): boolean {
  if (c.running) return false
  if (!c.startedAt) return true
  return c.now - c.startedAt >= sweepGap(c)
}
