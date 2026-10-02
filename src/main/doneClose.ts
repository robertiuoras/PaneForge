// The finished-pane sweep: reads the reply, records the Review row, closes the pane, and
// turns each person-only step into a GuardDeck to-do. The rule is `shared/doneClose.ts`;
// this is the disk and the pane. Wired from `main/index.ts` on its own slow timer -
// nothing here runs per byte.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { profileName } from './profile'
import { doneReviewId, doneVerdict, folderLeftover, type DoneReading } from '../shared/doneClose'
import { machineOf, openTurnOf, readClaudeReply, readCodexReply, type ReplyRead } from '../shared/replyRead'
import { summaryOf, type FinishedNote } from '../shared/finishedDigest'
import type { ReviewInput, ReviewRecord } from '../shared/reviews'
import type { HistoryEntry } from '../shared/types'

/** Enough of a transcript to hold the last turn; a reply longer than this is truncated to its tail. */
const READ_BYTES = 512 * 1024

const cache = new Map<string, { size: number; mtimeMs: number; at: number; read: ReplyRead }>()

/**
 * The last reply in this transcript, re-read only when the file moved. The card's `done`
 * word asks every second (`sessions.ts` sweep), so an unchanged file is never parsed twice.
 */
export function readReply(agent: string, file: string, now = Date.now()): ReplyRead | undefined {
  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(file)
  } catch {
    return undefined
  }
  const hit = cache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.read
  let text = ''
  try {
    const fd = openSync(file, 'r')
    try {
      const len = Math.min(READ_BYTES, st.size)
      const buf = Buffer.alloc(len)
      const got = readSync(fd, buf, 0, len, st.size - len)
      text = buf.subarray(0, got).toString('utf8')
      if (len < st.size) text = text.split('\n').slice(1).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const read = agent === 'codex' ? readCodexReply(text) : readClaudeReply(text)
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, at: now, read })
  return read
}

/** What a GuardDeck to-do for one person-only step looks like on disk. */
export interface StepNotice {
  id: string
  actor: 'paneforge'
  title: string
  detail: string
  kind: 'step'
  /** Where the step happens. Read off the step's words; this machine when it says nothing. */
  machine: 'pc' | 'mac'
  step: string
  reviewId: string
  createdAt: string
  /** Enough to bring the conversation back on the right machine once the step is done. */
  reopen: { cwd: string; agent: string; resumeId: string; title: string; prompt: string }
}

export function stepNotice(record: Pick<ReviewRecord, 'id' | 'cwd' | 'provider' | 'nativeSessionId' | 'title' | 'prompt'>, step: string, n: number, thisMachine: 'pc' | 'mac', now = new Date()): StepNotice {
  const project = basename(record.cwd)
  return {
    id: `paneforge-step-${record.id}-${n}`,
    actor: 'paneforge',
    title: `To do: ${step}`,
    detail: `${project} - ${record.prompt.split('\n').find((l) => l.trim()) ?? record.title}`,
    kind: 'step',
    machine: machineOf(step) ?? thisMachine,
    step,
    reviewId: record.id,
    createdAt: now.toISOString(),
    reopen: {
      cwd: record.cwd,
      agent: record.provider,
      resumeId: record.nativeSessionId,
      title: record.title,
      prompt: `The step "${step}" is done. Continue from where the last reply left off.`
    }
  }
}

/** Where GuardDeck reads its notices on this machine. */
export const noticesDir = (): string => join(homedir(), '.claude', 'guarddeck', 'notices')

/** Notices go out from the packaged Mac app only, the same gate as `reviews.ts` `spoolNotice`. */
export function mayNotify(): boolean {
  return process.platform === 'darwin' && app.isPackaged && !profileName()
}

export function thisMachine(): 'pc' | 'mac' {
  return process.platform === 'win32' ? 'pc' : 'mac'
}

