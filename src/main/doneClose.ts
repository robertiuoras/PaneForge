// The finished-pane sweep: reads the reply, records the Review row, closes the pane, and
// turns each person-only step into a GuardDeck to-do. The rule is `shared/doneClose.ts`;
// this is the disk and the pane. Wired from `main/index.ts` on its own slow timer -
// nothing here runs per byte.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { profileName } from './profile'
import { doneReviewId, doneVerdict, type DoneReading } from '../shared/doneClose'
import { machineOf, readClaudeReply, readCodexReply, type ReplyRead } from '../shared/replyRead'
import { summaryOf, type FinishedNote } from '../shared/finishedDigest'
import type { ReviewInput, ReviewRecord } from '../shared/reviews'
import type { HistoryEntry } from '../shared/types'

/** Enough of a transcript to hold the last turn; a reply longer than this is truncated to its tail. */
const READ_BYTES = 512 * 1024
/** How often one pane's transcript is re-read while it sits finished. */
export const REREAD_MS = 30_000

const cache = new Map<string, { size: number; mtimeMs: number; at: number; read: ReplyRead }>()

/** The last reply in this transcript, re-read only when the file or the clock moved. */
export function readReply(agent: string, file: string, now = Date.now()): ReplyRead | undefined {
  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(file)
  } catch {
    return undefined
  }
  const hit = cache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && now - hit.at < REREAD_MS) return hit.read
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
  record: (input: ReviewInput, native: { title: string; provider: string; cwd: string; nativeSessionId: string }) => ReviewRecord
  close: (id: string, reportedAt: number) => { closed: boolean; reason?: string }
  noteClose: (reviewId: string, reason?: string, closedAt?: string) => void
  writeNotice: (path: string, body: string) => void
  activity: (what: string, why: string) => void
  /** The pane that opened this one and wants its summary, when there is one. */
  openerOf?: (id: string) => string | undefined
  /** Leave a note for that opener (`shared/finishedDigest.ts`). */
  finished?: (opener: string, note: FinishedNote) => void
  now?: () => number
  /**
   * `done-close.log`: why each finished pane stayed, written when the reason CHANGES. The
   * console alone kept nothing, so "why didn't it close" could only be guessed at.
   */
  log?: (line: string) => void
}

/** Panes with a review row already written this turn, so a refused close is not re-recorded every tick. */
const recorded = new Map<string, string>()
/** The last thing logged per pane, so a pane that stays for an hour is one line, not 240. */
const said = new Map<string, string>()

/** One pass over the desk. Returns what it closed, for the log and the test. */
export function sweepDoneClose(d: DoneCloseDeps): string[] {
  if (!d.enabled()) return []
  const now = d.now?.() ?? Date.now()
  const closed: string[] = []
  const say = (id: string, what: string): void => {
    if (said.get(id) === what) return
    said.set(id, what)
    console.info(`done-close: ${id} ${what}`)
    d.log?.(`${id} ${what}`)
  }
  for (const r of d.readings()) {
    const id = (r as DoneReading & { id: string }).id
    if (!id) continue
    // Cheap gates first; the transcript is read only for a pane that is otherwise done.
    let verdict = doneVerdict({ ...r, reply: undefined }, now)
    if (!verdict.close && verdict.reason !== 'reply not read') {
      if (r.turnEndedAt && verdict.reason !== 'not quiet long enough' && verdict.reason !== 'shell pane') say(id, `stays - ${verdict.reason}`)
      continue
    }
    const agent = r.agent
    const file = d.transcriptFor(id)
    const reply = file ? readReply(agent, file, now) : undefined
    verdict = doneVerdict({ ...r, reply: reply?.text, runningAgents: reply?.runningAgents }, now)
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
          evidence: [],
          completedAt: new Date(r.turnEndedAt).toISOString(),
          capturedAt: new Date(now).toISOString(),
          closeSession: true,
          workPreserved: true,
          noRemainingWork: verdict.personSteps.length === 0,
          // Robert, 2026-09-26: "finished chats should close, the review pops up in
          // GuardDeck" - with a box for the next prompt, which reaches this conversation
          // through `pf continue`. Same production gate as every notice (`spoolNotice`).
          notify: true
        },
        { title: native.title, provider: native.agent, cwd: native.cwd, nativeSessionId: resumeId }
      )
    } catch (e) {
      console.warn(`done-close: ${id} not recorded - ${(e as Error).message}`)
      continue
    }
    if (recorded.get(id) !== reviewId) {
      recorded.set(id, reviewId)
      let n = 0
      for (const step of verdict.personSteps) {
        const notice = stepNotice(record, step, ++n, thisMachine(), new Date(now))
        const path = join(noticesDir(), `${notice.id}.json`)
        if (!existsSync(path)) d.writeNotice(path, JSON.stringify(notice, null, 2))
      }
    }
    const opener = d.openerOf?.(id)
    const res = d.close(id, now)
    if (res.closed) {
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
      say(id, `finished and closed itself into Review (${reviewId})`)
      closed.push(id)
      recorded.delete(id)
      said.delete(id)
    } else {
      d.noteClose(reviewId, res.reason)
      say(id, `stays - ${res.reason}`)
    }
  }
  return closed
}
