// What each pane is actually costing the machine, right now.
//
// `capacity.ts` answers "can this desk hold another pane" from a MODEL: 190 MB per agent,
// 7.2 MB per full scrollback, measured once on 2026-08-14 and frozen. That model is right
// about the average and useless about the question a person actually asks at the moment
// the fans spin up, which is "which one of these four is eating my machine". An agent that
// started a `next build` held 1442 MB while its three neighbours held 180 - the model
// reports all four at 190.
//
// So this measures. Per pane it is the pty's whole descendant TREE, not the pty: the shell
// is a rounding error and everything expensive (the agent, its node processes, the build it
// started) hangs below it. Same tree walk the stray sweeper already does - `descendantsOf`
// in strays.ts - because the two are asking the same question of the same table.
//
// Pure on purpose, like capacity.ts: the platform commands and the timer live in
// src/main/usage.ts, and everything that decides anything is arithmetic that a test can
// run without a real process tree. `npm run test:usage`.

// Type-only, and it must stay that way: `scripts/usage-test.mjs` imports this file into
// node with type stripping, where a VALUE import of an extensionless sibling does not
// resolve. The reading itself is attached in `main/usage.ts`, which is bundled.
import type { PaneBackJob } from './paneBackJobs'

/** One row of the process table, with the two figures strays.ts does not need. */
export interface UsageRow {
  pid: number
  ppid: number
  /**
   * What this process costs in physical memory, in KB.
   *
   * `WorkingSetSize` on Windows, and on macOS the `phys_footprint` figure `top` prints
   * rather than `ps -o rss=` - a compressed page has left the resident set and has not
   * left the machine, and on this desk that gap was a factor of 2 across the agents and
   * 19 on one renderer. `main/usage.ts` does the swap; the name is kept because a row is
   * still one process's memory and every consumer treats it as such.
   */
  rssKb: number
  /**
   * Cumulative CPU time in MILLISECONDS since the process started.
   *
   * Cumulative rather than a percentage because the percentages the platforms hand out
   * are not comparable: macOS `ps %cpu` is a decaying average over the process's whole
   * life (a pane that thrashed an hour ago still reads hot), and Windows has no per-
   * process percentage at all without a perf counter that costs a second to read. A
   * difference between two samples of a monotonic counter means the same thing everywhere.
   */
  cpuMs: number
  /**
   * The whole command line, when the table was asked for one.
   *
   * Not part of the cost - it is what `shared/paneBackJobs.ts` needs to tell a command an
   * agent started from an MCP server it spawned. It rides on this row because this is the
   * only process-table read in the app that already runs on a timer, and a second read for
   * one column is ~380ms of `ps` every few seconds for a chip.
   */
  cmd?: string
  /** Seconds alive, when the table gave one. Same reason as `cmd`. */
  elapsed?: number
}

/** What one pane costs, as sent to the renderer. */
export interface PaneUsage {
  /** Resident memory of the pty and everything under it, in MB. */
  rssMb: number
  /**
   * Share of ONE core, as a percentage, over the interval between the last two samples.
   *
   * Not clamped to 100: a pane running a parallel build genuinely holds 400% of a core,
   * and that is the number Activity Monitor and `top` both print. Null until a second
   * sample exists to difference against - a first reading of "0%" would be a lie.
   */
  cpuPct: number | null
  /** How many live processes the pane is holding, pty included. Trees are the story. */
  procs: number
  /**
   * What this pane is still RUNNING that nothing else in the app can see: a
   * `run_in_background` shell, a Monitor loop, a build started in the background.
   *
   * Cosmetic, and deliberately no part of any "is this pane busy" reading - the head of
   * `shared/paneBackJobs.ts` says why a false job THERE is expensive and here costs a
   * glance. Attached by `main/usage.ts` after this summary, so nothing in this file has to
   * import the rule.
   */
  jobs?: PaneBackJob[]
  /**
   * Why this pane's work cannot follow it to another machine (`shared/paneBound.ts`).
   *
   * NOT cosmetic, unlike `jobs`: `shared/autoHandoff.ts` refuses to move a pane carrying
   * one. It rides here because the process table this needs is already being read every
   * 4s for the memory chip, and a second ~380ms `ps` for a refusal would be the waste
   * that reading exists to avoid. Attached by `main/usage.ts` after this summary, so
   * nothing in this file has to import the rule.
   */
  bound?: string
}

