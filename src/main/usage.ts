// Reading the process table for what the panes cost. The decisions are in shared/usage.ts.
//
// Two rules this file exists to keep:
//
//   - Nothing here may block the main process. `execFile`, never `execFileSync`. A full
//     process table costs ~380ms on this M4 (665 processes) and a PowerShell CIM query
//     costs more; done synchronously every few seconds that is a busy cursor on every
//     keystroke, which is exactly what strays.ts is already forbidden from doing.
//   - Nothing here may run when nobody can see it. A minimised app polling `ps` forever
//     is the shape of thing that gets an app blamed for a warm laptop, and the app it
//     would be blaming is this one. The sampler asks before each tick.
//
// The app's OWN cost comes from `app.getAppMetrics()` instead of the table: Electron
// already knows its renderers, GPU and utility processes, it is free to ask, and asking
// the table would mean deciding which of the machine's Electron processes are ours.

import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import { app, BrowserWindow } from 'electron'
import { report, summarise, type UsageReport, type UsageRow } from '../shared/usage'

/**
 * How often the panes are re-measured.
 *
 * 4s rather than 1s: the figure is read by a person glancing at a chip, not by a control
 * loop, and each sample is a process-table read. 4s also puts the CPU percentage over a
 * window long enough that a single fast command shows up as a bump rather than a flicker.
 */
export const SAMPLE_MS = 4000

const WIN = process.platform === 'win32'

/**
 * Windows: WorkingSetSize is bytes, and the two CPU counters are in 100-nanosecond ticks,
 * so both are converted here rather than in the parser - the parser's contract is KB and
 * milliseconds on every platform.
 */
const SNAPSHOT_PS = [
  '$ErrorActionPreference="SilentlyContinue"',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime |',
  '  ForEach-Object {',
  '    "$($_.ProcessId) $($_.ParentProcessId) $([long]($_.WorkingSetSize/1024)) ' +
    '$([long](($_.UserModeTime + $_.KernelModeTime)/10000))" }'
].join('\n')

/** `pid ppid rssKb cpuMs` per line - what the Windows command is asked for directly. */
export function parseWindows(text: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (!pid) continue
    out.push({ pid, ppid: Number(m[2]), rssKb: Number(m[3]), cpuMs: Number(m[4]) })
  }
  return out
}

/**
 * `ps -o time=` prints cumulative CPU as `[[dd-]hh:]mm:ss[.cc]`, and which of those
 * fields are present depends on how long the process has run - a five-second-old agent
 * prints `0:05.12` and a day-old one prints `1-04:11:09`. Splitting on the separators and
 * reading the fields from the RIGHT is the only form that covers all four shapes.
 */
export function parseCpuTime(text: string): number {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = rest.split(':').map((n) => Number(n))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return Math.round(((Number(days) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000)
}

/** `pid ppid rss time` from `ps -Ao pid=,ppid=,rss=,time=`. rss is already KB there. */
export function parsePosix(text: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rssKb = Number(parts[2])
    if (!pid || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue
    out.push({ pid, ppid, rssKb, cpuMs: parseCpuTime(parts[3]) })
  }
  return out
}

/** One process table, asynchronously. An empty array is a failed probe, never a zero desk. */
export function snapshot(done: (rows: UsageRow[]) => void): void {
  const finish = (err: unknown, stdout: string): void => {
    if (err || !stdout) return done([])
    done(WIN ? parseWindows(stdout) : parsePosix(stdout))
  }
  try {
    if (WIN) {
      const encoded = Buffer.from(SNAPSHOT_PS, 'utf16le').toString('base64')
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => finish(err, stdout)
      )
    } else {
      execFile(
        'ps',
        ['-Ao', 'pid=,ppid=,rss=,time='],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => finish(err, stdout)
      )
    }
  } catch {
    // No ps, no powershell, a locked-down box: a readout may never be a requirement.
    done([])
  }
}

/**
 * PaneForge's own resident cost and CPU, from Electron rather than from the table.
 *
 * `percentCPUUsage` is already a share of one core per process, which is the same unit
 * shared/usage.ts uses for the panes, so the two add up honestly.
 */
export function appCost(): { mb: number; cpuPct: number } {
  try {
    const metrics = app.getAppMetrics()
    let kb = 0
    let cpu = 0
    for (const m of metrics) {
      kb += m.memory?.workingSetSize ?? 0
      cpu += m.cpu?.percentCPUUsage ?? 0
    }
    return { mb: Math.round(kb / 1024), cpuPct: Math.round(cpu) }
  } catch {
    return { mb: 0, cpuPct: 0 }
  }
}

/** Is anybody looking? A hidden or fully minimised window has nothing to read a chip with. */
function watched(): boolean {
  try {
    return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
  } catch {
    return false
  }
}

/**
 * Sample the panes on a timer and hand each report to `onReport`.
 *
 * `roots` is asked for per sample rather than handed in once, the same way trackStrays
 * asks: panes open and close between ticks, and a captured list would be measuring pids
 * that have been recycled.
 *
 * One sample is in flight at a time. If a tick arrives while `ps` is still running the
 * tick is dropped - two overlapping process-table reads cost twice as much and produce
 * one report.
 */
export function trackUsage(
  roots: () => { id: string; pid: number }[],
  onReport: (r: UsageReport) => void
): () => void {
  let previous = new Map<number, number>()
  let lastAt = 0
  let busy = false

  const tick = (): void => {
    if (busy || !watched()) return
    const live = roots()
    if (!live.length) {
      // Nothing to measure, but the app still costs something and the renderer still has
      // a total to draw. Cheap enough to report without touching the process table.
      const own = appCost()
      previous = new Map()
      lastAt = 0
      onReport(report({}, own.mb, own.cpuPct, machineMb()))
      return
    }
    busy = true
    const at = Date.now()
    snapshot((rows) => {
      busy = false
      if (!rows.length) return
      const elapsed = lastAt ? at - lastAt : 0
      const { panes, cpuNow } = summarise(rows, live, previous, elapsed)
      previous = cpuNow
      lastAt = at
      const own = appCost()
      onReport(report(panes, own.mb, own.cpuPct, machineMb()))
    })
  }

  const t = setInterval(tick, SAMPLE_MS)
  if (typeof t.unref === 'function') t.unref()
  tick()
  return () => clearInterval(t)
}

/** Physical RAM in MB, kept here so the renderer never has to ask a second channel. */
export function machineMb(): number {
  return Math.round(totalmem() / 1048576)
}
