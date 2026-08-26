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
  const keeper = new AwakeKeeper({
    panes: opts.panes,
    enabled: opts.enabled,
    // 'prevent-app-suspension' allows the screen/display to turn off when the lid is closed,
    // while keeping the CPU, network, shells, and agent processes running in the background.
    // When all work finishes, the hold is released so the machine can sleep naturally.
    start: () => powerSaveBlocker.start('prevent-app-suspension'),
    stop: (id) => {
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
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
