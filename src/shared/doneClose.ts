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
// pane open, a question keeps it open. Looking at it does not (Robert, 2026-10-03).
//
// Pure. `main/doneClose.ts` reads the transcript and closes; `npm run test:doneclose`.

import { CLOSE_DONE_QUIET_MS, doneEnough, type DonePane } from './closeWhenDone'
import { actionableNextSteps, openNextSteps, personOwnedSteps } from './handoffSteps'

/**
 * What deciding needs to know, on top of what `closeWhenDone` already reads. The hand-off
 * flags are `CloseHolds`', so the sweep refuses on `closeHeldBy` itself.
 */
export interface DoneReading extends DonePane, Pick<CloseHolds, 'handingOff' | 'handoffQueuedAt' | 'handoffOpen' | 'handoverUntil'> {
  agent: string
  lastKeyboard: number
  /** When the pane's own footer last said the turn was over; 0 = mid-turn or never ran. */
  turnEndedAt: number
  /** The reply as the CLI's transcript has it, or undefined when it could not be read. */
  reply?: string
  /** Subagents launched in the background and not yet reported back. */
  runningAgents?: number
  /**
   * The transcript says the turn is still open (`shared/replyRead.ts` `openTurnOf`), in
   * words. Read with the reply. The screen's footer is not enough: s105 (2026-10-02) closed
   * mid-turn, between two Chrome tool calls, on a footer read that had gone quiet.
   */
  openTurn?: string
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
   * yet (one has been started); unset = not asked.
   *
   * It no longer holds a pane. Robert, 2026-10-02: "we dont need that guard anymore since we
   * have reports". Read only so the Review record can say what was left (`folderLeftover`);
   * 748 of ~950 holds on 1-2 Oct were this guard, chats in shared folders held by other
   * chats' changes. Nothing on disk is touched.
   */
  folder?: { dirty: number; ahead: number } | null | 'unread'
  /**
   * The last moment a person was looking at this pane (`personLooking`) since its turn
   * ended; unset when nobody has since. A value older than `turnEndedAt` is an earlier
   * turn's and counts as unset, so a new turn resets it without anybody clearing it.
   * It no longer delays or cancels the close; it only means the phone is not pushed.
   */
  lookedAt?: number
  /** What the sweep last published as `Session.waitsForYou`, so it publishes only a change. */
  waitsForYou?: string
  /**
   * A person said to keep this pane open (the card's "Keep this pane open",
   * `config.pinnedPanes`). Robert, 2026-09-29: "mark a session as keep open so auto close
   * won't close it ... some work long running I need to see result and also continue the
   * session". The pin held off the idle clock only, so a kept pane still closed itself
   * into Review the moment its turn was over.
   */
  kept?: boolean
}

/**
 * Has somebody looked at this turn's reply since it ended? Only the phone push reads it
 * (`notify`'s `looked`): looking never holds, delays or cancels a close (Robert,
 * 2026-10-03: "if i go in paneforge in that chat it shouldn't stop the coutndown").
 */
