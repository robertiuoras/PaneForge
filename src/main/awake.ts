// Electron's half of "do not sleep while a pane is working". Every judgement is in
// shared/awake.ts; this file is the power API and the clock.
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

  const keeper = new AwakeKeeper({
    panes: opts.panes,
    enabled: opts.enabled,
    // 1. 'prevent-display-sleep' keeps the screen illuminated while the laptop is open,
    // protecting against macOS 1-minute low-power screen shutoffs while watching or working.
    // 2. 'prevent-app-suspension' keeps CPU, networking, child processes, and agent turns
    // executing at full speed in the background when the lid is closed.
    start: () => {
      displayBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      appBlockerId = powerSaveBlocker.start('prevent-app-suspension')
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
    },
    now: () => Date.now(),
    log: opts.log
  })
  const timer = setInterval(() => keeper.tick(), AWAKE_TICK_MS)
  timer.unref?.()
  keeper.tick()
  return {
    keeper,
    tick: () => void keeper.tick(),
    stop: () => {
      clearInterval(timer)
      keeper.release()
    }
  }
}
