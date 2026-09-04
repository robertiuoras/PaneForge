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
import { canSleep, type SleepPane } from './sleep'
import { SESSION_MB } from './capacity'
import type { Pressure } from './capacity'
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

const DEFAULT_MAX_PER_SWEEP = 2

/** Reasons a sweep may wake on its own. A person's own choice never gets undone by it. */
const AUTO_WAKEABLE: ReadonlySet<SleepReason> = new Set(['pressure', 'queued'])

/**
 * Which asleep panes the sweep should wake now, oldest sleeper first, `queued` panes in
 * the order they were created.
 *
 * Never while the machine is still `warn`/`critical` - waking a pane is exactly the action
 * that put it to sleep in the first place, and doing it while the reading still says the
 * machine is short of room would flap. Capped at `maxPerSweep` so each wake gets a chance
 * to be reflected in the next reading before another one fires.
 */
export function wakePlan(panes: WakePane[], opts: WakePlanOpts, now = 0): string[] {
  if (opts.pressure !== 'normal') return []
  const max = opts.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP
  if (!(max > 0)) return []

  const candidates = panes
    .filter((p) => p.asleep !== undefined && p.asleepReason && AUTO_WAKEABLE.has(p.asleepReason))
    .sort((a, b) => {
      // `queued` panes never ran at all, so their `asleep` stamp (if any) says nothing
      // about rest - creation order is the only fair queue for them. A `pressure` sleeper
      // has an `asleep` moment that means "how long has it rested", which is the ordering
      // that matters for it.
      const at = (p: WakePane): number =>
        p.asleepReason === 'queued' ? p.createdAt : (p.asleep ?? p.createdAt)
      return at(a) - at(b)
    })

  return candidates.slice(0, max).map((p) => p.id)
}

/**
 * Which running panes to put to sleep because the machine has no room, oldest-quiet-ish
 * candidate first (the caller already filtered to panes that are actually idle - this
 * takes them in the order given).
 *
 * Reuses `canSleep` verbatim: nothing here may pick a pane that is busy, asking, running a
 * job, backgrounding one, or a mirror of another device's pty - a pane must not lose
 * in-flight work because the machine got tight. `critical` sleeps up to `maxPerSweep`;
 * `warn` sleeps nothing until it has HELD for `warnQuietMs`, so a reading that flaps at the
 * threshold does not put a pane to sleep on its way past `ok`.
 */
export function pressureSleepPlan(
  panes: (WakePane & SleepPane)[],
  pressure: Pressure,
  now = 0,
  opts: { maxPerSweep?: number; warnSince?: number; warnQuietMs?: number } = {}
): string[] {
  if (pressure === 'normal') return []
  const max = opts.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP
  if (!(max > 0)) return []
  if (pressure === 'warn') {
    const quietMs = opts.warnQuietMs ?? 0
    const since = opts.warnSince
    if (since === undefined || now - since < quietMs) return []
  }

  const eligible = panes
    .filter((p) => canSleep(p))
    .sort((a, b) => a.createdAt - b.createdAt)

  return eligible.slice(0, max).map((p) => p.id)
}

/**
 * How many QUEUED panes may start right now, given free memory and the current pressure.
 *
 * Zero under `warn`/`critical`: a machine already short of room is not the moment to spend
 * more of it on a queued pane, whatever `freeMb` says - the pressure reading is the live
 * one and it outranks a static number. Under `normal`, `freeMb` divided by one session's
 * cost, so a wake never starts a pane it cannot actually afford.
 */
export function roomFor(pressure: Pressure, freeMb: number): number {
  if (pressure !== 'normal') return 0
  return Math.max(0, Math.floor(freeMb / SESSION_MB))
}
