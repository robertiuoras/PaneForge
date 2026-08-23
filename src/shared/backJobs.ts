// What a machine is doing OUTSIDE its panes.
//
// A pane is visible: it is a card in the sidebar, and since the sessions list learned to
// carry the other machine's panes, a pane on the PC is a row here too. Everything else
// that machine runs is invisible from this desk - the `claude -p` a scheduled task fires
// every ten minutes, the loop that has been wedged since Tuesday, the dev server left on
// port 3009 - and on a machine whose whole job is running work unattended, that is most of
// what it does. "Is anything happening over there" was a question you answered by walking
// to it or by opening an SSH session.
//
// Three narrow classes rather than "every process", and the narrowness is the feature: a
// process table is ~700 rows on this desk and a list of 700 answers nothing. Anything
// under a pane's own process tree is left out on purpose - that work already has a card,
// and listing it twice is the duplicate-row bug `shared/desk.ts` documents at length.
//
// Pure arithmetic over a table somebody else read - no fs, no child_process, no Electron,
// so the rules can be argued with in `npm run test:backjobs` rather than in a live pane.
// `main/backJobs.ts` is the one process-table read it needs, and `main/remote/*` carries
// the answer across the link.

import { BUILTIN_AGENTS } from './agents'
import { devSignalOf } from './devServers'
import { portOf } from './devList'

/** A process, reduced to what any of the rules below can ask about. */
export interface JobProc {
  pid: number
  ppid: number
  /** the whole command line - the executable name alone answers nothing here */
  cmd: string
  /** seconds it has been alive, when the table gave one */
  elapsed?: number
}

/**
 * What kind of work this is.
 *
 * `agent` - one of the CLIs this app itself runs, running outside a pane. On the machine
 * doing the unattended work this is the whole point: a scheduled `claude -p` is an agent
 * turn that nothing on this desk could see.
 * `dev` - a dev server. Already understood by `shared/devList.ts`; this only borrows it.
 * `loop` - a script under the projects root that has been alive long enough to be a job
 * rather than a hook. This is the cron/scheduler class, and it is the one that needs an
 * age filter to be worth reading at all.
 */
export type JobKind = 'agent' | 'dev' | 'loop'

export interface BackJob {
  pid: number
  kind: JobKind
  /** short: `claude`, `next`, `lane-cron.mjs` */
  label: string
  /** the whole command line, for the hover and for nothing else */
  cmd: string
  /** the port it was told to serve on, when it said one */
  port: number | null
  /** the project it is in, or '' when the command line names nowhere */
  where: string
  /** seconds alive, when the table gave one */
  elapsed?: number
  /** an agent running with a print/exec flag: a turn nobody is watching */
  headless?: boolean
}

/**
 * How old a script has to be before it counts as a job.
 *
 * The `loop` class is the only one that needs this, and without it the list is mostly
 * Claude Code's own hooks: this repo fires several per prompt, each alive for under a
 * second, and a list that flickers is one nobody trusts. Thirty seconds keeps every real
 * loop and no hook. Agents and dev servers are listed the moment they appear - those are
 * never accidental.
 */
export const LOOP_MIN_SECONDS = 30

/** The CLIs this app knows how to run, by the name they appear under in a process table. */
const AGENT_BINS = new Set(
  BUILTIN_AGENTS
    // `shell` is bash or powershell, which is half a process table. An agent pane running
    // a shell is a pane, and a shell outside one is not news.
    .filter((a) => a.id !== 'shell')
    .map((a) => a.bin)
)

/**
 * An agent invoked to do one turn and exit, rather than to sit at a prompt.
 *
 * Worth separating because it is the shape a scheduler produces, and because a headless
 * turn is the one that can be silently failing for a week: there is no screen for it to
 * print an error onto.
 */
const HEADLESS_FLAG = /(?:^|\s)(?:-p|--print|--prompt|-m|--message|--headless|--non-?interactive|exec|run)(?:\s|=|$)/

