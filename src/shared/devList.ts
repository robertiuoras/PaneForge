// The dev servers running on this machine, as words, and which of them a sentence names.
//
// `devServers.ts` next door answers a different question - "what would the OTHER machine
// have to start again", so its answer is a package.json SCRIPT and never a process. This
// one answers "what is running right now, and where", so its answer is a pid, a port and
// the pane it belongs to. Turning one into the other loses exactly the two things anybody
// asking has in their head: the port they cannot reach and the pane it came out of.
//
// Everything here is arithmetic over a process table somebody else read. No fs, no
// child_process, no Electron - `npm run test:devlist`.

import { devSignalOf, inRepo } from './devServers'
import { projectOf } from './place'

/** One dev server, as it is running. */
export interface RunningDev {
  pid: number
  /** The whole command line, for the "seen" line and for nothing else. */
  cmd: string
  /** What it is: a script name (`dev`, `dev:https`) or a tool (`next`, `vite`). */
  label: string
  /** The port it was told to serve on, when the command line says so. */
  port: number | null
  /** The pane it belongs to, when one owns it. A server on ppid 1 may belong to nobody. */
  paneId: string | null
  /** 1-based sidebar position of that pane - the number a person says, and the Ctrl key. */
  pane: number | null
  /** That pane's project name, or the folder the command line named. */
  where: string
  /**
   * When no pane started or is running this (`pane` is null): the sidebar number of a
   * pane that has the SAME project open, even though it did not start this server. Null
   * when no pane does, or when reading the server's own folder failed - a failed reading
   * must never be answered as "nobody has it open".
   */
  hostedIn: number | null
}

/** A process, reduced to the three things attribution needs. */
export interface ProcLine {
  pid: number
  ppid: number
  cmd: string
}

/** A pane, reduced to what a dev server can be attributed to. */
export interface DevPane {
  id: string
  /** 1-based sidebar position. */
  pane: number
  name: string
  cwd: string
  /** The pty's pid, so a server still under the pane's own tree is found by the tree. */
  pid: number
}

/**
 * The port the command line asked for, or null.
 *
 * Every shape measured on this desk: `-p 3009`, `--port 5173`, `--port=5173`, and the
 * `PORT=3000` an npm script routinely puts in front of the binary. A bare number that is
 * not attached to one of those is NOT a port - `node --max-old-space-size=4096` is full of
 * numbers, and a wrong port in a sentence is worse than no port, because it is the one
 * thing somebody will act on.
 */
export function portOf(cmdline: string): number | null {
  const m =
    /(?:^|\s)(?:-p|--port|--PORT)[=\s]+(\d{2,5})(?:\s|$)/.exec(cmdline) ??
    /(?:^|\s)PORT=(\d{2,5})(?:\s|$)/.exec(cmdline)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 65535 ? n : null
}

/** Each process's parent, for walking UP - a child dev process is the same server. */
function parents(procs: ProcLine[]): Map<number, number> {
  const up = new Map<number, number>()
  for (const p of procs) up.set(p.pid, p.ppid)
  return up
}

/** Every live descendant of a pid, with a seen-set so a reused pid cannot close a loop. */
function descendants(procs: ProcLine[], root: number): Set<number> {
  const byParent = new Map<number, ProcLine[]>()
  for (const p of procs) {
    const kids = byParent.get(p.ppid)
    if (kids) kids.push(p)
    else byParent.set(p.ppid, [p])
  }
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      queue.push(kid.pid)
    }
  }
  return seen
}

/** What a server with no pane and no readable path is called. */
export const UNPLACED = 'somewhere else'

/** The last folder-looking thing in a command line, for a server no pane claims. */
function whereOf(cmdline: string): string {
  const m = /([^\s/\\]+)[/\\]node_modules[/\\]/.exec(cmdline)
  return m ? m[1] : UNPLACED
}

