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
  return `You are still on ${current}, and newer builds keep being downloaded and thrown away unused. PaneForge will restart into this one by itself as soon as no pane is in use.`
}

// --- a desk nobody sits at -----------------------------------------------------
//
// 2026-09-03, the PC: 0.8.196 was downloaded and ready at 17:08 and the app went on
// running 0.8.177 - nineteen releases behind the Mac it was linked to - until somebody
// pressed Restart over ssh at 19:38. The supersede rule above never fired because the PC
// was running a build older than the rule. Nothing else fires either: the card asks a
// person, and that desk has no person. Every remote feature (handoff, mirror, restart
// over the link, the autoclear hook that ships with the newer app) then runs between two
// builds that disagree, and the failure reads as "remote sessions broke".
//
// The rule that makes two desks converge on one version: a desk nobody has focused for
// half an hour treats a ready build as accepted, and restarts into it once no pane is in
// use (the `deskBusy` hold in main/index.ts, unchanged). A desk with a person at it keeps
// the card and the supersede rule; this only covers the desk with nobody to ask.

/** How long a window must go unfocused before the desk counts as nobody's. */
export const UNATTENDED_MS = 30 * 60_000
/**
 * How long a build stays ready before an unattended desk takes it. Releases here go out
 * in bursts (a fix follows its release by minutes); five minutes lets the fix supersede
 * the build rather than restarting into the one it fixes.
 */
export const UNATTENDED_READY_MS = 5 * 60_000

/**
 * Should a desk with nobody at it restart into the build it has ready?
 *
 * `focused` wins outright: a person is looking at the window right now. `lastFocusAt`
 * is 0 until the first focus, so a desk never focused since launch is measured from
 * `launchedAt` - a freshly (re)started app is not proof of absence.
 */
export function unattendedInstall(opts: {
  now: number
  readyAt: number
  focused: boolean
  lastFocusAt: number
  launchedAt: number
}): boolean {
  if (opts.focused) return false
  if (!opts.readyAt || opts.now - opts.readyAt < UNATTENDED_READY_MS) return false
  const lastSeen = Math.max(opts.lastFocusAt, opts.launchedAt)
  return opts.now - lastSeen >= UNATTENDED_MS
}
