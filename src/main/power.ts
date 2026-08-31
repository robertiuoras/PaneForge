/**
 * Is this machine running off its own battery?
 *
 * Electron answers this with `powerMonitor.isOnBatteryPower()` and on this Mac the
 * answer is WRONG. Measured 2026-09-01, Electron 33 on macOS 27, with `pmset -g batt`
 * saying `Now drawing from 'Battery Power'` at 60% discharging: the Electron call
 * returned `false`. That is electron/electron#29291, filed in 2021, closed as not
 * reproducible, still reported - so it is not a version to wait out.
 *
 * A feature gated on that call would simply never fire, and would never say so: nothing
 * throws, nothing logs, the saving is just quietly absent. So macOS asks `pmset`, which
 * is the same source Chromium's own PowerMonitor wraps. Windows keeps the Electron call
 * - it is not reported broken there, and there is no pmset to ask.
 */
import { execFile } from 'node:child_process'
import { powerMonitor } from 'electron'

/**
 * The one line of `pmset -g batt` that names the source, e.g.
 *   Now drawing from 'Battery Power'
 *
 * Throws rather than guessing. An unreadable answer must not come back as `false`: that
 * is the shape of a good answer, so a broken parser would read as a plugged-in laptop
 * forever and nobody would ever find out.
 */
export function parsePmsetBatt(out: string): boolean {
  const m = out.match(/Now drawing from '([^']+)'/)
  if (!m) {
    throw new Error(`pmset -g batt: no "Now drawing from" line in ${JSON.stringify(out.slice(0, 160))}`)
  }
  return m[1] === 'Battery Power'
}

function pmset(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 4000 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        resolve(parsePmsetBatt(stdout))
      } catch (e) {
        reject(e)
      }
    })
  })
}

/** Best answer available on this platform. Falls back to Electron's if pmset cannot run. */
export async function onBatteryNow(): Promise<boolean> {
  if (process.platform !== 'darwin') return powerMonitor.isOnBatteryPower()
  try {
    return await pmset()
  } catch {
    // A Mac with no pmset is not a machine this app has ever run on, but a wrong answer
    // here only costs some animation frames, so it is not worth failing a window over.
    return powerMonitor.isOnBatteryPower()
  }
}

/**
 * Call `onChange` whenever the answer changes, and once with the answer now.
 *
 * The events come from the same Electron implementation whose getter is wrong above, so
 * they are treated as a HINT and not as the source: every hint re-reads pmset, and a
 * slow backstop re-reads it anyway in case no hint ever arrives. Five minutes because
 * plugging a laptop in is not a thing that needs to be noticed inside a second, and one
 * `pmset` call costs a few milliseconds - against a decoration loop that costs frames
 * at 120Hz for as long as it is wrong.
 */
export function watchPower(onChange: (onBattery: boolean) => void): () => void {
  let last: boolean | null = null
  let stopped = false
  const check = async (): Promise<void> => {
    const now = await onBatteryNow()
    if (stopped || now === last) return
    last = now
    onChange(now)
  }
  const hint = (): void => void check()
  powerMonitor.on('on-battery', hint)
  powerMonitor.on('on-ac', hint)
  powerMonitor.on('resume', hint)
  const timer = setInterval(hint, 5 * 60_000)
  timer.unref()
  void check()
  return () => {
    stopped = true
    clearInterval(timer)
    powerMonitor.off('on-battery', hint)
    powerMonitor.off('on-ac', hint)
    powerMonitor.off('resume', hint)
  }
}
