// Electron's half of "do not sleep while a pane is working". Every judgement is in
// shared/awake.ts; this file is the power API and the clock.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { powerSaveBlocker } from 'electron'
import { AwakeKeeper, type AwakePane } from '../shared/awake'

/** How often the desk is re-read. A pane going quiet is not worth a faster clock. */
export const AWAKE_TICK_MS = 30_000

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
      const proc = spawn('caffeinate', [flag], { stdio: 'ignore', detached: false })
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
