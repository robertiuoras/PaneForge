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
  let caffeinateProc: ChildProcess | null = null

  function killCaffeinate(): void {
    if (caffeinateProc) {
      try {
        caffeinateProc.kill('SIGTERM')
      } catch {
        // ignore
      }
      caffeinateProc = null
    }
  }

  function spawnCaffeinate(): void {
    if (process.platform !== 'darwin' || caffeinateProc) return
    try {
      // caffeinate -d prevents display sleep (PreventUserIdleDisplaySleep)
      // caffeinate -i prevents idle system sleep (PreventUserIdleSystemSleep)
      caffeinateProc = spawn('caffeinate', ['-d', '-i'], {
        stdio: 'ignore',
        detached: false
      })
      caffeinateProc.on('error', (err) => {
        opts.log?.(`caffeinate error: ${err.message}`)
        caffeinateProc = null
      })
      caffeinateProc.on('exit', () => {
        caffeinateProc = null
      })
    } catch (e) {
      opts.log?.(`caffeinate spawn failed: ${e}`)
    }
  }

  function tickleUserActive(): void {
    if (process.platform !== 'darwin') return
    // On macOS in Low Power Mode / low battery, displaysleep is 1 minute (60s).
    // caffeinate -u declares user activity (IOPMAssertionDeclareUserActivity) to prevent
    // low-power screen shutoff while working.
    try {
      execFile('caffeinate', ['-u', '-t', '5'], { timeout: 4000 }, () => {})
    } catch {
      // ignore
    }
  }

  process.once('exit', killCaffeinate)

  const keeper = new AwakeKeeper({
    panes: opts.panes,
    enabled: opts.enabled,
    // 1. 'prevent-display-sleep' keeps the screen illuminated while the laptop is open,
    // protecting against macOS 1-minute low-power screen shutoffs while watching or working.
    // 2. 'prevent-app-suspension' keeps CPU, networking, child processes, and agent turns
    // executing at full speed in the background when the lid is closed.
    // 3. On macOS, caffeinate holds PreventUserIdleDisplaySleep directly, and caffeinate -u
    // tickles the user activity timer so Low Power Mode does not blank the screen after 1 min.
    start: () => {
      displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      appBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      spawnCaffeinate()
      tickleUserActive()
      return displayBlockerId
    },
    stop: () => {
      if (displayBlockerId !== null && powerSaveBlocker.isStarted(displayBlockerId)) {
        powerSaveBlocker.stop(displayBlockerId)
        displayBlockerId = null
      }
      if (appBlockerId !== null && powerSaveBlocker.isStarted(appBlockerId)) {
        powerSaveBlocker.stop(appBlockerId)
        appBlockerId = null
      }
      killCaffeinate()
    },
    now: () => Date.now(),
    log: opts.log
  })
  const timer = setInterval(() => {
    const verdict = keeper.tick()
    if (verdict.hold) {
      spawnCaffeinate()
      tickleUserActive()
    }
  }, AWAKE_TICK_MS)
  timer.unref?.()
  keeper.tick()
  return {
    keeper,
    tick: () => {
      const verdict = keeper.tick()
      if (verdict.hold) {
        spawnCaffeinate()
        tickleUserActive()
      }
    },
    stop: () => {
      clearInterval(timer)
      keeper.release()
      killCaffeinate()
      process.removeListener('exit', killCaffeinate)
    }
  }
}
