// The once-a-minute "what was the desk doing" line, `pressure.log` in userData.
//
// 2026-10-01: a laggy desk (pressure 2, 7.6 GB of 9 GB swap used) had nothing on disk to say
// which process held the memory or when it got that way, and 21 leaked `caffeinate`
// children went unnoticed for hours. Pure parts only here: parsing the ONE `ps` call and
// building the JSON line. The sampler that runs `ps` is `main/pressureLog.ts`.

export interface PsRow {
  pid: number
  ppid: number
  rssKb: number
  cpuPct: number
  /** The command as `ps -o comm=` prints it: a full path, spaces allowed. */
  comm: string
}

/** The arguments of the single `ps` call. `comm` LAST: it is the only field with spaces. */
export const PS_ARGS = ['-Ao', 'pid=,ppid=,rss=,pcpu=,comm=']

export function parsePsTable(text: string): PsRow[] {
  const out: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpuPct: Number(m[4]), comm: m[5] })
  }
  return out
}

/** `vm.swapusage: total = 8192.00M  used = 7265.75M  free = 926.25M  (encrypted)` -> used MB. */
export function parseSwapUsedMb(text: string): number | null {
  const m = /used = ([\d.]+)([MG])/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Math.round(m[2] === 'G' ? n * 1024 : n)
}

export interface PressurePane {
  id: string
  pid: number
  status: string
}

export interface PressureInput {
  at: number
  kernel: string
  compressor: string
  loadavg1: number
  cores: number
  compressorMb: number | null
  swapUsedMb: number | null
  ownPid: number
  panes: PressurePane[]
  rows: PsRow[]
}

const base = (comm: string): string => comm.slice(comm.lastIndexOf('/') + 1)
const mb = (kb: number): number => Math.round(kb / 1024)

/** The pane's root and every descendant. Seen-set: a pid reused by the OS must not loop. */
function treeRows(rows: PsRow[], root: number): PsRow[] {
  const kids = new Map<number, PsRow[]>()
  for (const r of rows) {
    const list = kids.get(r.ppid)
    if (list) list.push(r)
    else kids.set(r.ppid, [r])
  }
  const self = rows.find((r) => r.pid === root)
  const out: PsRow[] = self ? [self] : []
  const seen = new Set([root])
  const queue = [root]
  while (queue.length) {
    for (const k of kids.get(queue.shift() as number) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      queue.push(k.pid)
    }
  }
  return out
}

export function buildPressureLine(i: PressureInput): Record<string, unknown> {
  const inPane = new Set<number>()
  const panes = i.panes.map((p) => {
    const tree = treeRows(i.rows, p.pid)
    for (const r of tree) inPane.add(r.pid)
    const rssKb = tree.reduce((a, r) => a + r.rssKb, 0)
    const cpu = tree.reduce((a, r) => a + r.cpuPct, 0)
    return { id: p.id, pid: p.pid, rssMb: mb(rssKb), cpuPct: Math.round(cpu * 10) / 10, status: p.status, alive: tree.length > 0 }
  })
  const top = i.rows
    .filter((r) => !inPane.has(r.pid))
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, 5)
    .map((r) => ({ name: base(r.comm), pid: r.pid, rssMb: mb(r.rssKb) }))
  return {
    ts: new Date(i.at).toISOString(),
    pressure: { kernel: i.kernel, compressor: i.compressor },
    load1: Math.round(i.loadavg1 * 100) / 100,
    loadPerCore: i.cores > 0 ? Math.round((i.loadavg1 / i.cores) * 100) / 100 : null,
    compressorMb: i.compressorMb,
    swapUsedMb: i.swapUsedMb,
    panes,
    top,
    caffeinateChildren: i.rows.filter((r) => r.ppid === i.ownPid && base(r.comm) === 'caffeinate').length
  }
}