export interface UsageReport {
  /** Keyed by session id. Panes whose pty has gone are absent, not zeroed. */
  panes: Record<string, PaneUsage>
  /** Every pane's tree, added up. */
  panesMb: number
  /** PaneForge's own processes: main, renderers, GPU, utility. */
  appMb: number
  /** `panesMb + appMb` - what quitting PaneForge would hand back. */
  totalMb: number
  /** Every pane's CPU added up, plus the app's. Same units as `PaneUsage.cpuPct`. */
  cpuPct: number | null
  /** Physical RAM in MB, so the renderer can say "of 16 GB" without a second channel. */
  machineMb: number
}

/** ppid -> children. One index per sample rather than one walk per root. */
function childIndex(rows: UsageRow[]): Map<number, UsageRow[]> {
  const byParent = new Map<number, UsageRow[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r)
    else byParent.set(r.ppid, [r])
  }
  return byParent
}

/**
 * The root and every live descendant of it.
 *
 * Root INCLUDED, which is the one difference from `descendantsOf` in strays.ts: that file
 * is looking for processes to kill after the root is gone, this one is adding up what a
 * pane costs and the pty is part of the cost. Same seen-set for the same reason - a pid
 * whose parent field points back up its own tree (Windows reuses pids) would loop forever.
 */
export function treeOf(rows: UsageRow[], root: number): UsageRow[] {
  const byParent = childIndex(rows)
  const self = rows.find((r) => r.pid === root)
  const out: UsageRow[] = self ? [self] : []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      out.push(kid)
      queue.push(kid.pid)
    }
  }
  return out
}

/**
 * Per-pane totals from one process-table sample, plus the previous sample's CPU counters.
 *
 * `previous` is a pid -> cumulative-ms map, not the whole previous report, because a tree
 * changes shape between samples: a build that spawned forty compilers and finished is not
 * a CPU spike to be divided by, it is forty processes that no longer exist. Differencing
 * per PID and summing the differences charges the pane for the work those processes did
 * while they lived, and charges nothing for their disappearance.
 *
 * A pid seen for the first time contributes its whole cumulative time, capped at the
 * interval: an agent that had already run for thirty seconds when the sampler first saw it
 * must not be reported as 3000% of a core for one tick.
 */
export function summarise(
  rows: UsageRow[],
  roots: { id: string; pid: number }[],
  previous: Map<number, number>,
  elapsedMs: number
): { panes: Record<string, PaneUsage>; cpuNow: Map<number, number> } {
  const panes: Record<string, PaneUsage> = {}
  const cpuNow = new Map<number, number>()
  for (const { id, pid } of roots) {
    const tree = treeOf(rows, pid)
    if (!tree.length) continue
    let rssKb = 0
    let deltaMs = 0
    for (const p of tree) {
      rssKb += p.rssKb
      cpuNow.set(p.pid, p.cpuMs)
      const before = previous.get(p.pid)
      // A counter that went BACKWARDS is a reused pid, never a process that un-ran.
      if (before === undefined || p.cpuMs < before) deltaMs += Math.min(p.cpuMs, elapsedMs)
      else deltaMs += p.cpuMs - before
    }
    panes[id] = {
      rssMb: Math.round(rssKb / 1024),
      cpuPct:
        previous.size === 0 || elapsedMs <= 0 ? null : Math.round((deltaMs / elapsedMs) * 100),
      procs: tree.length
    }
  }
  return { panes, cpuNow }
}

/**
 * Bytes as a person reads them: three significant figures, and never a decimal point on a
 * number that changes every few seconds at that precision.
 *
 * "1.4 GB" and "860 MB", not "1434 MB" and "0.84 GB". The switch is at 1024 MB because
 * that is where four digits start, and four digits in a chip is where the pane title
 * stops fitting.
 */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return '-'
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * CPU for a chip. Below 1% is printed as nothing rather than "0%": an idle agent showing
 * a live-looking zero is the same noise as a status line that never changes.
 */
export function formatCpu(pct: number | null): string {
  if (pct === null || pct < 1) return ''
  return `${Math.round(pct)}%`
}

/** The whole report, from the parts. Kept here so the test can assert on the arithmetic. */
export function report(
  panes: Record<string, PaneUsage>,
  appMb: number,
  appCpuPct: number | null,
  machineMb: number
): UsageReport {
  const list = Object.values(panes)
  const panesMb = list.reduce((n, p) => n + p.rssMb, 0)
  const known = list.filter((p) => p.cpuPct !== null)
  const cpuPct =
    known.length === 0 && appCpuPct === null
      ? null
      : Math.round(known.reduce((n, p) => n + (p.cpuPct as number), 0) + (appCpuPct ?? 0))
  return {
    panes,
    panesMb: Math.round(panesMb),
    appMb: Math.round(appMb),
    totalMb: Math.round(panesMb + appMb),
    cpuPct,
    machineMb
  }
}
