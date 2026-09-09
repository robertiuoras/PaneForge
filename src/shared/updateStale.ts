// A staged build nobody ever installs.
//
// 2026-09-02 log review, this Mac: 01:34:47 staged 0.8.186 ready, 03:04:39 superseded by
// 0.8.187 and staged ready, 03:24:45 superseded by 0.8.188 and staged ready. The last
// install attempt of any version was 12:40:06 the day before. So the app downloaded three
// builds in two hours, threw two of them away unused, and went on running 0.8.185 - and
// every surface read as healthy, because "ready" is what a working update path looks like.
//
// The card is not the problem: it appears for each new version and offers the restart.
// What was missing is what happens when nobody presses it. A restart nobody asked for is
// already written (`autoInstall` in main/index.ts) and already refuses to take anyone's
// panes away, but nothing but a failed install had ever started it.
//
// So: count how many staged builds have been thrown away since the last install attempt,
// and past the threshold hand that count to the restart-when-idle path. The rule is here,
// on its own, because it decides something destructive-looking and must be testable
// without an updater, a feed, or a Mac.

/**
 * How many staged builds may be superseded before the app stops waiting to be asked.
 *
 * Two, not one: one supersede is the ordinary case of a release going out while the card
 * is on screen, and reacting to that would make every busy afternoon a restart. Two is a
 * build the user has now ignored across two separate versions.
 */
export const STALE_SUPERSEDES = 2

/**
 * Has the update path given up on being noticed?
 *
 * `superseded` counts staged builds replaced by a newer one with no install attempt in
 * between; it is reset the moment an install is attempted, so a user who does press
 * Restart never reaches this.
 */
export function updateIgnored(superseded: number): boolean {
  return superseded >= STALE_SUPERSEDES
}

/**
 * What the card says instead of the ordinary "it installs silently" line.
 *
 * Plain words: nobody reading this card knows what "superseded" or "staged" means, and
 * the only thing they need to know is that the app is about to restart on its own and
 * when. See "Every word on screen is read by somebody who has never used git".
 */
export function ignoredHint(current: string): string {
  return `You are still on ${current}, and newer builds keep being downloaded and thrown away unused. PaneForge will restart into this one by itself once no pane has been used for 10 minutes.`
}

// --- a build that has sat ready ---------------------------------------------------
//
// 2026-09-03, the PC: 0.8.196 was ready at 17:08 and the app went on running 0.8.177 -
// nineteen releases behind the Mac it was linked to - until somebody pressed Restart over
// ssh at 19:38. The first version of this rule only took a ready build on a window nobody
// had focused for half an hour, to leave an attended desk alone. That distinction turned
// out not to matter: `autoInstall` already refuses to touch a desk with a pane in use
// (`deskBusy` in main/index.ts, unchanged) and the game hold on top of it, so a person at
// the keyboard is protected either way. Robert, 2026-09-03: "if we release we should
// probably auto update both pc and mac right?" - so the focus check was dropped and every
// desk, attended or not, takes a build once it has sat ready this long.

/**
 * How long a build stays ready before it is taken, on any desk. Releases here go out in
 * bursts (a fix follows its release by minutes); five minutes lets the fix supersede the
 * build rather than restarting into the one it fixes.
 */
export const READY_HOLD_MS = 5 * 60_000

// --- a check that stopped answering -----------------------------------------------
//
// 2026-09-09 log review, this Mac: `supersede failed the update probe did not answer
// within 120s (online)` at 10:17:18, `net::ERR_TIMED_OUT` at 10:35:38, the same pair
// again at 11:11:17 and 11:12:10, and no successful check until 11:21 - sixty-six minutes
// in which the app had no idea whether a newer build existed. Each failure was reported
// once and then waited out the full ten-minute poll, so a network stall that cleared in
// thirty seconds still cost ten minutes, twice. And nothing anywhere said the update path
// had stopped answering: every surface reads "up to date" when the last check failed.

/** How soon to look again after the first failed check. Doubles per consecutive failure. */
export const PROBE_RETRY_MS = 30_000

/**
 * Consecutive failures before the app stops calling it weather.
 *
 * Two, not one: one timed-out check is a laptop waking on a train, and reacting to that
 * would put a warning on screen most mornings. Two in a row is the shape above.
 */
export const STALL_FAILS = 2

/**
 * How long until the next look, given how many checks in a row have failed.
 *
 * Backoff rather than a fixed short retry: a machine genuinely offline for an afternoon
 * must not ask every thirty seconds for four hours. Capped at the ordinary poll, so this
 * can only ever make the app look SOONER than it otherwise would - never later.
 */
export function probeBackoffMs(fails: number, idleMs: number): number {
  if (fails <= 0) return idleMs
  return Math.min(PROBE_RETRY_MS * 2 ** (fails - 1), idleMs)
}

/** Has the update path stopped answering? */
export function updateStalled(fails: number): boolean {
  return fails >= STALL_FAILS
}

/**
 * What the person is told while it is stalled.
 *
 * Plain words: "probe", "feed" and "supersede" are this file's vocabulary and nobody
 * else's. The only thing worth saying is that the app cannot currently tell whether it is
 * up to date, and that it has not given up.
 */
export function stalledHint(): string {
  return 'PaneForge cannot reach the place it gets its updates from, so it does not know whether a newer version exists. It is still trying.'
}
