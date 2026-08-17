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
import { devPlan, inRepo, managerFor, type DevServer } from '../shared/devServers'

const WIN = process.platform === 'win32'

/** Just enough of a process to walk trees and read command lines. */
interface Proc {
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
function table(): Promise<Proc[]> {
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
function descendants(procs: Proc[], root: number): Proc[] {
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
