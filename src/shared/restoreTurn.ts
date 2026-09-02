// What a reopened pane inherits from the one it is replacing.
//
// A restored pane is a NEW session: `sessions.ts` gives it a fresh id, a fresh pty and a
// fresh `createdAt`. That is right for everything the process knows about itself and wrong
// for everything the PERSON knows about the pane, and until now the desk carried none of
// the second kind. Measured on this desk 2026-08-21, straight after the app installed an
// update and reopened nine panes: every restored row reported `engaged: false`,
// `runSince: null` and `lastRunMs: undefined`, which the sidebar draws as
//
//   - no clock at all, because the row renders `runSince`, then `lastRunMs`, then nothing;
//   - the GREY `.dot.idle.ready` ("ready - type to start") instead of the green
//     `.dot.idle` ("waiting for you"), because `engaged` is what tells those apart.
//
// Both readings are false about a pane that is mid-conversation, and they are the whole of
// "after the restart it doesn't show any running time or the green dot".
//
// The clock the person means is also not `createdAt`. `createdAt` is the age of THIS
// process and three timers read it that way (the starting->idle flip, the attention rule,
// the stall rule), so back-dating it would make a pane that is genuinely still booting
// report as idle. `openedAt` is the separate fact - when this pane first appeared on the
// desk - and only the display reads it.

/** The fields a restored pane inherits. Written by `snapshot()`, read by `start()`. */
export interface RestoredClock {
  /** When the pane FIRST opened, across every restart since. */
  openedAt?: number
  /** How long its last finished turn took, so the row still has a number to show. */
  lastRunMs?: number
  /** Whether it had been asked something - the green dot against the grey one. */
  engaged?: boolean
  /** It was mid-turn when the app went down. */
  wasWorking?: boolean
}

/**
 * The clock a restored pane starts with.
 *
 * `openedAt` falls back to now, so a pane opened fresh (no desk entry) is not special-cased
 * anywhere else. `engaged` is true when it was engaged before OR a prompt is being typed
 * into it now - the launch-prompt rule `start()` already had.
 */
export function restoredClock(
  req: RestoredClock & { prompt?: string },
  now: number
): { openedAt: number; lastRunMs: number | undefined; engaged: boolean } {
  return {
    openedAt: req.openedAt ?? now,
    lastRunMs: req.lastRunMs,
    engaged: Boolean(req.prompt) || req.wasWorking === true || req.engaged === true
  }
}

/**
 * Whether the app should finish the turn the restart cut in half.
 *
 * `--resume` brings the CONVERSATION back and not the answer that was being written, so a
 * pane the app killed mid-turn comes back at an empty composer, idle and green, looking
 * exactly like a pane that finished. That is the same shape `shared/recover.ts` exists for
 * - a turn the transport cut in half - and it gets the same answer and the same switch:
 * with "finish a turn that was cut off" off, the app types nothing for you, here either.
 *
 * The refusals:
 *   - a pane that was NOT mid-turn has nothing to continue, and typing at it would start a
 *     turn nobody asked for;
 *   - a pane launched WITH a prompt is already being given its work, and two things queued
 *     into one composer is one of them landing inside the other;
 *   - a mirrored pane belongs to the other machine, which is restoring it itself.
 */
export function continueAfterRestore(
  req: RestoredClock & { prompt?: string },
  recoverEnabled: boolean
): boolean {
  if (!recoverEnabled) return false
  if (req.prompt) return false
  return req.wasWorking === true
}

/**
 * Which restored panes come back with their agent already running.
 *
 * Restoring is the one moment the app starts N agent CLIs in a single tick, and measured
 * on this desk 2026-08-28 (`npm run boot-timing --panes 8`) that is the whole of the lag:
 * every pane was back on screen with its old output in 1.3-2.6s, while a composer you can
 * type into took 4.1-14.3s, and the app's own main process spent under 0.5s of CPU in the
 * first 30s. One `claude` alone reaches a composer in 1.4s; seven at once take 4-15s.
 * Staggering the starts was measured and was WORSE (last composer at 26-29s), so the
 * answer is not to start them further apart - it is to not start them.
 *
 * A pane that comes back ASLEEP is the same card in the same place wearing the same
 * screen, with no process behind it: `shared/sleep.ts` already had every part of that,
 * and a press wakes it in the conversation it was in. So the rule is narrow and the
 * refusals are the feature - a pane is woken on arrival only when leaving it asleep would
 * lose something or hide work that is already meant to be running:
 *
 *   - the FIRST pane, which is the one being looked at;
 *   - a pane launched with a prompt, which was opened to do that work;
 *   - a pane the restart caught mid-turn, which `continueAfterRestore` is about to finish.
 */
export function restoreAsleep(
  req: RestoredClock & { prompt?: string },
  index: number,
  recoverEnabled: boolean
): boolean {
  if (index === 0) return false
  if (req.prompt) return false
  if (continueAfterRestore(req, recoverEnabled)) return false
  return true
}

/**
 * Whether an EMPTY desk may not be written yet.
 *
 * While the restore offer is up and unanswered, the app has no panes and that is not
 * news: writing `[]` would delete the panes still being offered. But the offer can stay
 * up for ever on a desk nobody sits at - the PC's stood from a 23:13 relaunch, a pane was
 * opened over it by `pf open` and closed two hours later, and the empty desk that close
 * left was never written, so desk.json still listed the closed pane (2026-09-03). Once a
 * pane has been open since the offer went up, the desk is in use and empty is the truth.
 */
export function emptyDeskStands(offerPending: boolean, usedSinceOffer: boolean): boolean {
  return offerPending && !usedSinceOffer
}
