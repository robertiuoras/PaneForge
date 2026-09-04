// The sweep that wakes queued/pressure-slept panes when the machine has room, and the
// gate that turns a pane created past capacity into a `queued` sleeper instead of a
// spawned CLI. See `shared/wakePlan.ts` for the arithmetic.
import { logReclaim } from './activationLog'
import { pressureSleepPlan, roomFor, wakePlan, type WakePane } from '../shared/wakePlan'
import type { Pressure } from '../shared/capacity'
import type { SleepPane } from '../shared/sleep'

const SWEEP_MS = 15_000
const WARN_SLEEP_AFTER_MS = 60_000

export interface WakeQueueDeps {
  /** Panes on this desk, live reading. */
  list: () => Array<WakePane & Partial<SleepPane>>
  wake: (id: string) => void
  /**
   * Optional so this stays wireable before the sleep-ledger lane's `sleep(id, reason)`
   * lands in `SessionManager`. Absent = the pressure half of the sweep does nothing; the
   * wake half still runs.
   */
  sleep?: (id: string, reason?: string) => void
  pressure: () => Pressure
}

/**
 * Starts the 15s sweep. Every action - a wake or a sleep - is one line in reclaim.log, the
 * same file `reclaim.ts` writes to, so "why did pane 4 go to sleep" is answered from one
 * place. Stopped on quit; the interval is `ref`'d, so nothing here is what keeps the app
 * alive.
 */
export function startWakeQueue(deps: WakeQueueDeps): { stop(): void } {
  let warnSince: number | undefined
  const timer = setInterval(() => {
    const now = Date.now()
    const pressure = deps.pressure()
    const panes = deps.list()

    if (pressure === 'warn') {
      if (warnSince === undefined) warnSince = now
    } else {
      warnSince = undefined
    }

    const toSleep = pressureSleepPlan(
      panes as (WakePane & SleepPane)[],
      pressure,
      now,
      { warnSince, warnQuietMs: WARN_SLEEP_AFTER_MS }
    )
    if (deps.sleep) {
      for (const id of toSleep) {
        deps.sleep(id, 'pressure')
        logReclaim({ kind: 'sleep', id, reason: 'pressure', pressure })
      }
    }

    const toWake = wakePlan(panes, { pressure }, now)
    for (const id of toWake) {
      deps.wake(id)
      logReclaim({ kind: 'wake', id, pressure })
    }
  }, SWEEP_MS)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    stop() {
      clearInterval(timer)
    }
  }
}

/**
 * Should a NEW pane be born asleep (`queued`) instead of spawning a CLI right now?
 *
 * `queuedCount` and `localPanes` are both read by the caller BEFORE this pane exists, so
 * `roomFor` is asked about the room that is actually free once every already-queued pane's
 * eventual wake is accounted for - otherwise ten queued opens in a row would each see the
 * same "one pane of room" reading and all ten would start live.
 */
export function shouldQueue(
  pressure: Pressure,
  queuedCount: number,
  localPanes: number,
  freeMb: number
): boolean {
  if (pressure !== 'normal') return true
  const room = roomFor(pressure, freeMb)
  return localPanes + queuedCount >= room
}
