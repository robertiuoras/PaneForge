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
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime,CreationDate,CommandLine |',
  '  ForEach-Object {',
  '    $age = [long]((Get-Date) - $_.CreationDate).TotalSeconds',
  '    "$($_.ProcessId) $($_.ParentProcessId) $([long]($_.WorkingSetSize/1024)) ' +
    '$([long](($_.UserModeTime + $_.KernelModeTime)/10000)) $age $($_.CommandLine)" }'
].join('\n')

/**
 * `pid ppid rssKb cpuMs ageSeconds commandLine` per line - what the Windows command is
 * asked for directly.
 *
 * The last two are optional in the match on purpose: a row whose `CommandLine` the OS
 * refuses (a protected process) still has to be counted, or the pane it belongs to loses
 * part of its cost over a column that only feeds a chip.
 */
export function parseWindows(text: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?(?:\s+(.*))?$/)
    if (!m) continue
    const pid = Number(m[1])
    if (!pid) continue
    const row: UsageRow = { pid, ppid: Number(m[2]), rssKb: Number(m[3]), cpuMs: Number(m[4]) }
    if (m[5] !== undefined) row.elapsed = Number(m[5])
    if (m[6]) row.cmd = m[6]
    out.push(row)
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

/**
 * `[[dd-]hh:]mm:ss` from `ps -o etime=`, in seconds.
 *
 * The same four shapes `parseCpuTime` covers, and read from the right for the same reason -
 * which fields are present depends on how long the process has run.
 */
export function parseElapsed(text: string): number {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  const parts = rest.split(':').map((n) => Number(n))
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return Math.round((Number(days) * 24 + hours) * 3600 + minutes * 60 + seconds)
}

/**
 * `pid ppid rss time etime command` from
 * `ps -Ao pid=,ppid=,rss=,time=,etime=,command=`. rss is already KB there.
 *
 * The command line is LAST because it is the only field with spaces in it, and the two
 * fields after `time` are optional in the parse: the four-column form is what every
 * previous version of this file asked for and a row is still a row without them.
 */
export function parsePosix(text: string): UsageRow[] {
  const out: UsageRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(\S+))?(?:\s+(.*))?$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const rssKb = Number(m[3])
    if (!pid || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue
    const row: UsageRow = { pid, ppid, rssKb, cpuMs: parseCpuTime(m[4]) }
    if (m[5] !== undefined) row.elapsed = parseElapsed(m[5])
    if (m[6]) row.cmd = m[6]
    out.push(row)
  }
  return out
}

/**
 * macOS: `pid  mem` out of `top -l 1 -stats pid,mem`, in KB.
 *
 * `ps -o rss=` is the WRONG number on this platform and by a factor nobody would guess.
 * macOS compresses idle pages: a compressed page leaves the resident set but still costs
 * physical RAM, and it is `phys_footprint` - not RSS - that the kernel's memory-pressure
 * math and the "your system has run out of application memory" panel are computed from.
 * Measured on this desk 2026-08-17, six Claude Code CLIs: RSS said 1739 MB, footprint said
 * 3283 MB. One PaneForge renderer read 64 MB resident against 1225 MB of footprint, a
 * factor of 19. So the chip that exists to answer "which of these is eating my machine"
 * was quietly answering with about half the truth, and the half it left out is the half
 * the OS objects to.
 *
 * `top` rather than `footprint`, which is per-process and costs ~40ms each - a hundred
 * processes a tick is not a readout, it is a second job. One `top -l 1` is ~0.7s for the
 * whole table and prints exactly the footprint figure (578M/1228M/444M against footprint's
 * 578/1225/448 on the same pids, same minute).
 *
 * Values carry a unit suffix and sometimes a `+`/`-` growth marker: `578M`, `35M+`, `4096K`,
 * `1.2G`. A row that does not parse is left out, which leaves that pid on its RSS.
 */
export function parseTopMem(text: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/)
    if (!m) continue
    const pid = Number(m[1])
    const size = Number(m[2])
    if (!pid || !Number.isFinite(size)) continue
    const kb =
      m[3] === 'B' ? size / 1024 : m[3] === 'K' ? size : m[3] === 'M' ? size * 1024 : size * 1048576
    out.set(pid, Math.round(kb))
  }
  return out
}

/**
 * Rows with `rssKb` replaced by the footprint reading wherever there is one.
 *
 * A pid `top` did not report - it started between the two reads, or the whole probe failed -
 * keeps its RSS rather than dropping out. An undercount for one process is a smaller lie
 * than a pane that vanishes from the readout.
 */
export function mergeFootprint(rows: UsageRow[], mem: Map<number, number>): UsageRow[] {
  if (!mem.size) return rows
  return rows.map((r) => {
    const kb = mem.get(r.pid)
    return kb === undefined ? r : { ...r, rssKb: kb }
  })
}

/** One process table, asynchronously. An empty array is a failed probe, never a zero desk. */
export function snapshot(
  done: (rows: UsageRow[], mem?: Map<number, number>) => void
): void {
  const finish = (err: unknown, stdout: string): void => {
    if (err || !stdout) return done([])
    if (WIN) return done(parseWindows(stdout))
    const rows = parsePosix(stdout)
    if (process.platform !== 'darwin' || !rows.length) return done(rows)
    // The topology and the CPU counters come from `ps`; only the memory column is replaced.
    // A `top` that fails, times out or prints nothing hands back an empty map, and the desk
    // is reported on RSS exactly as it was before any of this existed.
    execFile(
      'top',
      ['-l', '1', '-stats', 'pid,mem'],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      (topErr, topOut) => {
        if (topErr || !topOut) return done(rows)
        const mem = parseTopMem(topOut)
        done(mergeFootprint(rows, mem), mem)
      }
    )
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
        ['-Ao', 'pid=,ppid=,rss=,time=,etime=,command='],
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
 *
 * Memory is the same trap as the panes and worse: `workingSetSize` is Chromium's resident
 * set, and a renderer measured here read 64 MB resident against 1225 MB of footprint. So
 * when the sampler has a footprint table in hand, our OWN pids are looked up in it too -
 * `getAppMetrics()` carries each process's pid, which is what makes that possible without
 * guessing which of the machine's Electron processes are ours. No table, and it falls back
 * to what Electron said.
 */
export function appCost(mem?: Map<number, number>): { mb: number; cpuPct: number } {
  try {
    const metrics = app.getAppMetrics()
    let kb = 0
    let cpu = 0
    for (const m of metrics) {
      kb += mem?.get(m.pid) ?? m.memory?.workingSetSize ?? 0
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
    snapshot((rows, mem) => {
      busy = false
      if (!rows.length) return
      const elapsed = lastAt ? at - lastAt : 0
      const { panes, cpuNow } = summarise(rows, live, previous, elapsed)
      previous = cpuNow
      lastAt = at
      const own = appCost(mem)
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
