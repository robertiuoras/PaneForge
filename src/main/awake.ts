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
    // 'prevent-display-sleep' also prevents system sleep, which is what a long agent turn
    // needs: the lid staying open with a black screen still suspends the machine.
    start: () => powerSaveBlocker.start('prevent-display-sleep'),
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
