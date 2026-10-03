/**
 * A CHAT WHOSE PROGRAM DIED UNDER IT, MID-ANSWER, COMES BACK.
 *
 * `shared/exitClose.ts` closes the card of a pane whose agent ended, on the reasoning that
 * `Open again` in History brings the same chat back. That is right for a chat that
 * FINISHED. It is wrong for one that was in the middle of work when the process was killed
 * from outside (the system's out-of-memory killer, a crash, a stray `kill -9`) while this
 * app carried on running: the card disappears six seconds later, the work stops, and nobody
 * learns it was cut off until they go looking. The restart-the-whole-app case already does
 * better - `restoredClock`/`continueAfterRestore` (`shared/restoreTurn.ts`) reopen the pane
 * on its conversation and tell it to continue. This is the same thing for ONE pane.
 *
 * The first half of the verdict is refusals, and each is "this exit was somebody's doing,
 * or there is nothing to carry on": the app or a person closed the pane, the app is
 * quitting, the pane was put to sleep, it is being moved to the other machine, a newer
 * process already replaced this one, it is not a chat, it has no conversation to reopen on,
 * or it was idle (a finished chat that ended is `exitClose`'s case, not this one).
 *
 * The second half is the one that keeps this from becoming a loop: a CLI that dies the
 * moment it is reopened (a broken install, a transcript it cannot read, a machine out of
 * memory) would otherwise be reopened for ever. A chat is reopened at most twice in 15
 * minutes, and not at all when it died within 30 seconds of the last reopen. Past either
 * limit the verdict says `loop`, and the card closes the way it always did - with the
 * reason in `reclaim.log` so the next person can see it was refused, not missed.
 */

/** What the reopened chat is told. Plain words: it reads them as a message from its person. */
export const REVIVE_PROMPT =
  "This chat's process stopped mid-turn and was reopened. Carry on with what you were doing, from where it stopped."

/** Reopenings are counted over this long. */
export const REVIVE_WINDOW_MS = 15 * 60_000

export interface ReviveReading {
  /** The pane was taken off the desk before its process ended: the app or a person closed it. */
  closedFirst?: boolean
  /** The whole app is going away. */
  quitting?: boolean
  /** The app put this pane to sleep - it killed the process itself. */
  asleep?: boolean
  /** This pane is being moved to the other machine. */
  handingOff?: boolean
  /** A newer process already owns this pane; this exit belongs to the old one. */
  superseded?: boolean
  /** It died while still `starting`, never once idle or working. */
  starting?: boolean
  /** `claude`, `codex`, `shell`... */
  agent: string
  /** The conversation to reopen on, when there is one the CLI will accept. */
  resumeId?: string
  /** It was in the middle of a turn: the same reading the app restart uses. */
  midTurn: boolean
  /** When this pane was last reopened this way, newest last. */
  lastRevives: number[]
  /** When it was last reopened, if the caller knows it; else the newest of `lastRevives`. */
  lastReviveAt?: number
  now: number
  windowMs?: number
  maxPerWindow?: number
  /** A pane that dies sooner than this after being reopened is a loop, not bad luck. */
  minLifeMs?: number
}

export interface ReviveVerdict {
  revive: boolean
  /** One plain line, for `reclaim.log`. */
  why: string
  /** Refused by the crash-loop limit, as opposed to this not being a case for reopening. */
  loop?: true
}

const no = (why: string): ReviveVerdict => ({ revive: false, why })

export function reviveVerdict(p: ReviveReading): ReviveVerdict {
  if (p.superseded) return no('a newer process already replaced this one')
  if (p.closedFirst) return no('the pane was closed before its process ended')
  if (p.quitting) return no('the app is closing')
  if (p.asleep) return no('the pane was put to sleep')
  if (p.handingOff) return no('the pane is being moved to the other machine')
  // A CLI that dies before it is ready is broken, not cut off: `exitClose` keeps its card as
  // the evidence (`failedStart`), and reopening it would only hide that behind a retry.
  if (p.starting) return no('it stopped before it was ready')
  if (p.agent === 'shell') return no('a shell has no conversation to reopen')
  if (!p.resumeId) return no('there is no conversation to reopen it on')
  if (!p.midTurn) return no('it was not mid-turn')

  const windowMs = p.windowMs ?? REVIVE_WINDOW_MS
  const maxPerWindow = p.maxPerWindow ?? 2
  const minLifeMs = p.minLifeMs ?? 30_000
  const last = p.lastReviveAt ?? p.lastRevives[p.lastRevives.length - 1]
  if (last !== undefined && p.now - last < minLifeMs) {
    return { revive: false, loop: true, why: `it died ${Math.round((p.now - last) / 1000)} s after it was last reopened` }
  }
  const recent = p.lastRevives.filter((t) => p.now - t < windowMs).length
  if (recent >= maxPerWindow) {
    return {
      revive: false,
      loop: true,
      why: `already reopened ${recent} times in the last ${Math.round(windowMs / 60_000)} minutes`
    }
  }
  return { revive: true, why: 'its process died mid-turn on its own' }
}
