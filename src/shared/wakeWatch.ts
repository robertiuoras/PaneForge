// Was this process running, or was the machine asleep?
//
// Every "wedge" the updater recovered on this Mac between 2026-09-15 and 09-17 - 154 of
// them - was the same event, and none of them was a hung socket. `pmset -g log` on the
// 17th: DarkWake at 11:13:12 (the `state checking` line, to the second), back to sleep
// two seconds later, next DarkWake at 11:30:25 (the `wedged checking never finished after
// 1033s` line, to the second). macOS wakes the machine for two seconds every 15-17
// minutes to service TCP keepalives; the background poll's timer is due by then, so it
// fires, starts a check, and the socket dies with the sleep. Every timer set during that
// wake fires at the next one, so a 2-minute budget reads as 1033s "held", the health file
// counts a wedge, and electron-updater's own timeout lands a few ms later as
// `net::ERR_TIMED_OUT` - four log lines and a red badge for a laptop with its lid shut.
//
// No clock tells sleep from a hang: the wall clock and the monotonic one both jump. What
// does is whether THIS PROCESS was running - a heartbeat that ticks every few seconds
// cannot skip half a minute unless nothing was running it. So the watch records the last
// tick, and a gap past `SLEEP_GAP_MS` is a wake: `sleptSince(t)` says a phase that began
// at `t` was interrupted by one, and `justWoke` says the machine is inside the first
// seconds of one, which on a dark wake is all there is.
//
// Order-independent: the timer that asks calls `tick()` first, so it does not matter
// whether it or the heartbeat fires first on the way back.

/** Heartbeat cadence. Every few seconds, so a dark wake of two seconds is still seen. */
export const TICK_MS = 5_000

/** A heartbeat gap this long means the process was not running: the machine slept. */
export const SLEEP_GAP_MS = 30_000

/** Under test the budgets are milliseconds, so the gap and the settle shrink with them. */
function tuned(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return v > 0 ? v : fallback
}

/**
 * A check started inside a dark wake dies with it. The wake lasts about two seconds, so
 * anything a real wake needs settles well within this, and a dark wake is over before it.
 */
export const WAKE_SETTLE_MS = tuned('PF_WAKE_SETTLE_MS', 20_000)

/**
 * After a flurry of wakes that went straight back to sleep (11 of them before the
 * 2026-09-30 21:36 check, which then died with the 21:50 sleep), a single 20s stretch of
 * being awake may only be the next dark wake. So the second and later deferrals wait three
 * times as long before a check is allowed.
 */
export const BURST_SETTLE_MS = WAKE_SETTLE_MS * 3

/** One poll is deferred this many times at most, so a missed signal cannot end polling. */
export const MAX_POLL_DEFERS = 8

/** How long the machine must have been awake before a poll that was deferred `deferred` times runs. */
export function pollSettle(deferred: number): number {
  return deferred > 0 ? BURST_SETTLE_MS : WAKE_SETTLE_MS
}

/** Should a poll wait? Pure: awake time so far, and how many times it already waited. */
export function deferPoll(awakeMs: number, deferred: number): boolean {
  return deferred < MAX_POLL_DEFERS && awakeMs < pollSettle(deferred)
}

const GAP_MS = tuned('PF_SLEEP_GAP_MS', SLEEP_GAP_MS)

export class WakeWatch {
  private lastTick: number
  private wokeAt = 0
  private sleptForMs = 0

  constructor(now: number) {
    this.lastTick = now
  }

  /** Record a heartbeat. True when the gap since the last one says the machine slept. */
  tick(now: number): boolean {
    const gap = now - this.lastTick
    this.lastTick = now
    if (gap <= GAP_MS) return false
    this.wokeAt = now
    this.sleptForMs = gap
    return true
  }

  /** How long the machine slept during a phase that began at `since`; 0 if it did not. */
  sleptSince(since: number): number {
    return this.wokeAt > since ? this.sleptForMs : 0
  }

  /** How long since the last sleep-sized gap ended; Infinity when none was ever seen. */
  awakeFor(now: number): number {
    return this.wokeAt > 0 ? now - this.wokeAt : Infinity
  }

  /** Inside the first `withinMs` of a wake - a check started now would die with a dark one. */
  justWoke(now: number, withinMs = WAKE_SETTLE_MS): boolean {
    return this.wokeAt > 0 && now - this.wokeAt < withinMs
  }
}
