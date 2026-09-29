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
   * A pane this one opened (`pf open` from inside it) is still open, or their one summary
   * (`shared/finishedDigest.ts`) has not been handed to it yet. It is where that summary
   * lands, so it stays open until then - Robert, 2026-09-23: "get summary in 1 session and
   * leave it open". Only until then: kept for life, it held 8 finished panes on 27 Sep.
   */
  openedOthers?: boolean
  /**
   * This app is still delivering a prompt to it (`Session.owedPrompt`, or an autoclear
   * hand-over): the opener's summary between the digest's flush and its landing, a
   * `pf tell`, a restore. The reply read now is the one BEFORE that prompt.
   */
  owedPrompt?: boolean
  /**
   * Everything it left running in the background is only WAITING on something elsewhere
   * - a CI run, a merge, a queued job (`shared/paneBackJobs.ts` `isWaitScript`). That
   * holds nothing the CI run or the branch does not also hold, so it does not keep a
   * finished pane open (Robert, 2026-09-24: "they should just get closed").
   */
  backWaitOnly?: boolean
  /**
   * Its folder's git state, from the badge's cached read (`main/git.ts` `gitCached`):
   * changed files and commits not pushed. `null` = not a repo; `'unread'` = no fresh read
   * yet (one has been started); unset = not asked, which checks nothing.
   *
   * Robert's brief, 2026-09-28: finished is "no open ask, clean tree/pushed, no live
   * background job". Work left uncommitted or unpushed is work a closed card would hide.
   */
  folder?: { dirty: number; ahead: number } | null | 'unread'
  /**
   * The last moment a person was looking at this pane (`personLooking`) since its turn
   * ended; unset when nobody has since. A value older than `turnEndedAt` is an earlier
   * turn's and counts as unset, so a new turn resets it without anybody clearing it.
   */
  lookedAt?: number
}

/**
 * How long a pane somebody has READ waits after they look away. Robert, 2026-09-28 (s93, a
 * one-line answer he read and left): "should've closed that session automatically after
 * like 30secs after i read it".
 */
export const READ_QUIET_MS = 30_000

/** Has somebody looked at this turn's reply since it ended? */
export function wasRead(p: Pick<DoneReading, 'lookedAt' | 'turnEndedAt'>): boolean {
  return Boolean(p.turnEndedAt && p.lookedAt && p.lookedAt >= p.turnEndedAt)
}

/**
 * Unread findings and person-owned actions need a GuardDeck card. Robert, 2026-09-28: "shouldn't have shown
 * me report ... that had no manual things that i needed to see ... i already reviewed the
 * session". Its person-only steps still go out as their own to-dos either way.
 */
export function finishedCard(personSteps: number, read: boolean): boolean {
  return personSteps > 0 || !read
}

/** What `closeAfterResult` (`main/sessions.ts`) checks beyond busy, as `Session` has it. */
export interface CloseHolds {
  drafting?: unknown
  ask?: unknown
  owedPrompt?: unknown
  handingOff?: unknown
  handoffQueuedAt?: unknown
  handoffOpen?: number
  handoverUntil?: number
}

/**
 * Each flag that holds a finished pane open, in words - empty when none does. It was one
 * sentence for all seven, so done-close.log could not say which held s93 on 27 Sep (it was
 * `handoffOpen`: another chat's handoff in the same folder, five steps open, written 1h40m
 * before the pane's prompt - `handoffOpenAfter` now ignores that). claude-config's
 * autoclose.mjs reads these words: `handoff with open steps`.
 */
export function closeHeldBy(m: CloseHolds, now = Date.now()): string[] {
  const out: string[] = []
  if (m.drafting) out.push('a draft')
  if (m.ask) out.push('a question')
  if (m.owedPrompt) out.push('a queued prompt')
  if (m.handingOff) out.push('a handoff under way')
  if (m.handoffQueuedAt) out.push('a queued handoff')
  if (m.handoffOpen) out.push('a handoff with open steps')
  if ((m.handoverUntil ?? 0) > now) out.push('a prompt being handed over')
  return out
}

/**
 * How long a finished reply must sit unread before its pane goes. Long enough to walk
 * back from the kettle; the pane a person is IN never counts, and a card in Review is
 * one press from being a pane again.
 */
export const AUTO_CLOSE_QUIET_MS = 3 * 60_000

/**
 * The same wait on a machine MEASURED short of memory (`sleepPressureOf` over the capacity
 * verdict): one minute when tight, thirty seconds when over - the clocks the pressure
 * sleep used, which this close replaced (Robert, 2026-09-28: "id rather they close than
 * sleep"). A finished pane's ~190 MB is exactly what a short machine lacks, and it is one
 * press from Review either way.
 */
