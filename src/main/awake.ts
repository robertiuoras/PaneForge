// Electron's half of "do not sleep while a pane is working". Every judgement is in
// shared/awake.ts; this file is the power API and the clock.
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { powerSaveBlocker, screen } from 'electron'
import { AwakeKeeper, type AwakePane } from '../shared/awake'

/** How often the desk is re-read. A pane going quiet is not worth a faster clock. */
export const AWAKE_TICK_MS = 30_000

/**
 * The clamshell reading, cached for a tick. `ioreg` is a process and the tick is the only
 * caller, so this is one spawn every 30s and only on macOS.
 */
let lidShutAt = 0
let lidShutAnswer = false

function lidShut(): boolean {
  if (process.platform !== 'darwin') return false
  const now = Date.now()
  if (now - lidShutAt < AWAKE_TICK_MS / 2) return lidShutAnswer
  lidShutAt = now
  try {
    const out = execFileSync('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], {
      encoding: 'utf8',
      timeout: 3000
    })
    lidShutAnswer = /"AppleClamshellState"\s*=\s*Yes/.test(out)
  } catch {
    // A reading that failed is not a shut lid. Falling through to `false` keeps the
    // behaviour this app always had rather than blanking a screen somebody is reading.
    lidShutAnswer = false
  }
  return lidShutAnswer
}

/**
 * Nobody can see this machine's screen - see `AwakeInput.screenUnseen`.
 *
 * Electron's own display list answers the external-monitor half without a second process:
 * a display that is not `internal` is a monitor somebody may be working at, and blanking
 * a clamshell desk mid-use is the one failure this must never have.
 */
export function screenUnseen(): boolean {
  if (!lidShut()) return false
  try {
    return !screen.getAllDisplays().some((d) => !d.internal)
  } catch {
    return false
  }
}

export function startDisplayAwake(opts: {
  panes(): readonly AwakePane[]
  enabled(): boolean
  log?(line: string): void
}): { keeper: AwakeKeeper; tick(): void; stop(): void } {
  let displayBlockerId: number | null = null
  let appBlockerId: number | null = null
  // Two separate holds. `-i` (system) runs whenever a pane is working so background work
  // keeps going; `-d` (display) runs only while someone is actually at the desk, so an
  // empty room gets a black screen instead of a drained battery.
  let systemCaffeinate: ChildProcess | null = null
  let displayCaffeinate: ChildProcess | null = null

  function kill(which: 'system' | 'display'): void {
    const proc = which === 'system' ? systemCaffeinate : displayCaffeinate
    if (!proc) return
    try {
      opts.log?.(`caffeinate ${which} PID ${proc.pid} stopping`)
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
    if (which === 'system') systemCaffeinate = null
    else displayCaffeinate = null
  }

  function killCaffeinate(): void {
    kill('system')
    kill('display')
  }

  function spawnCaffeinate(which: 'system' | 'display'): void {
    if (process.platform !== 'darwin') return
    if ((which === 'system' ? systemCaffeinate : displayCaffeinate) !== null) return
    // -i prevents idle SYSTEM sleep; -d prevents idle DISPLAY sleep.
    const flag = which === 'system' ? '-i' : '-d'
    try {
      // `-w <pid>` makes caffeinate exit when THAT process exits, and it is the only
      // cleanup that survives us not getting to run any code. `process.once('exit')`
      // below covers a graceful quit; it does not fire on SIGKILL, a renderer crash,
      // or a force-quit, and on POSIX a child is not killed by its parent dying
      // (`detached: false` sets the process group, nothing more). Measured on Robert's
      // Mac 2026-08-28: 19 orphaned caffeinate processes, ppid 1, the oldest 6h,
      // every one of them an `-i`/`-d` pair from a PaneForge that had gone away, all
      // still asserting PreventUserIdleDisplaySleep — enough on its own to stop the
      // screen ever sleeping, lid open or shut.
      const proc = spawn('caffeinate', [flag, '-w', String(process.pid)], {
        stdio: 'ignore',
        detached: false
      })
      if (which === 'system') systemCaffeinate = proc
      else displayCaffeinate = proc
      opts.log?.(`caffeinate ${which} started PID ${proc.pid}`)
      proc.on('error', (err) => {
        opts.log?.(`caffeinate ${which} error: ${err.message}`)
        if (which === 'system') systemCaffeinate = null
        else displayCaffeinate = null
      })
      proc.on('exit', (code) => {
        opts.log?.(`caffeinate ${which} exited with code ${code}`)
        if (which === 'system') systemCaffeinate = null
        else displayCaffeinate = null
      })
    } catch (e) {
      opts.log?.(`caffeinate ${which} spawn failed: ${e}`)
    }
  }

  /** Turn the SCREEN hold on or off. Called after every tick, both ways round. */
  function applyDisplay(hold: boolean): void {
    if (hold) {
      if (displayBlockerId === null) {
        displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      }
      spawnCaffeinate('display')
      tickleUserActive()
      return
    }
    if (displayBlockerId !== null && powerSaveBlocker.isStarted(displayBlockerId)) {
      powerSaveBlocker.stop(displayBlockerId)
    }
    displayBlockerId = null
    kill('display')
  }

  function tickleUserActive(): void {
    if (process.platform !== 'darwin') return
    // On macOS in Low Power Mode / low battery, displaysleep is 1 minute (60s).
    // caffeinate -u declares user activity (IOPMAssertionDeclareUserActivity) to prevent
    // low-power screen shutoff while working.
    try {
      execFile('caffeinate', ['-u', '-t', '5'], { timeout: 4000 }, () => {
        opts.log?.('caffeinate user activity tickle sent')
      })
    } catch {
      // ignore
    }
  }

  process.once('exit', killCaffeinate)

  const keeper = new AwakeKeeper({
    panes: opts.panes,
    enabled: opts.enabled,
    // 1. 'prevent-app-suspension' keeps CPU, networking, child processes, and agent turns
    // executing at full speed in the background when the lid is closed. Paired with
    // `caffeinate -i`, this is the hold that runs for the whole time a pane is working.
    // 2. The SCREEN hold ('prevent-display-sleep' + `caffeinate -d` + the `-u` tickle that
    // beats Low Power Mode's 1-minute blank) is applied separately in applyDisplay(), and
    // only while someone is at the desk - see awakeDisplayBusy in shared/awake.ts.
    start: () => {
      appBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      spawnCaffeinate('system')
      return appBlockerId
    },
    stop: () => {
      applyDisplay(false)
      if (appBlockerId !== null && powerSaveBlocker.isStarted(appBlockerId)) {
        powerSaveBlocker.stop(appBlockerId)
        appBlockerId = null
      }
      killCaffeinate()
    },
    now: () => Date.now(),
    screenUnseen,
    log: opts.log
  })
  function run(): void {
    const verdict = keeper.tick()
    if (verdict.hold) spawnCaffeinate('system')
    applyDisplay(verdict.holdDisplay)
  }
  const timer = setInterval(run, AWAKE_TICK_MS)
  timer.unref?.()
  run()
  return {
    keeper,
    tick: run,
    stop: () => {
      clearInterval(timer)
      keeper.release()
      killCaffeinate()
      process.removeListener('exit', killCaffeinate)
    }
  }
}
