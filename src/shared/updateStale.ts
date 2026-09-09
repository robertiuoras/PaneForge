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

// --- a build that has been ready for hours, with nobody told ------------------------
//
// 2026-09-09: 0.8.208 reached `state ready` at 01:43:58 and was still ready through the
// restart log at 02:30:35 the next day; 0.8.207 before it sat staged from 02:28:31 on
// 09-08 until the app was relaunched by hand nearly 24 hours later. Nothing was wrong -
// this app installs a staged build only when somebody presses Restart now or quits it,
// deliberately, so that no timer may ever tear down a working desk. But the waiting was
// invisible: the card says the same sentence on hour one and on hour twenty-four, and the
// log says nothing at all between the two.
//
// So the wait is made visible rather than shortened. Nothing here installs anything.

/** How long a ready build waits before the app starts saying how long it has waited. */
export const STAGED_NAG_MS = 6 * 60 * 60 * 1000

/** Has this build been sitting installable long enough to be worth mentioning? */
export function stagedTooLong(readyAt: number | undefined, now: number): boolean {
  return !!readyAt && now - readyAt >= STAGED_NAG_MS
}

/** Whole hours, for a sentence. Never "0 hours": the caller only asks past the threshold. */
export function stagedHours(readyAt: number, now: number): number {
  return Math.max(1, Math.floor((now - readyAt) / 3_600_000))
}

/**
 * What the card says once a build has been waiting.
 *
 * It says what the app is doing and what ends it, in the words of the buttons underneath
 * it - a person who has never used git has no idea what "staged" means and no reason to
 * learn. See "Every word on screen is read by somebody who has never used git".
 */
export function stagedWaitingWords(current: string, version: string, hours: number): string {
  return `PaneForge ${version} has been ready for ${hours} ${hours === 1 ? 'hour' : 'hours'} and you are still on ${current}. It installs when you choose Restart now, or the next time you quit PaneForge - never on its own while you are working.`
}
