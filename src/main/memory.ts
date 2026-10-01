// Asking each platform the one memory question it answers honestly.
//
// There is no portable "how much memory is left". The three desktop kernels disagree about
// what the question even means, and two of the three have a number that LOOKS like the
// answer and is not:
//
//   macOS   `os.freemem()` reports 122 MB on a machine that is running fine, because the
//           OS keeps every page it can. Swap-used% sits near 100% at idle because the swap
//           file is never shrunk. Both readings have already caused automation on this
//           desk to kill healthy processes. The real answer is the kernel's own verdict,
//           `kern.memorystatus_vm_pressure_level`, which is what jetsam itself acts on:
//           1 normal, 2 warn, 4 critical.
//   Windows `os.freemem()` IS meaningful - it is GlobalMemoryStatusEx's ullAvailPhys.
//   Linux   MemAvailable in /proc/meminfo is the maintained answer to exactly this
//           question. `os.freemem()` is MemFree, which excludes reclaimable cache and so
//           reads far too low on a healthy box.
//
// Each branch below therefore uses that platform's trustworthy signal and maps it onto the
// same three levels. Nothing here decides anything: the policy is in src/shared/capacity.ts
// so it can be tested without filling a real machine's RAM.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem, platform } from 'node:os'
import { compressorLevel, lagLevel, worstPressure, type MemoryShape, type Pressure } from '../shared/capacity'

/** How often the level is re-read. Cheap on every platform; a sysctl is microseconds. */
export const SAMPLE_MS = 15_000

/** Available-memory fractions that mean warn / critical on the platforms that report one. */
const WARN_FREE = 0.2
const CRIT_FREE = 0.08

/**
 * The last level macOS reported, refreshed in the background.
 *
 * This was an `execFileSync` on every read, on the main process. A sysctl is microseconds,
 * but starting one is a fork, and on 2026-09-23 (load 400 on 10 cores, 87 MB free) a fork
 * took 2-4 seconds - every one of them a frozen window, and every child that finished in
 * that stretch left unreaped: 245 zombies under PaneForge that morning. Now a read answers
 * from the last reading and asks for a new one without waiting; the first read is `normal`,
 * which is what a failed probe has always meant here.
 */
let darwinLevel: Pressure = 'normal'
let darwinAskedAt = 0
let darwinAsking = false
/**
 * The compressor's verdict, read beside the kernel's flag and combined with it by
 * `worstPressure`. The flag flips (see `compressorLevel`): the desk at 05:35Z on
 * 2026-09-23 read level 1 with 6470M compressed and 139M unused, and the ladder stayed off.
 */
let darwinCompressor: Pressure = 'normal'
let darwinStatAsking = false
function darwinPressure(): Pressure {
  const now = Date.now()
  if (!darwinAsking && now - darwinAskedAt >= SAMPLE_MS / 2) {
    darwinAsking = true
    darwinAskedAt = now
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      darwinAsking = false
      // 1 normal, 2 warn, 4 critical. Anything unparseable is treated as normal on purpose:
      // a probe that fails must never be the reason the app starts trimming panes.
      const out = err ? '' : stdout.trim()
      darwinLevel = out === '4' ? 'critical' : out === '2' ? 'warn' : 'normal'
    })
    if (!darwinStatAsking) {
      darwinStatAsking = true
      execFile('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        darwinStatAsking = false
        const shape = err ? null : parseVmStat(stdout, totalmem())
        // A failed or unparseable read leaves the LAST verdict rather than resetting it: a
        // fork that timed out on a thrashing machine is not evidence the machine recovered.
        if (shape) darwinCompressor = compressorLevel(shape)
      })
    }
  }
  return worstPressure(darwinLevel, darwinCompressor)
}

