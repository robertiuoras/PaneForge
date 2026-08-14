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

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { freemem, totalmem, platform } from 'node:os'
import type { Pressure } from '../shared/capacity'

/** How often the level is re-read. Cheap on every platform; a sysctl is microseconds. */
export const SAMPLE_MS = 15_000

/** Available-memory fractions that mean warn / critical on the platforms that report one. */
const WARN_FREE = 0.2
const CRIT_FREE = 0.08

function darwinPressure(): Pressure {
  try {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
    // 1 normal, 2 warn, 4 critical. Anything unparseable is treated as normal on purpose:
    // a probe that fails must never be the reason the app starts trimming panes.
    if (out === '4') return 'critical'
    if (out === '2') return 'warn'
    return 'normal'
  } catch {
    return 'normal'
  }
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
 * Poll the level and call back only when it CHANGES.
 *
 * Only on change because the consumer of this trims scrollback: firing every 15 seconds
 * would have the renderer re-deciding a no-op plan forever, and the log line that says
 * what was trimmed is worth keeping readable.
 */
export function watchPressure(onChange: (p: Pressure) => void): () => void {
  let last: Pressure | null = null
  const tick = (): void => {
    const now = readPressure()
    if (now === last) return
    last = now
    onChange(now)
  }
  tick()
  const t = setInterval(tick, SAMPLE_MS)
  // Never hold the process open for a poll: quitting mid-interval must not wait 15s.
  if (typeof t.unref === 'function') t.unref()
  return () => clearInterval(t)
}
