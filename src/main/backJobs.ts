// One process table, with ages, for `shared/backJobs.ts`.
//
// The decisions all live next door in the shared module, which is pure and tested. This is
// the IO: a table with FULL command lines and how long each process has been alive.
//
// Neither of the two tables this app already reads can be reused. `strays.ts` samples
// every 30s but asks for `comm=` - the executable name - because all it ever compares is a
// pid and a creation time, and `node` says nothing about what a job is. `devServers.ts`
// asks for `command=` but no age, and age is what separates a cron loop from one of Claude
// Code's own hooks. So this asks for both, on demand, and never on a timer: `ps -Ao
// command=` is expensive enough that `devList.ts` says so in its own comment.

import { execFile } from 'node:child_process'
import { backJobs, type BackJob, type JobProc } from '../shared/backJobs'

const WIN = process.platform === 'win32'

/**
 * `etime` as seconds. Formats, all of them: `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`.
 *
 * A value this cannot read comes back undefined rather than 0 - `LOOP_MIN_SECONDS` refuses
 * anything younger than 30 seconds, so a zero would silently drop every loop on a platform
 * whose `ps` words this differently.
 */
export function etimeSeconds(raw: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim())
  if (!m) return undefined
  const [, d, h, mi, s] = m
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s)
}

const PS_WIN = [
  '$ErrorActionPreference="SilentlyContinue"',
  '$now=Get-Date',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine |',
  '  ForEach-Object {',
  '    $age = if ($_.CreationDate) { [int]($now - $_.CreationDate).TotalSeconds } else { -1 }',
  '    "$($_.ProcessId) $($_.ParentProcessId) $age $($_.CommandLine)"',
  '  }'
].join('\n')

function parseWin(text: string): JobProc[] {
  const out: JobProc[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const age = Number(m[3])
    const cmd = m[4].trim()
    if (!pid || pid === ppid || !cmd) continue
    out.push({ pid, ppid, cmd, elapsed: age >= 0 ? age : undefined })
  }
  return out
}

function parsePosix(text: string): JobProc[] {
  const out: JobProc[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const cmd = m[4].trim()
    if (!pid || pid === ppid || !cmd) continue
    out.push({ pid, ppid, cmd, elapsed: etimeSeconds(m[3]) })
  }
  return out
}

/** One table, or an empty one. Never a reason anything above it fails. */
export function jobTable(): Promise<JobProc[]> {
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string, parse: (s: string) => JobProc[]): void =>
      resolve(err || !stdout ? [] : parse(stdout))
    try {
      if (WIN) {
        const encoded = Buffer.from(PS_WIN, 'utf16le').toString('base64')
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => done(err, stdout, parseWin)
        )
      } else {
        execFile(
          'ps',
          ['-Ao', 'pid=,ppid=,etime=,command='],
          { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => done(err, stdout, parsePosix)
        )
      }
    } catch {
      resolve([])
    }
  })
}

/** What this machine is running that no pane owns. */
export async function listBackJobs(panePids: number[], roots: string[]): Promise<BackJob[]> {
  return backJobs(await jobTable(), panePids, roots)
}

export type { BackJob }