/**
 * `vm_stat`'s free and compressor pages as MB, or null when either line is missing.
 *
 *   Mach Virtual Memory Statistics: (page size of 16384 bytes)
 *   Pages free:                                8901.
 *   Pages occupied by compressor:            414080.
 *
 * Page size is read off the header rather than assumed: Apple silicon is 16 KB, Intel Macs
 * are 4 KB, and the same number of pages is a fourfold different amount of memory.
 */
export function parseVmStat(text: string, totalBytes: number): MemoryShape | null {
  const size = /page size of (\d+) bytes/.exec(text)
  const free = /^Pages free:\s+(\d+)\./m.exec(text)
  const comp = /^Pages occupied by compressor:\s+(\d+)\./m.exec(text)
  if (!size || !free || !comp) return null
  const page = Number(size[1])
  if (!Number.isFinite(page) || page <= 0) return null
  const mb = (pages: string): number => Math.round((Number(pages) * page) / 1048576)
  return { totalMb: Math.round(totalBytes / 1048576), unusedMb: mb(free[1]), compressorMb: mb(comp[1]) }
}

function linuxAvailable(): number | null {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const avail = /^MemAvailable:\s+(\d+) kB$/m.exec(info)
    const total = /^MemTotal:\s+(\d+) kB$/m.exec(info)
    if (!avail || !total) return null
    return Number(avail[1]) / Number(total[1])
  } catch {
    return null
  }
}

/** Fraction-of-available mapped onto the same three levels. */
export function levelFromFree(fraction: number): Pressure {
  if (fraction <= CRIT_FREE) return 'critical'
  if (fraction <= WARN_FREE) return 'warn'
  return 'normal'
}

export function readPressure(): Pressure {
  switch (platform()) {
    case 'darwin':
      return darwinPressure()
    case 'linux': {
      const f = linuxAvailable()
      return f === null ? 'normal' : levelFromFree(f)
    }
    default:
      // Windows, and anything else whose freemem is a real available-physical figure.
      return levelFromFree(freemem() / totalmem())
  }
}

/** Physical RAM in MB. `totalmem` is the one figure every platform reports honestly. */
export function totalMb(): number {
  return Math.round(totalmem() / 1048576)
}

/**
 * How many runnable threads there are per core, or 0 where the platform has no answer.
 *
 * This is the "my laptop is lagging" reading, and it exists because the memory verdict
 * above arrives late: this desk sat at `warn` all afternoon with nine agent CLIs up while
 * the load average ran at 8.70 on 10 cores. Windows has no load average at all - Node
 * returns [0, 0, 0] there - and 0 is read as "no reading" rather than "idle" by
 * `lagLevel`, so nothing on that platform is ever moved because of a number that was never
 * measured.
 */
export function loadPerCore(): number {
  const cores = cpus().length || 1
  const one = loadavg()[0]
  return Number.isFinite(one) && one > 0 ? one / cores : 0
}

/**
 * Poll the level and call back only when it CHANGES.
 *
 * Only on change because the consumer of this trims scrollback: firing every 15 seconds
 * would have the renderer re-deciding a no-op plan forever, and the log line that says
 * what was trimmed is worth keeping readable.
 */
export function watchPressure(onChange: (p: Pressure) => void): () => void {
  let last: Pressure | null = null
  let lastLag: Pressure | null = null
  const tick = (): void => {
    const now = readPressure()
    // The lag band is watched here as well as the memory verdict, and for a reason that is
    // easy to miss: the consumer re-reads BOTH when this fires, so a desk whose memory is
    // steady at `normal` while its load climbs past a core apiece would otherwise never be
    // told - the reading that changed is not the one this poll was written for.
    const lag = lagLevel(loadPerCore())
    if (now === last && lag === lastLag) return
    last = now
    lastLag = lag
    onChange(now)
  }
  tick()
  const t = setInterval(tick, SAMPLE_MS)
  // Never hold the process open for a poll: quitting mid-interval must not wait 15s.
  if (typeof t.unref === 'function') t.unref()
  return () => clearInterval(t)
}
