// A check loop that keeps timing out, and says so once an hour to nobody.
//
// updater.log, this Mac, 2026-09-08: `supersede failed the update probe did not answer
// within 120s (online)` at 10:17:18, `net::ERR_TIMED_OUT` at 10:35:38, the same probe
// failure again at 11:11:17, another ERR_TIMED_OUT at 11:12:10. Sixty-six minutes with no
// successful look at the feed, while the app carried on retrying every ten minutes and the
// staged build sat where it was. Each failure was one line, indistinguishable from the
// single transient timeout that happens on a train.
//
// One timeout is weather. Two in a row is the check loop being stuck, and that is a
// different sentence: the app is not going to notice a release, and the person is not
// going to be told why. The arithmetic is here, away from electron, so the threshold can
// be pinned without a feed.

/** How many timeouts in a row before the loop is stuck rather than unlucky. */
export const STUCK_AFTER = 2

/**
 * ...and how long one counts for.
 *
 * Wider than the ten-minute poll, so two consecutive polls both timing out is caught, and
 * narrower than a working day, so a timeout this morning and one tonight are two bad
 * minutes rather than a fault. The 2026-09-08 pair were 54 minutes apart.
 */
export const TIMEOUT_WINDOW_MS = 90 * 60_000

/** Timeouts in the current run, and when the run started. */
export interface ProbeRun {
  timeouts: number
  firstAt: number
}

export function freshRun(): ProbeRun {
  return { timeouts: 0, firstAt: 0 }
}

/**
 * The probe timed out. A timeout outside the window starts a new run rather than adding
 * to a stale one.
 */
export function noteTimeout(r: ProbeRun, now: number): ProbeRun {
  const stale = !r.firstAt || now - r.firstAt > TIMEOUT_WINDOW_MS
  return stale ? { timeouts: 1, firstAt: now } : { timeouts: r.timeouts + 1, firstAt: r.firstAt }
}

/** The feed answered. Whatever it said, the loop is not stuck. */
export function noteAnswer(): ProbeRun {
  return freshRun()
}

export function probeStuck(r: ProbeRun): boolean {
  return r.timeouts >= STUCK_AFTER
}

/**
 * The line to search for when somebody asks why the app is still on an old version.
 *
 * It carries the count and the span, because "the probe timed out" said twice is exactly
 * what was already in the log and is exactly what nobody could act on.
 */
export function stuckWords(r: ProbeRun, now: number): string {
  const mins = Math.max(1, Math.round((now - r.firstAt) / 60_000))
  return `${r.timeouts} update probes in a row timed out over ${mins} min - this machine is not seeing the feed, and a staged build will sit where it is`
}

/** What update-health.json holds that the launch line reads. */
export interface HealthReading {
  lastGood: number
  wedges: number
  lastWedge?: string
  sleeps: number
}

/**
 * The launch line about the update path.
 *
 * A wedge is news until the feed answers again, and history after that. Printed for ever,
 * the same "3 update probes timed out over 51 min ... last 2026-09-18" headed every launch
 * of 2026-09-23 (04:44, 06:46, 14:03), five days after the feed had last failed. So the
 * wedge half is said only while the last wedge is NEWER than the last good answer.
 */
export function healthWords(h: HealthReading, now: number): { stale: boolean; line: string } {
  const slept = h.sleeps ? `, ${h.sleeps} check(s) lost to the machine sleeping` : ''
  if (!h.lastGood) return { stale: false, line: `no good update check on record yet (${h.wedges} wedge(s) recovered${slept})` }
  const hours = Math.round((now - h.lastGood) / 3_600_000)
  // `lastWedge` is "<ISO time> <what>", as `noteWedge` writes it.
  const wedgeAt = h.lastWedge ? Date.parse(h.lastWedge.split(' ')[0]) : NaN
  const open = Number.isFinite(wedgeAt) && wedgeAt > h.lastGood
  const wedge = open ? `, ${h.wedges} wedge(s) recovered, last ${h.lastWedge}` : ''
  // Three days without the feed answering is not a slow week - something is wrong that no
  // single failure reported, and this is the line to search for when it is noticed later.
  return { stale: hours >= 72, line: `last good update check ${hours}h ago${wedge}${slept}` }
}
