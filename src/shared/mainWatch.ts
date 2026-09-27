// The arithmetic for the process that watches the Electron main process.
//
// This deliberately counts the watchdog's own ticks rather than only elapsed wall time.
// A laptop sleep pauses both processes, and must not look like a frozen app after wake.

export const BEAT_MS = 2_000
export const HANG_MS = 75_000
const SLEEP_GAP_MS = BEAT_MS * 3

export interface MainWatchState {
  receivedBeat: boolean
  silentTicks: number
  lastTickAt: number
  acted: boolean
}

export type MainWatchAction = 'wait' | 'act'

export function fresh(): MainWatchState {
  return { receivedBeat: false, silentTicks: 0, lastTickAt: 0, acted: false }
}

/** Accepting a beat resets only the consecutive-miss reading. */
export function beat(state: MainWatchState): MainWatchState {
  return { ...state, receivedBeat: true, silentTicks: 0 }
}

/** One child timer tick. The returned state makes this decision testable without Electron. */
export function decide(state: MainWatchState, now: number, hangMs = HANG_MS): { action: MainWatchAction; state: MainWatchState } {
  if (state.acted) return { action: 'wait', state: { ...state, lastTickAt: now } }
  // One long gap is suspend or wake, not a missed heartbeat. Start a fresh count after it.
  if (state.lastTickAt && now - state.lastTickAt > SLEEP_GAP_MS) {
    return { action: 'wait', state: { ...state, silentTicks: 0, lastTickAt: now } }
  }
  const silentTicks = state.receivedBeat ? state.silentTicks + 1 : 0
  const next = { ...state, silentTicks, lastTickAt: now }
  if (!state.receivedBeat || silentTicks * BEAT_MS < hangMs) return { action: 'wait', state: next }
  return { action: 'act', state: { ...next, acted: true } }
}

/**
 * What main says about itself with every beat.
 *
 * Four lines in a week (2026-09-18 to 09-23) said only "stopped (0)" or "no heartbeat for
 * 76s", which is a retry counter, not a cause. A silence is read against the last beat
 * before it: was main already heavy (`rssMb`, `heapMb`), already late on its own timers
 * (`lagMs`), already busy (`cpuPct`, of one core), and when did the window last answer
 * (`rendererAgoMs`, null until it has)?
 */
export interface Vitals {
  rssMb: number
  heapMb: number
  lagMs: number
  cpuPct: number
  rendererAgoMs: number | null
}

/** What the previous reading has to remember for the next one's deltas. */
export interface VitalsMark {
  at: number
  cpuUs: number
}

export function readVitals(
  prev: VitalsMark | null,
  now: number,
  mem: { rss: number; heapUsed: number },
  cpuUs: number,
  rendererAt: number
): { vitals: Vitals; mark: VitalsMark } {
  const gap = prev ? now - prev.at : 0
  const vitals: Vitals = {
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    // A beat timer that fires late is the main thread having been busy for the difference.
    lagMs: prev ? Math.max(0, gap - BEAT_MS) : 0,
    cpuPct: prev && gap > 0 ? Math.round(((cpuUs - prev.cpuUs) / 1000 / gap) * 100) : 0,
    rendererAgoMs: rendererAt > 0 ? Math.max(0, now - rendererAt) : null
  }
  return { vitals, mark: { at: now, cpuUs } }
}

export function describeVitals(v: Vitals): string {
  const window = v.rendererAgoMs === null ? 'window has not answered yet' : `window answered ${Math.round(v.rendererAgoMs / 1000)}s before`
  return `memory ${v.rssMb}MB (heap ${v.heapMb}MB), timers ${v.lagMs}ms late, cpu ${v.cpuPct}% of a core, ${window}`
}

/** One os.cpus() entry's `times`. */
export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

/** How busy the whole machine was between two os.cpus() readings, or null if unknown. */
export function machineBusyPct(before: CpuTimes[], after: CpuTimes[]): number | null {
  if (!before.length || before.length !== after.length) return null
  let busy = 0
  let total = 0
  for (let i = 0; i < after.length; i++) {
    const a = after[i]
    const b = before[i]
    const idle = a.idle - b.idle
    const all = a.user - b.user + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + idle
    total += all
    busy += all - idle
  }
  return total > 0 ? Math.round((busy / total) * 100) : null
}

/**
 * `tasklist /V /FO CSV /NH` for one pid, as a phrase: Windows' own view of a main process
 * that stopped beating. "Not Responding" is Windows saying the window thread is stuck; the
 * cpu time, read against the last beat's `cpuPct`, says whether it is stuck spinning or
 * stuck waiting.
 */
export function describeTasklist(csv: string): string | null {
  const line = csv.split(/\r?\n/).find((l) => l.startsWith('"'))
  if (!line) return null
  const cells = line.slice(1, -1).split('","')
  if (cells.length < 8) return null
  return `windows says ${cells[5]}, cpu time ${cells[7]}, memory ${cells[4]}`
}

export interface SilenceReading {
  silentS: number
  what: string
  pid: number
  /** The last beat that did arrive, and how long before the decision. */
  last: { agoS: number; vitals: Vitals } | null
  machine: { freeMb: number; totalMb: number; busyPct: number | null }
  /** The OS's own reading of the stuck process, when it answered in time. */
  proc: string | null
}

/** The one line paneforge-errors.log gets when main stops beating. */
export function silenceLine(r: SilenceReading): string {
  const parts = [`main: no heartbeat for ${r.silentS}s - ${r.what} (pid ${r.pid})`]
  parts.push(r.last ? `last beat ${r.last.agoS}s before: ${describeVitals(r.last.vitals)}` : 'no beat carried readings')
  const busy = r.machine.busyPct === null ? 'cpu unknown' : `cpu ${r.machine.busyPct}% busy`
  parts.push(`machine: ${r.machine.freeMb}MB free of ${r.machine.totalMb}MB, ${busy}`)
  if (r.proc) parts.push(r.proc)
  return parts.join(' | ')
}

/**
 * The line for the watchdog helper's own `exit`/`error` event, from the fork's point of
 * view. "stopped (0)" with nothing else is the four lines from 2026-09-18 to 09-23; this
 * adds what main itself last reported about its own health, read against the machine.
 */
export function forkStoppedReason(
  reason: string,
  forkedAt: number,
  now: number,
  beatsSent: number,
  latest: Vitals | null,
  freeMb: number,
  totalMb: number
): string {
  const uptimeS = Math.round((now - forkedAt) / 1000)
  const main = latest ? describeVitals(latest) : 'no beat was sent before this'
  return `${reason} after ${uptimeS}s, ${beatsSent} beats sent; main: ${main}; machine: ${freeMb}MB free of ${totalMb}MB`
}