export interface DoneCloseDeps {
  enabled: () => boolean
  /** Every live pane's reading; the sweep decides, the manager reads. */
  readings: () => DoneReading[]
  transcriptFor: (id: string) => string | null
  resumeIdFor: (id: string) => string | undefined
  history: () => HistoryEntry[]
  titleOf: (id: string) => { title: string; cwd: string; agent: string } | undefined
  /** index.ts's own refusals: continuation, queued handoff, background job. */
  otherwiseBusy: (id: string) => string | null
  /** Writes the Review row WITHOUT its GuardDeck card; `notify` sends that once the pane is gone. */
  record: (input: ReviewInput, native: { title: string; provider: string; cwd: string; nativeSessionId: string }) => ReviewRecord
  /** The row's GuardDeck card and phone push (`reviews.ts` `sendReviewNotice`); `looked`/`opener` = no push. */
  notify: (reviewId: string, looked?: boolean, opener?: string) => void
  /** `why` is the plain-words reason the close-request line and History's `closedBecause` keep. */
  close: (id: string, reportedAt: number, why: string) => { closed: boolean; reason?: string }
  noteClose: (reviewId: string, reason?: string, closedAt?: string) => void
  writeNotice: (path: string, body: string) => void
  activity: (what: string, why: string) => void
  /** The pane that opened this one and wants its summary, when there is one. */
  openerOf?: (id: string) => string | undefined
  /** Leave a note for that opener (`shared/finishedDigest.ts`). */
  finished?: (opener: string, note: FinishedNote) => void
  now?: () => number
  /**
   * The pane's folder as `DoneReading.folder` has it (`gitCached`). Asked only for a pane
   * past every cheap gate, so an idle desk reads no git at all. It never holds a pane; it
   * only fills the Review row's `Left in <folder>: ...` line.
   */
  folderOf?: (id: string, since: number) => DoneReading['folder']
  /** How long a finished reply sits first (`doneQuietMs`); unset, `AUTO_CLOSE_QUIET_MS`. */
  quietMs?: () => number
  /**
   * `done-close.log`: why each finished pane stayed, written when the reason CHANGES. The
   * console alone kept nothing, so "why didn't it close" could only be guessed at.
   */
  log?: (line: string) => void
  /**
   * Decide only: return what WOULD close and touch nothing - no row, no close, no log
   * line. `pf tidy --dry-run`.
   */
  dry?: boolean
  /** Publish a separate finished-chat deadline; idle-close has its own clock. */
  setClosing?: (id: string, at: number | undefined) => void
}

/** The last thing logged per pane, so a pane that stays for an hour is one line, not 240. */
const said = new Map<string, string>()
const warnings = new Map<string, { turn: number; at: number }>()

