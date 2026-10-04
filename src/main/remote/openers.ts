/**
 * Chats on ANOTHER computer that report to a chat on THIS desk (`pf open --on <device>
 * --report-to <chat here>`, or `pf close-when-done @device/id --report-to <chat here>`).
 *
 * 2026-10-03 17:09Z: the Mac opened a Claude chat on the PC with `--close-when-done
 * --report-to` a Mac chat. Its first prompt never went in, and the Mac chat was never told:
 * the PC looked for the opener among its OWN chats (`SessionManager.openerOf`) and found
 * none. So the link is kept here, on the opener's desk, and read off the pane list the other
 * computer already sends every guest - which every PaneForge sends, so an older one there
 * changes nothing. Two things reach the opener, as they would for a chat on its own desk:
 *
 * - the first prompt never went in (`Session.promptUnsent` over there): told once, saying
 *   only what the input box really shows (in the incident the text was never drawn in it);
 * - the chat closed: the same note a local close leaves in the opener's digest
 *   (`shared/finishedDigest.ts`), with the report that came back as a Review row.
 *
 * Pure apart from the optional file the links are kept in (an app restart must not lose
 * them: the chat over there can run for hours). `node scripts/remote-test.mjs`.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Session } from '../../shared/types'
import { summaryOf, type FinishedNote } from '../../shared/finishedDigest'

export interface OpenerLink {
  /** `@<device>/<id>`: the chat over there. */
  id: string
  /** The chat on this desk that asked to hear how it ended. */
  opener: string
  /** "the PC", or the other computer's own name. */
  machine: string
  title: string
  project: string
  /** The start of the first prompt, to recognise it in the input box. Empty = not known. */
  prompt: string
  at: number
  /** The `promptUnsent` stamp the opener was already told about. */
  unsentTold?: number
  /** The first prompt went in (a sweep saw it neither owed nor unsent), so a later unsent prompt is not the first one. */
  firstDone?: boolean
  /** When the chat was first missing from that computer's list. */
  goneAt?: number
  /** The summary of the report that came back for it. */
  summary?: string
}

/** What the other computer's input box shows, against the prompt that should be in it. */
export type BoxRead = 'holds' | 'empty' | 'other' | 'unknown'

export interface OpenerDeps {
  /** That computer's whole pane list, or null while it is not connected (nothing is concluded). */
  panesOf(device: string): Pick<Session, 'id'>[] | null
  /** Read that chat's input box over there (`Remote.draftOn`) and compare it with `prompt`. */
  boxOf(id: string, prompt: string): Promise<BoxRead>
  /** `manager.tellPane` for the opener. */
  tell(opener: string, text: string): void
  /** Add the closed chat's note to the opener's digest, as a local close does. */
  finished(opener: string, note: FinishedNote): void
}

/** How long a closed chat's report may take to come back before the note goes without it. */
export const REPORT_WAIT_MS = 60_000
/** A link nobody could resolve in a week (that computer never came back) is dropped. */
const LINK_MAX_MS = 7 * 24 * 3_600_000
const PROMPT_HEAD = 400
/**
 * How long a `promptUnsent` stamp must stay set before the opener is told. Claude prompts
 * marked unsent have landed 44-97 s later (sessions.ts, the start-up hold), and the other
 * computer then clears the flag: telling at once made the opener send the prompt twice.
 */
export const OPENER_UNSENT_MS = Number(process.env.PF_OPENER_UNSENT_MS) || 120_000