export function wasRead(p: Pick<DoneReading, 'lookedAt' | 'turnEndedAt'>): boolean {
  return Boolean(p.turnEndedAt && p.lookedAt && p.lookedAt >= p.turnEndedAt)
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
 * How long a finished reply sits after its turn ended (and after the last key) before its
 * countdown starts. Robert, 2026-10-03: "3 minutes is too long i think make it 1 minute by
 * default". A card in Review is one press from being a pane again.
 */
export const AUTO_CLOSE_QUIET_MS = 60_000

/**
 * The countdown after that wait, shown only in GuardDeck, whose Stop is `sessions:keepOpen`.
 * Robert, 2026-10-03: "only show countdown in guardeck like 15secs with option to stop it".
 */
export const DONE_COUNTDOWN_MS = 15_000

/**
 * The same wait on a machine MEASURED short of memory (`sleepPressureOf` over the capacity
 * verdict): thirty seconds when tight, fifteen when over (Robert, 2026-09-28: "id rather
 * they close than sleep"). A finished pane's ~190 MB is exactly what a short machine lacks.
 */
export function doneQuietMs(pressure: 'ok' | 'tight' | 'over'): number {
  return pressure === 'over' ? 15_000 : pressure === 'tight' ? 30_000 : AUTO_CLOSE_QUIET_MS
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

/**
 * Which pane-state flag `doneEnough` refused on, in words; null when it did not refuse.
 *
 * It was one sentence for seven flags, so done-close.log could not say which held s42 on
 * 1-2 Oct: "busy, asking, drafting or running something" from 11:56pm until Robert came
 * back at 1:13am. It was an unsent-draft flag nothing could clear (the composer read lost
 * Claude's box while a hint line sat below it) - known only by elimination, which a log
 * line naming the flag would have said in one read.
 */
export function whyNotDone(p: DonePane, quietMs: number, now = Date.now()): string | null {
  if (doneEnough(p, quietMs, now)) return null
  if (!p.printed) return 'not started'
  if (p.asleep) return 'asleep'
  if (p.status === 'exited') return 'its program has exited'
  if (p.runSince || (p.busyUntil ?? 0) > now) return 'a turn running'
  if (p.ask) return 'a question on screen'
  if (p.drafting) return 'an unsent draft in its prompt box'
  if (p.backJob) return `a background job (${p.backJob})`
  if (quietMs < CLOSE_DONE_QUIET_MS) return 'printed in the last 8 s'
  return 'busy or running something'
}

export type DoneVerdict =
  | { close: true; personSteps: string[]; read: boolean }
  | { close: false; reason: string }

/**
 * What a finished pane's folder still holds, for its Review record: `Left in toolstash: 6
 * changed files, 2 commits not pushed`. Undefined when there is nothing to say - a clean and
 * pushed folder, not a repo, not asked, or a read still in flight (say nothing, never guess).
 */
export function folderLeftover(folder: DoneReading['folder'], name: string): string | undefined {
  if (!folder || folder === 'unread') return undefined
  const parts: string[] = []
  if (folder.dirty > 0) parts.push(`${folder.dirty} changed file${folder.dirty === 1 ? '' : 's'}`)
  if (folder.ahead > 0) parts.push(`${folder.ahead} commit${folder.ahead === 1 ? '' : 's'} not pushed`)
  return parts.length ? `Left in ${name}: ${parts.join(', ')}` : undefined
}

/** May this pane close itself into Review now? `quietMs` is the wait, `doneQuietMs`. */
export function doneVerdict(reading: DoneReading, now = Date.now(), quietMs = AUTO_CLOSE_QUIET_MS): DoneVerdict {
  const p = reading.backWaitOnly ? { ...reading, backJob: undefined } : reading
  if (p.agent === 'shell') return { close: false, reason: 'shell pane' }
  if (p.kept) return { close: false, reason: 'kept open by hand' }
  if (!p.turnEndedAt) return { close: false, reason: 'no finished turn' }
  if (p.openedOthers) return { close: false, reason: 'it opened other panes and collects their summary' }
  if (p.owedPrompt) return { close: false, reason: 'a prompt is on its way to it' }
  // Typing counts; looking does not (Robert, 2026-10-03).
  const quiet = now - Math.max(p.turnEndedAt, p.lastKeyboard)
  if (quietMs !== 0 && quiet < quietMs) return { close: false, reason: 'not quiet long enough' }
  const busy = whyNotDone(p, quiet, now)
  if (busy) return { close: false, reason: busy }
  // What `closeAfterResult` refuses on, refused here first: passed here and refused there,
  // a held pane got a fresh 30-second countdown every sweep that never closed it (s48,
  // 2026-10-01, twelve in eight minutes, held by a handoff with open steps).
  const held = closeHeldBy(p, now)
  if (held.length) return { close: false, reason: `session has ${held.join(', ')}` }
  if (p.openTurn) return { close: false, reason: `its turn is still open - ${p.openTurn}` }
  if (p.reply === undefined) return { close: false, reason: 'reply not read' }
  const left = replyLeaves(p.reply, p.runningAgents)
  if (left) return { close: false, reason: left }
  return { close: true, personSteps: replyPersonSteps(p.reply), read: wasRead(p) }
}

/**
 * Does this finished chat expect its person, in words - null when it leaves nothing for
 * itself to do? Robert, 2026-10-03: a chat that asks him something, reports unfinished
 * work, lists steps an agent could take, has subagents out, a handoff with open steps, or
 * waits for the panes it opened STAYS OPEN until he acts. `doneVerdict` already held these;
 * this is the same reading published as `Session.waitsForYou` so the idle clock
 * (`shared/reclaim.ts`), `sessions:closeIntoReview` and the asleep sweep never close it
 * either. Steps only a person can take never count: they become GuardDeck to-dos.
 */
export function waitsForYou(
  p: Pick<DoneReading, 'reply' | 'runningAgents' | 'openedOthers'> & CloseHolds,
  now = Date.now()
): string | null {
  if (p.openedOthers) return 'it opened other panes and collects their summary'
  if (p.handoffOpen) return 'a handoff with open steps'
  return p.reply === undefined ? null : replyLeaves(p.reply, p.runningAgents)
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
  const open = replyAgentSteps(reply)
  if (open.length) return `${open.length} step${open.length === 1 ? '' : 's'} an agent could take`
  return null
}

/**
 * A step that opens with what a person SAYS is theirs: 'Say "release" to ship main' (s42,
 * 1 Oct). The `handoffSteps` mirror knows "Robert to ..." and "your call", not this.
 */
const SAID_BY_PERSON = /^(?:say|tell me|reply|answer)\b/i

/**
 * A reply's steps in the shape `handoffSteps` reads. It reads a `## Next steps` HEADING,
 * which handoff files have and replies do not: they say `**Next steps:**` or `Next steps:
 * None`, so s42's report read as no steps at all. Label lines become headings (a step
 * written on the label line becomes the first bullet), any other label line - bold, or a
 * bare `Something:` alone on its line - ends the section, and a bullet indented under a
 * step is that step's detail, not a step.
 */
export function replyStepsText(reply: string): string {
  const out: string[] = []
  let inSteps = false
  let base = -1
  for (const line of String(reply || '').split('\n')) {
    const plain = line.replace(/\*\*|__/g, '')
    const label = plain.match(/^\s*(?:#{1,4}\s*)?Next steps\s*(?::\s*(.*))?$/i)
    if (label) {
      out.push('## Next steps')
      if (label[1]?.trim()) out.push(`- ${label[1].trim()}`)
      inSteps = true
      base = -1
      continue
    }
    if (/^#{1,4}\s/.test(line) || (/^\s*[^\s\-*+#\d>][^:]{0,60}:\s*$/.test(plain) && (/^\s*(?:\*\*|__)/.test(line) || !/^\s/.test(line)))) {
      inSteps = false
      out.push(/^#{1,4}\s/.test(line) ? line : `## ${plain.trim()}`)
      continue
    }
    const bullet = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s/)
    if (inSteps && bullet) {
      const indent = bullet[1].replace(/\t/g, '    ').length
      if (base < 0) base = indent
      if (indent > base) continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** The steps a reply leaves for an agent: `actionableNextSteps` over `replyStepsText`. */
export function replyAgentSteps(reply: string): string[] {
  return actionableNextSteps(replyStepsText(reply)).filter((step) => !SAID_BY_PERSON.test(step))
}

/** The steps a reply leaves for a person, in the order it lists them. */
export function replyPersonSteps(reply: string): string[] {
  const md = replyStepsText(reply)
  const theirs = new Set(personOwnedSteps(md))
  return openNextSteps(md).filter((step) => theirs.has(step) || SAID_BY_PERSON.test(step))
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

/**
 * Should a pane that has never shown a turn ending take its turn end from its transcript?
 *
 * The footer is the only thing that sets `turnEndedAt`, and only on a busy -> idle flip. A
 * pane started ON a conversation whose last turn had already ended - handed in from the
 * other machine, reopened from Review, restored with the desk - never flips, so every close
 * rule skipped it in silence: 2026-10-02 the PC held s8/s9/s10/s12 for 1-3 hours, all
 * finished on the Mac before the handoff. Seeded with the moment it is seen (never the
 * transcript's own time), the normal rules still decide: quiet window, looked at, Keep
 * open, owed prompt, steps left. Anything this pane did itself this run outranks it.
 */
export function seedTurnEnd(p: {
  agent: string
  status: string
  asleep?: boolean
  ask?: unknown
  /** Started with `--resume` (or Codex's resume) onto an existing conversation. */
  resumed: boolean
  /** This run has read the agent's running footer at least once. */
  sawFooter: boolean
  turnEndedAt: number
  turnPending: boolean
  runSince?: number
  /** `ReplyRead.turnEndedAt`: the transcript's last turn is over. */
  transcriptTurnEndedAt?: number
}): boolean {
  if (p.agent === 'shell' || p.status !== 'idle' || p.asleep || p.ask) return false
  if (!p.resumed || p.sawFooter || p.turnEndedAt || p.turnPending || p.runSince) return false
  return Boolean(p.transcriptTurnEndedAt)
}