/** One pass over the desk. Returns what it closed (with `dry`, would close), for the log and the test. */
export function sweepDoneClose(d: DoneCloseDeps): string[] {
  const readings = d.readings()
  const enabled = d.enabled()
  if (!d.dry) for (const id of warnings.keys()) {
    if (!enabled || !readings.some((r) => (r as DoneReading & { id: string }).id === id)) {
      warnings.delete(id)
      d.setClosing?.(id, undefined)
    }
  }
  if (!enabled) return []
  const now = d.now?.() ?? Date.now()
  const quietMs = d.quietMs?.()
  const closed: string[] = []
  const say = (id: string, what: string): void => {
    if (!d.dry && warnings.delete(id)) d.setClosing?.(id, undefined)
    if (d.dry || said.get(id) === what) return
    said.set(id, what)
    console.info(`done-close: ${id} ${what}`)
    d.log?.(`${id} ${what}`)
  }
  for (const r of readings) {
    const id = (r as DoneReading & { id: string }).id
    if (!id) continue
    // Cheap gates first; the transcript is read only for a pane that is otherwise done.
    let verdict = doneVerdict({ ...r, reply: undefined }, now, quietMs)
    if (!verdict.close && verdict.reason !== 'reply not read') {
      if (!d.dry && warnings.delete(id)) d.setClosing?.(id, undefined)
      if (r.turnEndedAt && verdict.reason !== 'not quiet long enough' && verdict.reason !== 'shell pane') say(id, `stays - ${verdict.reason}`)
      // An idle agent pane with NO turn end is the one no rule can ever close, and it used to
      // say nothing: four handed-in PC panes sat 1-3 hours with not one line here (2026-10-02).
      else if (verdict.reason === 'no finished turn' && r.status === 'idle' && !r.asleep && !r.runSince)
        say(id, 'stays - no finished turn: it never showed a turn ending here, and its conversation does not say one ended')
      continue
    }
    const agent = r.agent
    const file = d.transcriptFor(id)
    const reply = file ? readReply(agent, file, now) : undefined
    const openTurn = openTurnOf(reply, now) ?? undefined
    verdict = doneVerdict({ ...r, reply: reply?.text, runningAgents: reply?.runningAgents, openTurn }, now, quietMs)
    if (!verdict.close) {
      say(id, `stays - ${verdict.reason}`)
      continue
    }
    if (!reply?.text.trim()) {
      say(id, 'stays - the reply is empty')
      continue
    }
    const resumeId = d.resumeIdFor(id)
    const native = d.titleOf(id)
    if (!resumeId || !native) {
      say(id, `stays - ${resumeId ? 'no pane to name' : 'no conversation id to reopen it with'}`)
      continue
    }
    const busy = d.otherwiseBusy(id)
    if (busy) {
      say(id, `stays - ${busy}`)
      continue
    }
    if (d.dry) {
      closed.push(id)
      continue
    }
    // The folder never holds the pane. Asked now so a read has started by the close below.
    let folder = d.folderOf?.(id, r.turnEndedAt)
    // Quiet eligibility is not a visible warning. Start a fresh 30-second deadline
    // only after every refusal passes, and recheck them on every sweep.
    if (d.setClosing && quietMs !== 0) {
      let warning = warnings.get(id)
      if (!warning || warning.turn !== r.turnEndedAt) {
        warning = { turn: r.turnEndedAt, at: now + 30_000 }
        warnings.set(id, warning)
        d.setClosing(id, warning.at)
      }
      if (now < warning.at) continue
    }
    // A read still in flight when the countdown began has usually landed by its end: ask once
    // more, and say nothing if it still has not.
    if (folder === 'unread') folder = d.folderOf?.(id, r.turnEndedAt)
    const left = folderLeftover(folder, basename(native.cwd))
    const reviewId = doneReviewId(id, r.turnEndedAt)
    const h = d.history().find((e) => e.id === id)
    const prompt = h?.askLines?.[0] || h?.gist || reply.prompt || ''
    let record: ReviewRecord
    try {
      record = d.record(
        {
          id: reviewId,
          sessionId: id,
          nativeSessionId: resumeId,
          kind: 'result',
          proof: 'unverified',
          report: reply.text,
          prompt: prompt || '(nothing typed - the pane was opened with a prompt)',
          evidence: left ? [left] : [],
          completedAt: new Date(r.turnEndedAt).toISOString(),
          capturedAt: new Date(now).toISOString(),
          closeSession: true,
          workPreserved: true,
          noRemainingWork: verdict.personSteps.length === 0,
          // Robert, 2026-09-26: "finished chats should close, the review pops up in
          // GuardDeck" - with a box for the next prompt, which reaches this conversation
          // through `pf continue`. Same production gate as every notice (`spoolNotice`).
          // Sent below only once the pane has closed. Focus is not a review receipt.
          notify: true
        },
        { title: native.title, provider: native.agent, cwd: native.cwd, nativeSessionId: resumeId }
      )
    } catch (e) {
      console.warn(`done-close: ${id} not recorded - ${(e as Error).message}`)
      continue
    }
    const opener = d.openerOf?.(id)
    const iso = (t: number): string => new Date(t).toISOString()
    const why = `finished: the screen said its turn ended at ${iso(r.turnEndedAt)}, ` +
      `its conversation's last entry is ${reply.lastEntry ? `${reply.lastEntry.kind}${reply.lastEntry.at ? ` (${iso(reply.lastEntry.at)})` : ''}` : 'unknown'}` +
      `${reply.turnEndedAt ? `, turn-end row ${iso(reply.turnEndedAt)}` : ', no turn-end row'}, ` +
      `quiet ${Math.round((now - Math.max(r.turnEndedAt, r.lastKeyboard)) / 1000)}s, ${verdict.read ? 'read' : 'unread'}, reply leaves nothing to do (${reviewId})`
    const res = d.close(id, now, why)
    if (res.closed) {
      warnings.delete(id)
      d.setClosing?.(id, undefined)
      // Nothing reaches GuardDeck before this line: a close refused after its card went out
      // left a card for a pane still on the desk (s93, 27 Sep). The to-dos go either way;
      // every result retains its card unless the person explicitly reviewed it.
      let n = 0
      for (const step of verdict.personSteps) {
        const notice = stepNotice(record, step, ++n, thisMachine(), new Date(now))
        const path = join(noticesDir(), `${notice.id}.json`)
        if (!existsSync(path)) d.writeNotice(path, JSON.stringify(notice, null, 2))
      }
      d.notify(reviewId, verdict.read, opener)
      if (opener)
        d.finished?.(opener, {
          id,
          title: native.title,
          project: basename(native.cwd),
          summary: summaryOf(reply.text),
          personSteps: verdict.personSteps
        })
      d.noteClose(reviewId, undefined, new Date(now).toISOString())
      d.activity(native.title, verdict.personSteps.length ? `finished, ${verdict.personSteps.length} thing${verdict.personSteps.length === 1 ? '' : 's'} left for you` : 'finished')
      say(id, `finished and closed itself into Review (${reviewId})${verdict.read ? ', looked at' : ''}${left ? ` - ${left}` : ''}`)
      closed.push(id)
      said.delete(id)
    } else {
      d.noteClose(reviewId, res.reason)
      say(id, `stays - ${res.reason}`)
    }
  }
  return closed
}