/**
 * What is running, once per pid, attributed to panes.
 *
 * Two-legged attribution for the reason `devServers.ts` documents at length: the dev
 * server measured on this desk had been reparented onto pid 1 with its npm parent long
 * gone, so a tree walk alone finds nothing. Tree first (it is the stronger claim), then
 * the path test.
 *
 * A server no pane claims is still LISTED. It is somebody's - a shell outside the app, a
 * pane closed an hour ago - and the whole complaint this answers is "what dev servers are
 * running", not "what dev servers does PaneForge own".
 *
 * `cwdOf` is the server's own working directory, keyed by pid, for the pids main already
 * went and read with `lsof` - the ONLY reading strong enough to name a server whose command
 * line carries no path at all (`next-server`) and whose starting pane is gone. Optional and
 * ordinarily empty: reading it is real IO, so main only spends it on pids this function
 * could not otherwise attribute.
 */
export function runningDevs(
  procs: ProcLine[],
  panes: DevPane[],
  cwdOf: Map<number, string> = new Map()
): RunningDev[] {
  const trees = new Map<string, Set<number>>()
  for (const p of panes) if (p.pid) trees.set(p.id, descendants(procs, p.pid))

  const out: RunningDev[] = []
  const seen = new Set<number>()
  for (const p of procs) {
    if (seen.has(p.pid)) continue
    const sig = devSignalOf(p.cmd)
    if (!sig) continue
    seen.add(p.pid)
    let owner: DevPane | null = null
    for (const pane of panes) {
      if (trees.get(pane.id)?.has(p.pid)) {
        owner = pane
        break
      }
    }
    if (!owner) owner = panes.find((pane) => inRepo(p.cmd, pane.cwd)) ?? null
    out.push({
      pid: p.pid,
      cmd: p.cmd,
      label: sig.kind === 'script' ? sig.script : sig.tool,
      port: portOf(p.cmd),
      paneId: owner?.id ?? null,
      pane: owner?.pane ?? null,
      where: owner?.name ?? whereOf(p.cmd),
      hostedIn: null
    })
  }
  // ONE server, not one process. Measured on this desk: `npm run dev -p 3100` and the
  // `next dev -p 3100` it spawned are both recognised, are both really running, and are
  // the same dev server - so a bare list said two and "close the second one" would have
  // killed a child of the first. A candidate whose ancestor chain reaches another
  // candidate is folded into that ancestor, because the ancestor is what a person typed
  // and killing it takes the tree with it.
  const up = parents(procs)
  const byPid = new Map(out.map((d) => [d.pid, d]))
  const kept: RunningDev[] = []
  for (const d of out) {
    let owner: RunningDev | null = null
    let cur = up.get(d.pid) ?? 0
    const walked = new Set<number>([d.pid])
    while (cur > 1 && !walked.has(cur)) {
      walked.add(cur)
      const anc = byPid.get(cur)
      if (anc) {
        owner = anc
        break
      }
      cur = up.get(cur) ?? 0
    }
    if (!owner) {
      kept.push(d)
      continue
    }
    // The child usually knows more: npm's own title carries no path, so the parent is the
    // one with no `where` and no port. Fold what it knows upward rather than losing it.
    if (owner.port === null) owner.port = d.port
    if (owner.pane === null && d.pane !== null) {
      owner.pane = d.pane
      owner.paneId = d.paneId
      owner.where = d.where
    } else if (owner.where === UNPLACED && d.where !== UNPLACED) owner.where = d.where
  }

  // A server no pane owns, named from where it is REALLY standing rather than a guess off
  // its argv. `cwdOf` only ever has an entry when main went and read it, so a pid absent
  // from the map changes nothing here - the row is exactly what it was before this ran.
  for (const d of kept) {
    if (d.pane !== null) continue
    const cwd = cwdOf.get(d.pid)
    if (!cwd) continue
    const project = projectOf(cwd)
    d.where = project
    const host = panes.find((pane) => projectOf(pane.cwd) === project)
    d.hostedIn = host?.pane ?? null
  }

  // Stable, and in the order a person would count them: by pane, then by port, then pid.
  return kept.sort(
    (a, b) => (a.pane ?? 99) - (b.pane ?? 99) || (a.port ?? 99999) - (b.port ?? 99999) || a.pid - b.pid
  )
}

/**
 * One dev server in a sentence. The port is what somebody is actually looking for.
 *
 * A server no pane owns never says "orphan" - the reader has never used git. It says
 * plainly that nobody is using it, or names the pane that has the same project open even
 * though that pane did not start it, which is the actual question this answers.
 */
