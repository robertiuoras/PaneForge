// Bounded, prompt-free evidence for a main thread that gradually stops answering.
// Reuse the watchdog's heartbeat and the asynchronous diagnostic log writer.
import { performance } from 'node:perf_hooks'
import type { Vitals } from '../shared/mainWatch'
import { appendLog } from './logWrite'

type Task = 'idle-sweep' | 'codex-proof' | 'done-close' | 'exited-close' | 'lane-maintenance'
const tasks = new Map<Task, { calls: number; totalMs: number; maxMs: number }>()
let file: string | null = null
let version = 'unknown'
let lastReport = 0
let lastSlow = 0
const REPORT_MS = 30_000
const ROTATE_BYTES = 256 * 1024
let peaks = { samples: 0, maxLagMs: 0, maxCpuPct: 0, maxRssMb: 0, maxHeapMb: 0 }

export function startMainPerformance(path: string, appVersion: string): void {
  file = path
  version = appVersion
  lastReport = 0
  lastSlow = 0
  tasks.clear()
  peaks = { samples: 0, maxLagMs: 0, maxCpuPct: 0, maxRssMb: 0, maxHeapMb: 0 }
}

export function measureMainTask<T>(task: Task, run: () => T): T {
  const start = performance.now()
  try {
    return run()
  } finally {
    const ms = performance.now() - start
    const prev = tasks.get(task) ?? { calls: 0, totalMs: 0, maxMs: 0 }
    prev.calls++
    prev.totalMs += ms
    prev.maxMs = Math.max(prev.maxMs, ms)
    tasks.set(task, prev)
    const now = Date.now()
    if (file && ms >= 250 && now - lastSlow >= REPORT_MS) {
      lastSlow = now
      appendLog(file, JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, version,
        kind: 'slow-task', task, durationMs: Math.round(ms) }) + '\n', { rotateAt: ROTATE_BYTES })
    }
  }
}

export function mainPerformanceBeat(now: number, vitals: Vitals): void {
  if (!file) return
  peaks.samples++
  peaks.maxLagMs = Math.max(peaks.maxLagMs, vitals.lagMs)
  peaks.maxCpuPct = Math.max(peaks.maxCpuPct, vitals.cpuPct)
  peaks.maxRssMb = Math.max(peaks.maxRssMb, vitals.rssMb)
  peaks.maxHeapMb = Math.max(peaks.maxHeapMb, vitals.heapMb)
  if (now - lastReport < REPORT_MS) return
  lastReport = now
  const durations = [...tasks].map(([task, r]) => ({ task, calls: r.calls,
    totalMs: Math.round(r.totalMs), maxMs: Math.round(r.maxMs) }))
  tasks.clear()
  appendLog(file, JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, version,
    kind: 'main-performance', ...vitals, ...peaks, tasks: durations }) + '\n', { rotateAt: ROTATE_BYTES })
  peaks = { samples: 0, maxLagMs: 0, maxCpuPct: 0, maxRssMb: 0, maxHeapMb: 0 }
}
