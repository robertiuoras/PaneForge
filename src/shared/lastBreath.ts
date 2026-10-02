// How the previous run ended, when it did not say so itself.
//
// 2026-09-30 11:17Z: the app went silent, and the next launch could only say "8 pane(s) left
// by a crash or a kill 3 min ago" - paneforge-errors.log had nothing. macOS knew: three
// spindump hang reports (`PaneForge_2026-09-30-211901_*.spin`, "Slow response to HID event",
// the main thread busy in a timer doing synchronous file reads) and loginwindow's "PaneForge
// [20879] force quit" at 11:20:17Z. A run that is killed cannot write its own last line, so
// it leaves a heartbeat while alive and the NEXT launch writes the line: when it was last
// heard from, and what macOS recorded about it after that.

/** What a running copy leaves in `last-breath.json`, rewritten every BREATH_EVERY_MS. */
export interface Breath {
  pid: number
  version: string
  /** Last time the main process was able to run a timer. */
  at: number
  /** Set by the quit line. A run that quit has already said why. */
  quit?: string
}

/** A macOS diagnostic report about this app: a `.spin` hang or an `.ips`/`.crash` crash. */
export interface HostReport {
  name: string
  at: number
  /** Its `Reason:`/`Exception Type:` line, when one could be read. */
  reason: string
}

export const BREATH_EVERY_MS = 30_000

/** Hangs it came back from before the last one, counted when they are this recent. */
const EARLIER_MS = 60 * 60_000

/** Files in DiagnosticReports that are about this app. */
export function isAppReport(name: string, appName: string): boolean {
  return name.startsWith(`${appName}_`) || name.startsWith(`${appName}-`)
    ? /\.(spin|ips|crash|hang)$/.test(name)
    : false
}

/** The line to log about the previous run, or null when there is nothing to attribute. */
export function previousEnd(prev: Breath | null, reports: HostReport[], pid: number, now: number): string | null {
  if (!prev || prev.pid === pid || prev.quit) return null
  const mins = Math.max(0, Math.round((now - prev.at) / 60_000))
  const head =
    `previous run (pid ${prev.pid}, v${prev.version}) ended without a quit; last heard from ` +
    `${new Date(prev.at).toISOString()} (${mins} min before this launch)`
  // A report is written after the trouble began and the heartbeat stops within one beat of
  // it, so the death's own reports are the ones newer than the last breath. Older ones are
  // hangs it came back from, worth a count: 09-30 had six in the hour before.
  const after = reports.filter((r) => r.at >= prev.at && r.at <= now).sort((a, b) => a.at - b.at)
  const earlier = reports.filter((r) => r.at < prev.at && r.at >= prev.at - EARLIER_MS && /\.(spin|hang)$/.test(r.name)).length
  const before = earlier ? `; ${earlier} earlier hang report(s) in the hour before` : ''
  const hang = after.find((r) => /\.(spin|hang)$/.test(r.name))
  const crash = after.find((r) => /\.(ips|crash)$/.test(r.name))
  if (crash) return `${head}: it crashed - macOS crash report ${crash.name}${crash.reason ? ` (${crash.reason})` : ''}${before}`
  if (hang)
    return (
      `${head}: it stopped responding and was force-quit or killed while hung - macOS hang report ` +
      `${hang.name}${hang.reason ? ` (${hang.reason})` : ''}${after.length > 1 ? `, ${after.length} reports` : ''}${before}`
    )
  return `${head}: no macOS crash or hang report - killed from outside (kill -9, Activity Monitor) or the machine lost power${before}`
}