export function doneQuietMs(pressure: 'ok' | 'tight' | 'over'): number {
  return pressure === 'over' ? 30_000 : pressure === 'tight' ? 60_000 : AUTO_CLOSE_QUIET_MS
}

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
  | { close: true; personSteps: string[]; read: boolean }
  | { close: false; reason: string }

/** May this pane close itself into Review now? `quietMs` is the wait, `doneQuietMs`. */
export function doneVerdict(reading: DoneReading, now = Date.now(), quietMs = AUTO_CLOSE_QUIET_MS): DoneVerdict {
  const p = reading.backWaitOnly ? { ...reading, backJob: undefined } : reading
  if (p.agent === 'shell') return { close: false, reason: 'shell pane' }
  if (!p.turnEndedAt) return { close: false, reason: 'no finished turn' }
  if (p.focused) return { close: false, reason: 'somebody is looking at it' }
  if (p.openedOthers) return { close: false, reason: 'it opened other panes and collects their summary' }
  if (p.owedPrompt) return { close: false, reason: 'a prompt is on its way to it' }
  const quiet = now - Math.max(p.turnEndedAt, p.lastKeyboard)
  // A read pane always waits READ_QUIET_MS from when they looked away.
  const read = wasRead(p)
  const readQuiet = read ? now - Math.max(p.lookedAt ?? 0, p.lastKeyboard) >= READ_QUIET_MS : false
  if (quietMs !== 0 && ((read && !readQuiet) || (!read && quiet < quietMs))) return { close: false, reason: 'not quiet long enough' }
  if (!doneEnough(p, quiet, now)) return { close: false, reason: 'busy, asking, drafting or running something' }
  if (p.reply === undefined) return { close: false, reason: 'reply not read' }
  const left = replyLeaves(p.reply, p.runningAgents)
  if (left) return { close: false, reason: left }
  if (p.folder === 'unread') return { close: false, reason: 'its folder has not been read yet' }
  if (p.folder && (p.folder.dirty > 0 || p.folder.ahead > 0)) return { close: false, reason: 'its folder has uncommitted or unpushed work' }
  return { close: true, personSteps: personOwnedSteps(p.reply), read }
}

/**
 * What the last reply leaves for somebody to do next, in words, or null when it leaves
 * nothing: no question, no step an agent could take, no subagent still out.
 *
 * The reply half of `doneVerdict`, on its own because the CARD reads it too. Robert,
 * 2026-09-27: "why does it say its waiting when clearly its not" - a finished chat whose
 * reply said `Next steps: None` read `waiting` beside chats that really had asked him
 * something, because an idle pane's word only knew the turn was over.
 */
export function replyLeaves(reply: string, runningAgents?: number): string | null {
  if (runningAgents) return `${runningAgents} subagent${runningAgents === 1 ? '' : 's'} still running`
  if (/\?\s*$/.test(reply.trim())) return 'the reply ends in a question'
  // Ordinary final prose need not contain a literal "## Next steps" heading.
  // Explicit unfinished work must never become a completion claim by omission.
  const prose = reply.replace(/<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g, '').replace(/\*\*/g, '')
  if (/(?:^|\n)\s*(?:[-*]\s*)?(?:unfinished|remaining work|still to do|blocked)\s*:|\b(?:job|task|work|check) (?:itself )?(?:is (?:not finished|not complete|unfinished)|isn't (?:finished|complete))|\b(?:tasks?|steps?) remain open\b|\b(?:check|work|task) is (?:still )?queued\b/i.test(prose))
    return 'the reply reports unfinished work'
  const open = actionableNextSteps(reply)
  if (open.length) return `${open.length} step${open.length === 1 ? '' : 's'} an agent could take`
  return null
}

/**
 * Did this pane's last turn finish with nothing left for anyone - the card says `done`
 * rather than `waiting`. Undefined when that cannot be known (mid-turn, a question on
 * screen, a shell, the reply not read or empty), which the card draws as before.
 */
export function replyFinished(p: { agent: string; status: string; ask?: unknown; turnEndedAt: number; reply?: string; runningAgents?: number }): boolean | undefined {
  if (p.agent === 'shell' || p.status !== 'idle' || p.ask || !p.turnEndedAt) return undefined
  if (!p.reply?.trim()) return undefined
  return replyLeaves(p.reply, p.runningAgents) === null
}

/** One id per finished turn, so a retry of the same close is idempotent. */
export function doneReviewId(paneId: string, turnEndedAt: number): string {
  return `done_${String(paneId).replace(/[^A-Za-z0-9_-]/g, '_')}_${Math.floor(turnEndedAt / 1000)}`
}