/** Scripts, as a scheduler or a cron line would name one. */
const SCRIPT_FILE = /[^\s"']+\.(?:mjs|cjs|js|ts|py|sh|rb|ps1)\b/

/** Anything belonging to a running Electron app, ours included. */
const ELECTRON = /(?:--type=(?:renderer|gpu-process|utility|zygote|broker)|Electron(?: Helper)?\.app|PaneForge(?: Helper)?\.app|electron\/dist)/

function basename(path: string): string {
  const m = /([^\\/]+)$/.exec(path.replace(/["']/g, ''))
  return m ? m[1] : path
}

/** argv, near enough: quoted runs held together, everything else split on whitespace. */
function argv(cmdline: string): string[] {
  return cmdline.match(/"[^"]*"|'[^']*'|\S+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) ?? []
}

/**
 * The agent binary this command line runs, or ''.
 *
 * The basename of argv[0], and of argv[1] when argv[0] is a runtime - `node .../claude` is
 * how several of these are installed. Never a substring test on the whole line: every
 * process on this machine has `/Users/x/.claude/` somewhere in its arguments, and matching
 * that would call the entire table an agent.
 */
export function agentBinOf(cmdline: string): string {
  const a = argv(cmdline)
  if (!a.length) return ''
  const head = basename(a[0])
  if (AGENT_BINS.has(head)) return head
  if (/^(?:node|bun|deno|npx|python3?)$/.test(head) && a[1]) {
    const next = basename(a[1])
    if (AGENT_BINS.has(next)) return next
  }
  return ''
}

/** Every live descendant of `root`, plus `root` itself. */
function tree(procs: JobProc[], root: number): Set<number> {
  const byParent = new Map<number, JobProc[]>()
  for (const p of procs) {
    const kids = byParent.get(p.ppid)
    if (kids) kids.push(p)
    else byParent.set(p.ppid, [p])
  }
  const seen = new Set<number>([root])
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

/** The project a command line is working in, off the projects root, or ''. */
export function projectOf(cmdline: string, roots: string[]): string {
  const line = cmdline.replace(/\\/g, '/')
  for (const root of roots) {
    if (!root) continue
    const norm = root.replace(/\\/g, '/').replace(/\/+$/, '')
    const at = line.toLowerCase().indexOf(norm.toLowerCase() + '/')
    if (at < 0) continue
    const rest = line.slice(at + norm.length + 1)
    const name = /^([^\s/"']+)/.exec(rest)
    if (name) return name[1]
  }
  return ''
}

/**
 * The work a machine is doing that has no pane.
 *
 * `panePids` are the ptys; everything under one of them is that pane's own work and is
 * left out. `roots` is the projects root (one string on an ordinary desk) and decides
 * which scripts count as loops - a script somewhere else on the disk is the operating
 * system's business, not this app's.
 */
export function backJobs(procs: JobProc[], panePids: number[], roots: string[]): BackJob[] {
  const owned = new Set<number>()
  for (const pid of panePids) if (pid) for (const p of tree(procs, pid)) owned.add(p)

  const found: BackJob[] = []
  for (const p of procs) {
    if (owned.has(p.pid)) continue
    if (ELECTRON.test(p.cmd)) continue

    const bin = agentBinOf(p.cmd)
    if (bin) {
      found.push({
        pid: p.pid,
        kind: 'agent',
        label: bin,
        cmd: p.cmd,
        port: null,
        where: projectOf(p.cmd, roots),
        elapsed: p.elapsed,
        headless: HEADLESS_FLAG.test(p.cmd.slice(p.cmd.indexOf(bin) + bin.length))
      })
      continue
    }

    const dev = devSignalOf(p.cmd)
    if (dev) {
      found.push({
        pid: p.pid,
        kind: 'dev',
        label: dev.kind === 'script' ? dev.script : dev.tool,
        cmd: p.cmd,
        port: portOf(p.cmd),
        where: projectOf(p.cmd, roots),
        elapsed: p.elapsed
      })
      continue
    }

    const where = projectOf(p.cmd, roots)
    if (!where) continue
    if ((p.elapsed ?? 0) < LOOP_MIN_SECONDS) continue
    const script = SCRIPT_FILE.exec(p.cmd)
    if (!script) continue
    found.push({
      pid: p.pid,
      kind: 'loop',
      label: basename(script[0]),
      cmd: p.cmd,
      port: portOf(p.cmd),
      where,
      elapsed: p.elapsed
    })
  }

  // ONE job, not one process - the same fold `devList.ts` does and for the same measured
  // reason: `npm run dev` and the `next dev` it spawned are both real, both recognised and
  // are one server. A job whose ancestor chain reaches another job OF THE SAME KIND is
  // that job's child.
  //
  // The kind test is the difference from `devList.ts`, which only ever holds one kind. A
  // dev server an agent started is not part of that agent: they are two different facts
  // about the machine, and folding the server into the run leaves a card that says an
  // agent is listening on port 5173.
  const up = new Map<number, number>()
  for (const p of procs) up.set(p.pid, p.ppid)
  const byPid = new Map(found.map((j) => [j.pid, j]))
  const kept: BackJob[] = []
  for (const j of found) {
    let owner: BackJob | null = null
    let cur = up.get(j.pid) ?? 0
    const walked = new Set<number>([j.pid])
    while (cur > 1 && !walked.has(cur)) {
      walked.add(cur)
      const anc = byPid.get(cur)
      if (anc && anc.kind === j.kind) {
        owner = anc
        break
      }
      cur = up.get(cur) ?? 0
    }
    if (!owner) {
      kept.push(j)
      continue
    }
    // The child usually knows more - a manager's own title carries neither the port nor
    // the path - so what it knows is folded upward rather than thrown away.
    if (owner.port === null) owner.port = j.port
    if (!owner.where && j.where) owner.where = j.where
  }

  const rank: Record<JobKind, number> = { agent: 0, dev: 1, loop: 2 }
  return kept.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || (b.elapsed ?? 0) - (a.elapsed ?? 0) || a.pid - b.pid
  )
}

/** How long something has been running, in the words a person would use. */
export function ageWords(seconds?: number): string {
  if (!seconds || seconds < 0) return ''
  if (seconds < 90) return `${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  if (mins < 90) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** One job in a sentence. */
export function jobLine(j: BackJob): string {
  const bits = [j.label]
  if (j.headless) bits.push('-p')
  if (j.port) bits.push(`on port ${j.port}`)
  if (j.where) bits.push(`in ${j.where}`)
  const age = ageWords(j.elapsed)
  if (age) bits.push(`for ${age}`)
  return bits.join(' ')
}

/** What the panel says above the list, or '' when there is nothing to say. */
export function jobsSummary(jobs: BackJob[]): string {
  if (!jobs.length) return ''
  const n = (k: JobKind): number => jobs.filter((j) => j.kind === k).length
  const parts: string[] = []
  if (n('agent')) parts.push(`${n('agent')} agent ${n('agent') === 1 ? 'run' : 'runs'}`)
  if (n('dev')) parts.push(`${n('dev')} dev ${n('dev') === 1 ? 'server' : 'servers'}`)
  if (n('loop')) parts.push(`${n('loop')} ${n('loop') === 1 ? 'script' : 'scripts'}`)
  return parts.join(', ')
}
