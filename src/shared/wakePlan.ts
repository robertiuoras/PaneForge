// Which sleeping panes to wake now that the machine has room, and which to put to sleep
// because it has none - the two halves of "many panes, one machine".
//
// Contract (lane-split 2026-09-04, workstream "wake when there is room"):
//   - a pane asleep for `pressure` or `queued` is a CANDIDATE to wake; `manual`/`idle`
//     never wake on their own.
//   - oldest sleeper first; `queued` panes wake in the order they were created.
//   - never wakes while pressure is `warn`/`critical`; wakes at most `maxPerSweep` per
//     sweep so the reading can settle between.
//   - `pressureSleepPlan` never picks a pane that is busy, asking, running a job, focused,
//     or a mirror - a sleep must not stop development.
// Pure: no Electron. `npm run test:wakeplan`.
import type { SleepReason } from './types'

export interface WakePane {
  id: string
  asleep?: number
  asleepReason?: SleepReason
  createdAt: number
}

export interface WakePlanOpts {
  pressure: 'normal' | 'warn' | 'critical'
  maxPerSweep?: number
}

export function wakePlan(_panes: WakePane[], _opts: WakePlanOpts, _now = 0): string[] {
  return []
}
