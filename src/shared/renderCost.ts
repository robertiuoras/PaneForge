/**
 * What the window is SPENDING, as arithmetic over a CPU profile.
 *
 * The installed renderer sat at 88% of one core for two days with the desk quiet
 * (2026-09-18), and there was no way to say what the time went on: `ps` reports a
 * lifetime average rather than what is happening now, `sample` names the busy THREAD and
 * never the function, and the installed app has no debugger port to attach to from
 * outside. `scripts/render-cost.mjs` could only profile a dev copy, which is a different
 * process with none of the state that accumulated.
 *
 * So the app profiles itself: `main/renderCost.ts` attaches Electron's own
 * `webContents.debugger`, which is the same CDP a port would have given, and hands the
 * profile here to be turned into a table. Nothing in this file touches Electron, so the
 * arithmetic is testable on its own (`npm run test:rendercost`).
 */

/** One function in the profile, and the time the samples landed inside it. */
export type CostRow = {
  /** What the function is called, or `(anonymous)`. V8's own labels are kept as-is. */
  name: string
  /** `file.js:line`, blank for a V8 builtin or a native frame. */
  where: string
  /** Microseconds of SELF time - samples that landed in this frame, not its children. */
  us: number
  /** Share of the profile's whole span, 0-100. */
  pct: number
}

export type Cost = {
  /** The span the profile covers, in milliseconds, off the profile's own clock. */
  spanMs: number
  /** Percent of one core spent in JS - everything that is not V8's `(idle)` frame. */
  busyPct: number
  /** Percent of one core V8 spent waiting for work. High here means the cost is paint. */
  idlePct: number
  /** Heaviest self-time first, `(idle)` removed - it is reported as `idlePct` instead. */
  rows: CostRow[]
}

/** V8's own frames for "nothing to run" and "not in JS at all". */
const IDLE = new Set(['(idle)', '(program)', '(root)'])

type Node = {
  id: number
  callFrame?: { functionName?: string; url?: string; lineNumber?: number }
}
export type Profile = {
  nodes: Node[]
  samples?: number[]
  timeDeltas?: number[]
  startTime?: number
  endTime?: number
}

/**
 * Turn a `Profiler.stop` payload into the table.
 *
 * The profile is a flat node list plus a sample stream, so a node's SELF time is simply
 * the gaps attributed to its own samples - there is no tree walk to do and no child time
 * to subtract. A missing delta counts as zero rather than being guessed at: a profile
 * that arrived short should read as less time measured, never as time invented.
 */
export function readProfile(profile: Profile | null | undefined, keep = 20): Cost {
  const nodes = profile?.nodes ?? []
  const samples = profile?.samples ?? []
  const deltas = profile?.timeDeltas ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const self = new Map<number, number>()
  samples.forEach((id, i) => {
    const us = deltas[i]
    self.set(id, (self.get(id) ?? 0) + (typeof us === 'number' && us > 0 ? us : 0))
  })

  // The span the profile itself declares, so a stopped-early profile reports the time it
  // really covered. Falling back to the samples keeps a profile with no clock honest.
  const declared = (profile?.endTime ?? 0) - (profile?.startTime ?? 0)
  const counted = [...self.values()].reduce((a, b) => a + b, 0)
  const span = declared > 0 ? declared : counted

  let idle = 0
  const rows: CostRow[] = []
  for (const [id, us] of self) {
    const frame = byId.get(id)?.callFrame ?? {}
    const name = frame.functionName || '(anonymous)'
    if (IDLE.has(name)) {
      idle += us
      continue
    }
    const file = frame.url ? frame.url.split('/').pop() : ''
    rows.push({
      name,
      where: file ? `${file}:${(frame.lineNumber ?? 0) + 1}` : '',
      us,
      pct: span > 0 ? (us / span) * 100 : 0,
    })
  }
  rows.sort((a, b) => b.us - a.us)

  return {
    spanMs: Math.round(span / 1000),
    busyPct: span > 0 ? ((span - idle) / span) * 100 : 0,
    idlePct: span > 0 ? (idle / span) * 100 : 0,
    rows: rows.slice(0, keep),
  }
}

/**
 * The reading in words, for a terminal.
 *
 * A number with no verdict beside it gets read as whatever the reader already believed,
 * which is how a lifetime average passed for a live one all morning. So the table carries
 * the sentence that says which of the two answers it is.
 */
export function costWords(cost: Cost): string {
  const head =
    `${cost.spanMs} ms profiled - ${cost.busyPct.toFixed(1)}% of one core in JS, ` +
    `${cost.idlePct.toFixed(1)}% idle`
  const verdict =
    cost.busyPct < 20
      ? 'JS is not the cost here: the time is going on paint, the GPU, or another process.'
      : 'JS is the cost: the rows below are where it went.'
  const lines = cost.rows
    .filter((r) => r.pct >= 0.4)
    .map(
      (r) =>
        `${r.pct.toFixed(1).padStart(5)}%  ${(r.us / 1000).toFixed(0).padStart(6)}ms  ` +
        `${r.name}${r.where ? `  ${r.where}` : ''}`
    )
  return [head, verdict, '', ...(lines.length ? lines : ['  nothing above 0.4% - the window is quiet'])].join('\n')
}