/** Whether the input box `draft` holds `prompt` (whitespace ignored: a box soft-wraps). */
export function promptInBox(draft: string, prompt: string): BoxRead {
  const flat = (s: string): string => s.replace(/\s+/g, '')
  const d = flat(draft)
  if (!d) return 'empty'
  const p = flat(prompt)
  // No prompt known (a chat linked by `close-when-done` alone): whatever the box holds, it
  // cannot be said to be this prompt.
  if (!p) return 'unknown'
  // Claude Code and Codex show a long paste as one placeholder line.
  if (/^\[Pasted (text|Content)\b/i.test(draft.trim())) return 'holds'
  // A box of "y" or "Then" is inside any prompt: too little text to be the prompt.
  if (d.length < Math.min(20, p.length)) return 'other'
  const probe = (s: string): string => s.slice(0, 40)
  return d.includes(probe(p)) || p.includes(probe(d)) || p.includes(d.slice(-40)) ? 'holds' : 'other'
}

/** The one line the opener is told. Plain words: it is typed into an agent's input box. */
export function unsentLine(link: Pick<OpenerLink, 'id' | 'title' | 'machine'>, box: BoxRead, first: boolean): string {
  const what = `${first ? 'Your first prompt to' : 'A prompt typed into'} ${link.id} (${link.title}) on ${link.machine} never went in`
  switch (box) {
    case 'holds':
      return `${what}; ${first ? 'it is' : 'unsent text is'} still in that chat's input box.`
    case 'empty':
      return `${what}, and that chat's input box is empty, so it has to be sent again.`
    case 'other':
      return `${what}; that chat's input box holds other text, not this prompt, so it has to be sent again.`
    default:
      return `${what}; whether it is still in that chat's input box could not be checked (pf composer ${link.id} reads it).`
  }
}

/** `@<device>/<id>` into its two halves. */
function cut(id: string): { device: string; local: string } | null {
  const m = /^@([^/]+)\/(.+)$/.exec(id)
  return m ? { device: m[1], local: m[2] } : null
}

type Listed = Pick<Session, 'id'> & Partial<Pick<Session, 'status' | 'owedPrompt' | 'promptUnsent' | 'runSince' | 'job' | 'finished'>>

export class RemoteOpeners {
  private links = new Map<string, OpenerLink>()
  private sweeping = false

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as OpenerLink[]
      for (const l of Array.isArray(saved) ? saved : []) if (l && typeof l.id === 'string' && typeof l.opener === 'string') this.links.set(l.id, l)
    } catch {
      // no file yet, or one this build cannot read: no links
    }
  }

  /** Keep `id`'s report for `opener`; `info.prompt` is the first prompt sent with it, if any. */
  link(id: string, opener: string, info: Pick<OpenerLink, 'machine' | 'title' | 'project' | 'prompt'>, now = Date.now()): void {
    // Linking again (a chat opened with its prompt, later armed to close when done) adds to
    // the link; it never drops the prompt or what the opener was already told.
    const was = this.links.get(id)
    this.links.set(id, { ...was, id, opener, machine: info.machine, title: info.title, project: info.project, prompt: info.prompt ? info.prompt.slice(0, PROMPT_HEAD) : (was?.prompt ?? ''), at: was?.at ?? now })
    this.save()
  }

  /** A report for a chat over there came back as a Review row (`storeRemoteReview`). */
  review(id: string, report: string): void {
    const l = this.links.get(id)
    if (!l) return
    l.summary = summaryOf(report)
    this.save()
  }

  /** One pass over every link: called on the finished-chat sweep's 15 s beat. */
  async sweep(d: OpenerDeps, now = Date.now()): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      for (const l of [...this.links.values()]) {
        const where = cut(l.id)
        const list = where ? (d.panesOf(where.device) as Listed[] | null) : null
        if (!where || !list) {
          if (!where || now - l.at > LINK_MAX_MS) this.drop(l.id)
          continue
        }
        const pane = list.find((s) => s.id === where.local)
        if (pane) {
          const was = JSON.stringify(l)
          l.goneAt = undefined
          if (!pane.owedPrompt && !pane.promptUnsent) l.firstDone = true
          const stamp = pane.promptUnsent
          // Still set OPENER_UNSENT_MS after it was stamped, and no turn begun since: a prompt
          // that lands late clears the flag (or starts a turn) well before that.
          if (stamp && stamp !== l.unsentTold && now - stamp >= OPENER_UNSENT_MS && !(pane.runSince && pane.runSince > stamp)) {
            // Marked before the read, so a second pass while it runs cannot tell twice.
            l.unsentTold = stamp
            const first = !l.firstDone
            const box = await d.boxOf(l.id, first ? l.prompt : '').catch((): BoxRead => 'unknown')
            d.tell(l.opener, unsentLine(l, box, first))
          }
          if (JSON.stringify(l) !== was) this.save()
          continue
        }
        l.goneAt ??= now
        if (l.summary === undefined && now - l.goneAt < REPORT_WAIT_MS) continue
        d.finished(l.opener, {
          id: l.id,
          title: l.title,
          project: l.project,
          summary: l.summary ?? `it closed on ${l.machine}, and no report of what it did came back to this computer.`,
          personSteps: []
        })
        this.drop(l.id)
      }
    } finally {
      this.sweeping = false
    }
  }

  /**
   * How many of `opener`'s chats over there still hold its digest back: working, owed a
   * prompt, on a computer not connected right now, or closed with the report still coming.
   */
  workingFor(opener: string, panesOf: OpenerDeps['panesOf']): number {
    let n = 0
    for (const l of this.links.values()) {
      if (l.opener !== opener) continue
      const where = cut(l.id)
      const list = where ? (panesOf(where.device) as Listed[] | null) : null
      const pane = list?.find((s) => s.id === where?.local)
      if (!list || !pane || pane.status === 'working' || pane.owedPrompt || pane.runSince || pane.job) n++
    }
    return n
  }

  /** How many of `opener`'s chats over there are still open (what the digest says is left). */
  openFor(opener: string, panesOf: OpenerDeps['panesOf']): number {
    let n = 0
    for (const l of this.links.values()) {
      if (l.opener !== opener) continue
      const where = cut(l.id)
      const list = where ? panesOf(where.device) : null
      if (!list || list.some((s) => s.id === where?.local)) n++
    }
    return n
  }

  private drop(id: string): void {
    if (this.links.delete(id)) this.save()
  }

  private save(): void {
    if (!this.file) return
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify([...this.links.values()]), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (e) {
      console.warn(`remote-openers: links not saved - ${(e as Error).message}`)
    }
  }
}
