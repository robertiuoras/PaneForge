// An update probe that timed out, and then waited a full cycle to try again.
//
// 2026-09-08, this Mac: `supersede failed the update probe did not answer within 120s
// (online)` at 10:17:18, then `net::ERR_TIMED_OUT` at 10:35:38, the same pair again at
// 11:11:17 and 11:12:10, and the next successful check at 11:21:17. Sixty-six minutes
// with no answer from the feed, over a transient network stall that would have cleared in
// seconds - because a failed probe re-arms at exactly the same cadence as a successful
// one, so there is no such thing as trying again sooner.
//
// The other half is that nothing said so. Two timeouts an hour apart are two ordinary log
// lines; a machine that has not reached the feed in an hour is a different fact, and it is
// the one worth searching for later.
//
// The arithmetic is here, away from electron-updater, because the failure it answers only
// ever happens against a real network. `npm run test:updateretry`.

/** The first retry after a failed probe. Short, because most of these clear at once. */
export const PROBE_RETRY_MS = 60_000

/**
 * The longest a backoff may grow to.
 *
 * It is a ceiling on the BACKOFF, not on the poll: the caller takes whichever of this and
 * its ordinary cadence is sooner, so a machine that has been offline for an hour is asking
 * no more often than a healthy one, and never less often.
 */
export const PROBE_RETRY_MAX_MS = 8 * 60_000

/** Consecutive failures that stop being weather and start being a fact worth logging. */
export const PROBE_ALERT_AFTER = 3

/**
 * How long to wait before asking the feed again, after `fails` failures in a row.
 *
 * Doubling from a minute: 1m, 2m, 4m, then 8m for ever. A stalled network is retried in
 * a minute instead of at the next full cycle, and a feed that is genuinely down is not
 * hammered for the rest of the day.
 */
export function probeRetryMs(fails: number): number {
  if (fails <= 0) return 0
  return Math.min(PROBE_RETRY_MS * 2 ** (fails - 1), PROBE_RETRY_MAX_MS)
}

/**
 * When to write the line that says this is no longer one bad request.
 *
 * Only ON the threshold, not past it: the point is one searchable line per stall, not a
 * line every minute for as long as the wifi is out.
 */
export function probeStalled(fails: number): boolean {
  return fails === PROBE_ALERT_AFTER
}
