// Moving a pane's WORK to another device, when the pty itself cannot move.
//
// A handoff is three facts sent over the paired link: the pane's start request
// (which conversation to resume, which agent, which folder), the repo's pushed
// branch (the git remote is the transport for code - nothing diffs over this
// link), and the pane's transcript file, because `--resume` reads a file that
// only exists on the sending machine. The receiver pulls the branch, writes the
// transcript where its own CLI will look, and starts an ordinary local pane.
// The sender then closes its pane; the mirror of the new one arrives through
// the existing session stream, so the desk that handed off keeps watching.

import type { DevServer } from './devServers'
import type { Session, StartSessionRequest } from './types'

/** How the receiver gets the code: the repo's own remote, never bytes on this link. */
export interface HandoffRepo {
  url: string
  branch: string
  /** repo top-level, relative to the sender's projects root - where a clone goes */
  dirRel: string
}

export interface HandoffPayload {
  /** the pane, with every path still the SENDER's - the receiver remaps them */
  spec: StartSessionRequest
  /** the sender's projects root, so relative layout survives the machine change */
  senderRoot: string
  repo?: HandoffRepo
  /** announced ahead of its chunks; `name` is `<conversation-id>.jsonl` */
  transcript?: { name: string; size: number }
  /** groups this payload with its chunk frames on the wire */
  xfer?: string
  /** what was on the pane's screen, replayed into the new pane's scrollback */
  tail?: string
  /** close the receiver only after this transferred pane ends and nothing else runs there */
  closeReceiverWhenDone?: boolean
  /**
   * The dev servers this pane had running, as package.json SCRIPT names.
   *
   * Never a command line. The receiver builds the command from its own package.json and
   * its own lockfile, so the worst a payload can name is a script that repo's own author
   * wrote - see `shared/devServers.ts` for why the observed argv is the wrong thing to
   * move (a hard-coded port, and a node_modules the far end may not have).
   */
  dev?: DevServer[]
}

/** What the handoff chooser is allowed to move. No ids is the deliberate bulk action. */
export interface HandoffRequest {
  ids?: string[]
  closeReceiverWhenDone?: boolean
  /**
   * A pane that is mid-turn is queued and moved when the turn ends, rather than refused.
   *
   * Default. The alternative - moving it now - kills the pty mid-answer, and the far end
   * resumes from a transcript that only holds turns the CLI has already flushed, so the
   * answer being written is simply lost. Set false only where the caller has already
   * decided the turn does not matter.
   */
  waitForTurn?: boolean
}

export interface HandoffResult {
  ok: boolean
  error?: string
  session?: Session
  /** things that carried only partly - said, never silently dropped */
  notes: string[]
}

/** One pane's outcome, as the report the sender shows. */
export interface HandoffItem {
  id: string
  title: string
  ok: boolean
  error?: string
  notes: string[]
  /**
   * Not moved yet and not refused: the pane was mid-turn and is queued.
   *
   * `ok` stays false because nothing has travelled - a report that said yes here would be
   * the "typed but never sent" shape of lie, where the screen agrees and the machine has
   * not done the thing.
   */
  pending?: boolean
}

/**
 * A handoff receiver is safe to quit only after its transferred work has stopped and it
 * has no other local pty left. An idle pane is still somebody's question, never "done".
 */
export function handoffReceiverCanQuit(ids: ReadonlySet<string>, sessions: Pick<Session, 'id' | 'status'>[]): boolean {
  return ids.size > 0 && sessions.every((s) => s.status === 'exited')
}

/** Chunks stay well under the wire's 8 MB frame cap even after base64. */
export const HANDOFF_CHUNK = 2 * 1024 * 1024
/** A transcript bigger than this is refused rather than assembled in memory. */
export const HANDOFF_MAX_FILE = 64 * 1024 * 1024
/** Clone or pull on the far end can genuinely take this long on a cold repo. */
export const HANDOFF_ASK_MS = 180_000

const slash = (p: string): string => p.replace(/\\/g, '/')

/**
 * The same folder on the other machine: the path relative to the sender's
 * projects root, grafted onto the receiver's. Case-insensitive on the prefix
 * because one side of every pairing here is Windows. Null when the folder is
 * outside the root - there is no honest guess for where that lives over there.
 */
export function mapCwd(cwd: string, fromRoot: string, toRoot: string): string | null {
  const from = slash(fromRoot).replace(/\/+$/, '')
  const at = slash(cwd)
  if (!from) return null
  if (at.toLowerCase() !== from.toLowerCase() && !at.toLowerCase().startsWith(from.toLowerCase() + '/')) {
    return null
  }
  const rel = at.slice(from.length).replace(/^\/+/, '')
  const winish = /\\/.test(toRoot) || /^[A-Za-z]:/.test(toRoot)
  const root = toRoot.replace(/[\\/]+$/, '')
  if (!rel) return root
  return winish ? root + '\\' + rel.replace(/\//g, '\\') : root + '/' + rel
}

/**
 * What to say about a handoff, once every pane has answered.
 *
 * A pure function because the interesting case is the MIXED one and it cannot be reached
 * from the dialog: three panes where one moved, one is queued mid-turn and one refused.
 * The first version of this was a chain of `bad.length === 0` branches, so a single
 * failure silenced both the pane that moved and the pane still waiting - the same class of
 * lie as saying "moved" about a pane that is still running here, in the other direction.
 * Every outcome that happened gets a clause; nothing that did not happen is mentioned.
 */
export function handoffReport(items: HandoffItem[], deviceName: string, title?: string): string {
  if (items.length === 0) return 'Nothing to hand off - those panes have already closed'
  const moved = items.filter((i) => i.ok)
  const held = items.filter((i) => !i.ok && i.pending)
  const bad = items.filter((i) => !i.ok && !i.pending)
  const one = items.length === 1
  const parts: string[] = []
  if (moved.length)
    parts.push(
      one && title
        ? `Moved ${title} to ${deviceName}. It is still on screen here, as a mirror.`
        : `Moved ${moved.length} ${moved.length === 1 ? 'pane' : 'panes'} to ${deviceName}.`
    )
  if (held.length)
    parts.push(
      one && title
        ? `${title} is mid-turn - it moves to ${deviceName} the moment the turn ends. Nothing was interrupted.`
        : `${held.length} still working - ${held.length === 1 ? 'it goes' : 'they go'} as soon as the turn ends.`
    )
  // Named, not counted: an error nobody can read is a pane that quietly stayed put.
  for (const b of bad) parts.push(`${b.title}: ${b.error || 'refused over there'}`)
  return parts.join(' ')
}