export function devLine(d: RunningDev, n?: number): string {
  const at = d.port ? ` on port ${d.port}` : ''
  const who = d.pane
    ? `pane ${d.pane} (${d.where})`
    : d.hostedIn
      ? `${d.where} - pane ${d.hostedIn} has this project open`
      : `${d.where} - no pane here is using this`
  return `${n ? `${n}. ` : ''}${d.label}${at} - ${who}, pid ${d.pid}`
}

export function devReport(devs: RunningDev[]): string {
  if (!devs.length) return 'No dev server running that I can see.'
  const head = devs.length === 1 ? '1 dev server:' : `${devs.length} dev servers:`
  return `${head}\n${devs.map((d, i) => devLine(d, i + 1)).join('\n')}`
}

/**
 * Labels that are in the QUESTION as often as they are in an answer.
 *
 * A server started by `npm run dev` is labelled `dev`, and every sentence about dev
 * servers contains the word - so matching on it made "close the dev in pane 2" also name
 * every other `dev` on the machine. A tool name (`vite`, `next`) is a real handle and
 * still matches; a script name only ever matches through its pane, its port or its
 * number.
 */
const GENERIC_LABEL = /^(dev|devs|start|serve|server|watch|preview)(:.*)?$/i

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|one)\b/, 0],
  [/\b(second|2nd|two)\b/, 1],
  [/\b(third|3rd|three)\b/, 2],
  [/\b(fourth|4th|four)\b/, 3]
]

/**
 * The dev servers a sentence names, in the order they were listed.
 *
 * Every way somebody refers to one after reading the list out loud: by its number ("the
 * first one", "#2"), by everything ("both", "all of them"), by its port ("close 3009"),
 * by the pane it is in ("the PaneForge one", "pane 3"), or by the tool ("kill vite").
 *
 * An empty answer is the honest one and the caller says so - guessing which server "close
 * the dev" meant on a desk running three is how somebody loses the build they were
 * watching.
 */
export function pickDevs(text: string, devs: RunningDev[]): RunningDev[] {
  const low = text.toLowerCase()
  if (!devs.length) return []

  if (/\b(both|all|every|everything|each)\b/.test(low)) return [...devs]

  const hit = new Map<number, RunningDev>()
  const take = (d?: RunningDev): void => {
    if (d) hit.set(d.pid, d)
  }

  // A port, or a pid. Both are numbers a person reads straight off the list, and both are
  // exact - so they are tried before anything that could match loosely.
  for (const m of low.matchAll(/\b(\d{2,6})\b/g)) {
    const n = Number(m[1])
    take(devs.find((d) => d.port === n))
    take(devs.find((d) => d.pid === n))
  }

  // "pane 3" names the pane, and the pane's dev server is what is being asked about.
  for (const m of low.matchAll(/\bpane\s*#?\s*(\d{1,2})\b/g)) {
    const n = Number(m[1])
    for (const d of devs) if (d.pane === n) take(d)
  }

  // The tool or script it is running, and the project it is in. Longest name first for
  // the same reason `mascot.ts` does it: `service` is contained in `service-a`.
  for (const d of [...devs].sort((a, b) => b.where.length - a.where.length)) {
    if (d.where.length >= 3 && low.includes(d.where.toLowerCase())) take(d)
    if (d.label.length >= 3 && !GENERIC_LABEL.test(d.label) && new RegExp(`\\b${d.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low))
      take(d)
  }

  if (hit.size) return devs.filter((d) => hit.has(d.pid))

  // "the first dev", "the second one" - only once nothing more exact matched, because the
  // word "one" is in half of everything a person types.
  for (const [re, i] of ORDINALS) {
    if (re.test(low) && devs[i]) return [devs[i]]
  }

  // "close the dev server", with exactly one running, is unambiguous. With two it is not,
  // and the caller asks which.
  if (devs.length === 1) return [devs[0]]
  return []
}

/** Whether a sentence is about dev servers at all. */
export function mentionsDev(text: string): boolean {
  return /\b(dev|devs|server|servers|localhost|port)\b/i.test(text)
}
