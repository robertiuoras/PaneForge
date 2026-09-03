// The one reading `shared/devList.ts` cannot do itself: where a dev server is REALLY
// standing, for the pids its own arithmetic could not attribute to any pane.
//
// A process's command line is not always enough. The case this exists for: `next dev -p
// 3006` had been reparented onto pid 1 - its pane long closed - and `next-server`, the
// child actually holding the memory, carries no path in its argv at all. Neither one can be
// named from what `ps` already read. `lsof -a -p <pid> -d cwd -Fn` asks the one thing that
// is still true regardless of argv: the folder the process is standing in right now.
//
// A failed read is a FAILED read, never "nobody owns it" - `runningDevs` in `shared/devList
// .ts` leaves a row exactly as it was for any pid missing from the map this returns.

import { execFile } from 'node:child_process'

const WIN = process.platform === 'win32'

/**
 * The working directory of one live pid, or null when it cannot be read.
 *
 * Windows has no `lsof`; `devServers.ts`'s own process table is the only thing this feature
 * has there, and that table already carries no cwd, so this refuses rather than guess.
 */
export function cwdOfPid(pid: number): Promise<string | null> {
  if (WIN || !Number.isInteger(pid) || pid <= 1) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      execFile(
        'lsof',
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { timeout: 5_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          for (const line of stdout.split('\n')) {
            if (line.startsWith('n')) {
              const dir = line.slice(1).trim()
              return resolve(dir || null)
            }
          }
          resolve(null)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * The cwd of every pid in `pids` that has one to give, read in parallel.
 *
 * One pid failing to answer never costs the others - each read is independent and a
 * refusal simply leaves that pid out of the map, which is exactly what `runningDevs` reads
 * as "this one changes nothing".
 */
export async function cwdsFor(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  await Promise.all(
    pids.map(async (pid) => {
      const cwd = await cwdOfPid(pid)
      if (cwd) out.set(pid, cwd)
    })
  )
  return out
}
