// A pane that has finished closes itself into the Review list.
//
// Robert, 2026-09-23: "i dont really want to see any sessions that many open its too
// cluttered ... sessions with not important things can just be closed ... only things
// where u think i would want to continue with can stay open". The desk kept every pane
// until a person or a memory sweep took it, so a morning's work was thirty cards, most of
// them finished. Now a pane whose turn is over, that asked nothing, drafted nothing, left
// nothing running - no shell job, no background job, NO SUBAGENT - and whose reply's
// `## Next steps` is `None` or only things a person must do, closes itself. Its reply is
// kept as a Review row and Reopen is `--resume`, so nothing is lost but the card.
//
// The refusals are the whole file, and each one is something that would be LOST rather
// than finished. `doneEnough` (`shared/closeWhenDone.ts`) supplies the pane-state half; the
// half that is new here is READING THE REPLY - a step an agent could take next keeps the
// pane open, a question keeps it open, a person reading it keeps it open.
//
// Pure. `main/doneClose.ts` reads the transcript and closes; `npm run test:doneclose`.

import { doneEnough, type DonePane } from './closeWhenDone'
import { actionableNextSteps, personOwnedSteps } from './handoffSteps'

/** What deciding needs to know, on top of what `closeWhenDone` already reads. */
export interface DoneReading extends DonePane {
  agent: string
  /** A person is looking at this pane right now. */
  focused?: boolean
  lastKeyboard: number
  /** When the pane's own footer last said the turn was over; 0 = mid-turn or never ran. */
  turnEndedAt: number
  /** The reply as the CLI's transcript has it, or undefined when it could not be read. */
  reply?: string
  /** Subagents launched in the background and not yet reported back. */
  runningAgents?: number
  /**
   * This pane opened other panes (`pf open` from inside it). It is where their one
   * summary lands (`shared/finishedDigest.ts`), so it stays open - Robert, 2026-09-23:
   * "get summary in 1 session and leave it open".
   */
  openedOthers?: boolean
  /**
   * Everything it left running in the background is only WAITING on something elsewhere
   * - a CI run, a merge, a queued job (`shared/paneBackJobs.ts` `isWaitScript`). That
   * holds nothing the CI run or the branch does not also hold, so it does not keep a
   * finished pane open (Robert, 2026-09-24: "they should just get closed").
   */
  backWaitOnly?: boolean
}

/**
 * How long a finished reply must sit unread before its pane goes. Long enough to walk
 * back from the kettle; the pane a person is IN never counts, and a card in Review is
 * one press from being a pane again.
 */
export const AUTO_CLOSE_QUIET_MS = 3 * 60_000

/**
 * Is a person looking at this pane? The window's selected pane alone is not that: there
 * is always one, so on a desk of four panes the one last typed into was "looked at" for
 * ever and never closed (PC, 2026-09-24: a finished pane sat 14 minutes with its window
 * behind another app). Selected, in a window that has the keyboard, at a desk somebody
 * is at (`deskWatched`: present per `away.ts`, window shown and not minimised).
 */
export function personLooking(selected: boolean, windowFocused: boolean, deskWatched: boolean): boolean {
  return selected && windowFocused && deskWatched
}

export type DoneVerdict =
  | { close: true; personSteps: string[] }
  | { close: false; reason: string }

/** May this pane close itself into Review now? */
export function doneVerdict(reading: DoneReading, now = Date.now()): DoneVerdict {
  const p = reading.backWaitOnly ? { ...reading, backJob: undefined } : reading
  if (p.agent === 'shell') return { close: false, reason: 'shell pane' }
  if (!p.turnEndedAt) return { close: false, reason: 'no finished turn' }
  if (p.focused) return { close: false, reason: 'somebody is looking at it' }
  if (p.openedOthers) return { close: false, reason: 'it opened other panes and collects their summary' }
  const quiet = now - Math.max(p.turnEndedAt, p.lastKeyboard)
  if (quiet < AUTO_CLOSE_QUIET_MS) return { close: false, reason: 'not quiet long enough' }
  if (!doneEnough(p, quiet, now)) return { close: false, reason: 'busy, asking, drafting or running something' }
  if (p.reply === undefined) return { close: false, reason: 'reply not read' }
  if (p.runningAgents) return { close: false, reason: `${p.runningAgents} subagent${p.runningAgents === 1 ? '' : 's'} still running` }
  if (/\?\s*$/.test(p.reply.trim())) return { close: false, reason: 'the reply ends in a question' }
  const open = actionableNextSteps(p.reply)
  if (open.length) return { close: false, reason: `${open.length} step${open.length === 1 ? '' : 's'} an agent could take` }
  return { close: true, personSteps: personOwnedSteps(p.reply) }
}

/** One id per finished turn, so a retry of the same close is idempotent. */
export function doneReviewId(paneId: string, turnEndedAt: number): string {
  return `done_${String(paneId).replace(/[^A-Za-z0-9_-]/g, '_')}_${Math.floor(turnEndedAt / 1000)}`
}
