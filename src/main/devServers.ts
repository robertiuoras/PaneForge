// Finding the dev servers a pane has running, and starting them again on the other machine.
//
// The decisions are all in `shared/devServers.ts`, which is pure and tested. This is the
// two pieces of IO it needs: one process table with FULL command lines, and one repo's
// package.json.
//
// `strays.ts` already samples the process table every 30s and cannot be reused for this:
// it asks for `comm=` (the executable name), because all it ever compares is a pid and a
// creation time, and `node` is a useless answer to "what dev server is this". So this asks
// for `command=` on its own, only when a handoff is actually happening.
//
// Attribution is deliberately two-legged. A pane's dev server is usually a descendant of
// its pty - and the one measured on this desk was not: `next dev -p 3009` was sitting on
// ppid 1, its npm parent long gone. So a process counts if it is under the pane's tree OR
// if its command line names a path inside the pane's repo.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { devPlan, devSignalOf, inRepo, managerFor, type DevServer } from '../shared/devServers'
import { runningDevs, type DevPane, type RunningDev } from '../shared/devList'

const WIN = process.platform === 'win32'

/** Just enough of a process to walk trees and read command lines. */
export interface Proc {
  pid: number
  ppid: number
  cmd: string
}

const PS_WIN = [
  '$ErrorActionPreference="SilentlyContinue"',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine |',
  '  ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'
].join('\n')

function parseTable(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!pid || pid === ppid) continue
    const cmd = m[3].trim()
    if (cmd) out.push({ pid, ppid, cmd })
  }
  return out
}

/** One process table, asynchronously, or an empty one. Never a reason a handoff fails. */
export function table(): Promise<Proc[]> {
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string): void => resolve(err || !stdout ? [] : parseTable(stdout))
    try {
      if (WIN) {
        const encoded = Buffer.from(PS_WIN, 'utf16le').toString('base64')
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => done(err, stdout)
        )
      } else {
        execFile(
          'ps',
          ['-Ao', 'pid=,ppid=,command='],
          { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => done(err, stdout)
        )
      }
    } catch {
      resolve([])
    }
  })
}

/** Every live descendant of `root`, with a seen-set so a reused pid cannot close a loop. */
export function descendants(procs: Proc[], root: number): Proc[] {
  const byParent = new Map<number, Proc[]>()
  for (const p of procs) {
    const kids = byParent.get(p.ppid)
    if (kids) kids.push(p)
    else byParent.set(p.ppid, [p])
  }
  const seen = new Set<number>([root])
  const out: Proc[] = []
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

/** A repo's scripts, or an empty set - a folder with no package.json simply has none. */
export function packageScripts(dir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.scripts ?? {})) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** The lockfiles in a folder, for deciding which package manager to run a script with. */
export function lockfiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => /lock/i.test(f))
  } catch {
    return []
  }
}

/**
 * What this pane has running that the other machine should start again.
 *
 * `cwd` is the pane's folder and doubles as the repo root for the path test - a pane
 * opened deeper in a repo attributes a shade less, which is the safe direction: a missed
 * dev server is a note, and a wrongly claimed one starts somebody else's server.
 */
export async function devServersOf(
  pid: number,
  cwd: string
): Promise<{ servers: DevServer[]; notes: string[] }> {
  const scripts = packageScripts(cwd)
  if (!Object.keys(scripts).length) return { servers: [], notes: [] }
  const procs = await table()
  if (!procs.length) return { servers: [], notes: [] }
  const mine = new Set<string>()
  for (const p of descendants(procs, pid)) mine.add(p.cmd)
  for (const p of procs) if (inRepo(p.cmd, cwd)) mine.add(p.cmd)
  return devPlan([...mine], scripts)
}

/**
 * The command the receiver runs, re-derived here from ITS repo - never from the payload.
 *
 * Null when this machine's copy of the project has no such script, which is the honest
 * answer for a repo that is a few commits behind or simply different: better a note than
 * a pane running something nobody named.
 */
export function localDevCommand(dir: string, script: string): string | null {
  if (!existsSync(join(dir, 'package.json'))) return null
  const scripts = packageScripts(dir)
  if (typeof scripts[script] !== 'string') return null
  return `${managerFor(lockfiles(dir))} run ${script}`
}


/**
 * Every dev server running on this machine, attributed to the panes that own them.
 *
 * The handoff path above asks a different question and gets a package.json script back;
 * this one is what the mascot answers "what dev servers are running" with, so it is pids
 * and ports - the two things somebody asking already has in their head and cannot get at.
 *
 * One process table read per call, on demand: this is a keystroke's worth of work, not a
 * timer, and `ps -Ao command=` is far too expensive to hold open (which is exactly why
 * `strays.ts` asks only for `comm=`).
 */
export async function listRunningDevs(panes: DevPane[]): Promise<RunningDev[]> {
  const procs = await table()
  if (!procs.length) return []
  return runningDevs(procs, panes)
}

/**
 * Stop one dev server, and the tree under it.
 *
 * Re-validated against the LIVE table before anything is signalled: the pid came out of a
 * list a person then read, typed at and confirmed, and a pid is reused. Killing whatever
 * now holds that number because it held a `vite` a minute ago is the one way this feature
 * could destroy something nobody named, so a pid whose command line is no longer a dev
 * server is refused and said out loud.
 *
 * SIGTERM, then SIGKILL for anything still alive - a dev server given no chance to close
 * its own sockets leaves the port occupied, which is the failure somebody restarts the
 * machine over.
 */
export async function stopDevServer(pid: number): Promise<{ ok: boolean; why?: string }> {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, why: 'not a process I can stop' }
  const procs = await table()
  const me = procs.find((p) => p.pid === pid)
  if (!me) return { ok: false, why: 'already gone' }
  if (!devSignalOf(me.cmd)) return { ok: false, why: 'that pid is not a dev server any more' }

  if (WIN) {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 }, () =>
        resolve()
      )
    })
    return { ok: true }
  }

  const kids = descendants(procs, pid).map((p) => p.pid)
  const all = [...kids, pid]
  const signal = (sig: NodeJS.Signals): void => {
    for (const target of all) {
      try {
        process.kill(target, sig)
      } catch {
        /* already gone */
      }
    }
  }
  signal('SIGTERM')
  await new Promise((r) => setTimeout(r, 2500))
  const after = await table()
  if (after.some((p) => p.pid === pid)) signal('SIGKILL')
  return { ok: true }
}
