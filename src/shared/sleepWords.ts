// What a sleeping pane's chip says, in the reader's own words - never `pressure`/`queued`,
// the internal reason names, on screen. See `shared/sleep.ts` for the plain `asleep 3m` a
// manual or idle sleep already draws; this widens the same clock to say WHY, for the two
// reasons a person did not ask for: the machine ran short of room, or the pane was born
// asleep waiting for a turn to start.
//
// Pure: no Electron. `npm run test:wakeplan`.
import type { SleepReason } from './types'

const MINUTE = 60_000

function mins(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / MINUTE))
}

function clock(word: string, at: number, now: number): string {
  const m = mins(at, now)
  if (m < 1) return word
  if (m < 60) return `${word} ${m}m`
  const h = Math.floor(m / 60)
  return `${word} ${h}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * The chip's own words for a sleeping pane, given why it slept.
 *
 * `manual`/`idle` read as plain `asleep 3m` - somebody chose it, or it has simply been
 * quiet, and either is the ordinary word. `pressure` and `queued` are the two a person did
 * not ask for and would otherwise read as unexplained: the machine took the agent back to
 * make room, or the pane was opened past that room and has never run at all.
 */
export function asleepChip(reason: SleepReason | undefined, at: number, now: number): string {
  if (reason === 'pressure') return clock('resting to free memory', at, now)
  if (reason === 'queued') return clock('waiting for room', at, now)
  return clock('asleep', at, now)
}
