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

// --- and what does NOT happen when nobody presses it ------------------------------
//
// There is no automatic restart. A rule that took a build once it had sat ready five
// minutes (READY_HOLD_MS) and a card that said "PaneForge will restart into this one by
// itself" (ignoredHint) were both written on 2026-09-03 and both removed here on
// 2026-09-09: neither was ever wired into `src/main`, and `npm run test:updatehold`
// refuses to let one back in ("no timer, stale-build listener, or failed-install retry
// can start an update"). Robert, 2026-09-04: no restart the user did not ask for.
//
// So the honest reading of the 2026-09-08 log is that the update path worked: 0.8.207 was
// staged at 02:28:31, superseded by 0.8.208 at 01:43 the next morning, and installed at
// the 02:30:34 launch - 23 hours, because a staged build installs on Restart now or an
// ordinary quit and on nothing else. `updateIgnored()` still decides the FLAG, which is a
// reading for the badge; it starts nothing.
