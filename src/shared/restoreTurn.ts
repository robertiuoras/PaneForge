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
