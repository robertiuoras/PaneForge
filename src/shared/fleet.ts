// One pane, reduced to the three things you want without opening it: what it is doing,
// who is expected to act, and how much it has changed.
//
// This is the arithmetic half of the sessions list, kept out of the component for the same
// reason `place.ts` is - it is a pile of small judgements about words and ordering, every
// one of which is worth pinning, and none of which needs a window. `npm run test:fleet`.
//
// The state list is deliberately LONGER than `SessionStatus`. A session's status answers
// "is the pty printing", which is a fact about a process; this answers "does anybody need
// to do anything", which is the question a person actually opens the app with. Two panes
// both reading `idle` are a finished turn and a CLI nobody has typed into yet, and those
// are not the same screen at all.

import type { GitInfo, Session } from './types'

/**
 * The fields these judgements read, and nothing else.
 *
 * Written as a shape rather than as `Session` because a pane on a PAIRED DEVICE is
 * ranked by exactly the same rules and is not a Session on this machine - it has no
 * pty here, no scrollback here and no xterm here. `RemotePaneInfo` carries these
 * fields for that reason, so one function sorts both lists and the sidebar cannot
 * disagree with itself about which pane wants a person.
 */
export interface FleetPane {
  status: Session['status']
  bell?: boolean
  stalledSince?: number
  engaged?: boolean
  runSince?: number
  lastOutput?: number
  createdAt?: number
  exitCode?: number
  /**
   * The command this pane is running, when the app can name one - see `paneJob.ts`.
   * Only the label reads it: a row saying `working` about a shell pane is true and says
   * nothing, and `running npm` is the reason somebody looked at the list.
   */
  job?: string
}

export type FleetState =
  | 'needsYou'  // a turn ended, or the terminal rang: your move
  | 'stalled'   // a turn is still running and the pane has gone quiet mid-run
  | 'working'   // printing
  | 'starting'  // spawned, nothing on screen yet
  // A CLI with nothing pending: never asked anything, or asked and then CLEARED. Quiet,
  // but it has finished nothing for anybody to read. `engaged` is what says so, and it is
  // dropped again by a `/clear` in `sessions.ts` - which is the only way a pane comes back
  // here once it has been used, and the reason this group is not a bag of leftovers.
  | 'ready'
  | 'exited'    // the process ended

/**
 * Who the motion is for.
 *
 * Every competitor signals a running job with a spinner per row, which is a lot of
 * movement that all means the same thing. The one pattern worth copying (Vercel's status
 * dot, Cursor's Dynamic Island) is the opposite: whether a thing moves at all is the
 * signal, and the movement STOPPING is the event. So there are exactly two motions and
 * they mean different things - `pulse` is the app working, `call` is the app waiting on
 * you - and a terminal state is perfectly still.
 */
export type FleetMotion = 'pulse' | 'call' | 'still'

export interface FleetRow {
  state: FleetState
  /** what the row says out loud */
  label: string
  motion: FleetMotion
  /**
   * Epoch ms the row's clock counts from, undefined when a duration would say nothing.
   * Which moment that is changes with the state: a working pane counts its turn, a
   * stalled one counts the silence, a finished one counts how long it has been waiting.
   */
  since?: number
  /** sort key - the whole point of the screen is that the top row is the one to look at */
  rank: number
}

const LABEL: Record<FleetState, string> = {
  needsYou: 'waiting for you',
  stalled: 'quiet mid-turn',
  working: 'working',
  starting: 'starting',
  ready: 'ready - type to start',
  exited: 'exited'
}

const MOTION: Record<FleetState, FleetMotion> = {
  needsYou: 'call',
  stalled: 'call',
  working: 'pulse',
  starting: 'pulse',
  ready: 'still',
  exited: 'still'
}

/** Sorted the way the screen reads: whoever needs a person is at the top. */
const RANK: Record<FleetState, number> = {
  needsYou: 0,
  stalled: 1,
  working: 2,
  starting: 3,
  ready: 4,
  exited: 5
}

/**
 * Does a byte arriving on the pty mean the agent is WORKING?
 *
 * This used to read `engaged || busyUntil > now`, and `engaged` is sticky for the life
 * of the session - it is set by the first keystroke and never cleared. So the echo of
 * somebody TYPING flipped the pane to `working`, four seconds of quiet dropped it back
 * to `idle`, and `engaged` then read as `needsYou`: a card that moved between "Running"
 * and "Your move" on every pause in a sentence, which is what was reported. Nothing had
 * been submitted and no turn had begun.
 *
 * The honest question is whether a TURN is running, and the app already records that in
 * two places, both set by `beginRun` and neither set by a bare keystroke: `runSince`
 * (the turn's clock) and `turnPending` (there is something worth telling you about when
 * it next goes quiet). `busyUntil` is the third and strongest - the CLI's own footer
 * saying it is running - and covers a turn this app never saw typed.
 *
 * Anything else keeps the status it had, so a pane being typed into stays exactly where
 * it is in the list until the return is pressed.
 */
export function outputIsWork(t: {
  runSince?: number
  turnPending: boolean
  busyUntil: number
  now: number
}): boolean {
  return Boolean(t.runSince) || t.turnPending || t.busyUntil > t.now
}

export function fleetState(s: FleetPane): FleetState {
  if (s.status === 'exited') return 'exited'
  // A rung bell outranks everything a live process could be doing: the CLI is asking a
  // question, and it can ask one mid-turn.
  if (s.bell) return 'needsYou'
  // Checked before `working`, because a stalled pane IS working as far as the pty knows -
  // that is exactly what makes it worth a row of its own.
  if (s.stalledSince !== undefined) return 'stalled'
  if (s.status === 'working') return 'working'
  if (s.status === 'starting') return 'starting'
  return s.engaged ? 'needsYou' : 'ready'
}

export function fleetRow(s: FleetPane): FleetRow {
  const state = fleetState(s)
  const since =
    state === 'stalled'
      ? s.stalledSince
      : state === 'working'
        ? (s.runSince ?? s.lastOutput)
        : state === 'needsYou'
          ? s.lastOutput
          : state === 'starting'
            ? s.createdAt
            : undefined
  return {
    state,
    label:
      state === 'exited' && s.exitCode
        ? `exited (${s.exitCode})`
        : state === 'working' && s.job
          ? `running ${s.job}`
          : LABEL[state],
    motion: MOTION[state],
    since,
    rank: RANK[state]
  }
}

/**
 * The order the rows are drawn in.
 *
 * By state, and then by the order the caller handed them in - which is the order the
 * sidebar numbers them, so pane 1 is above pane 2 inside every group and Ctrl+N matches
 * what is on screen.
 *
 * It used to break the tie on `since`, oldest first, which reads well and is wrong: the
 * clock a `needsYou` row counts from is `lastOutput`, and a `working` row falls back to
 * the same field, so the sort key MOVED every time a pane painted. Eight panes printing
 * is eight keys changing a few times a second, and the rows swapped places under the
 * pointer - "sessions keep moving up or down randomly". A list whose order is only
 * settled while nothing is happening cannot be pointed at, and the age it was sorting by
 * is on each row's own clock anyway.
 */
export function fleetOrder<T extends FleetPane & { id: string }>(sessions: T[]): T[] {
  const rows = new Map(sessions.map((s) => [s.id, fleetRow(s)]))
  const at = new Map(sessions.map((s, i) => [s.id, i]))
  return [...sessions].sort((a, b) => {
    const ra = rows.get(a.id)!
    const rb = rows.get(b.id)!
    if (ra.rank !== rb.rank) return ra.rank - rb.rank
    return at.get(a.id)! - at.get(b.id)!
  })
}

/**
 * The screen in sections rather than one undifferentiated list.
 *
 * A flat sort already put the urgent rows first, but it made every row LOOK the same, so
 * the reader still read all of them to find where the urgent ones stopped. A heading is
 * the answer to that: everything under "Your move" wants a person, and everything under
 * anything else does not, so the reading can stop at the first boundary. Sections with
 * nobody in them are not drawn - an empty "Ended" heading is a line of chrome saying
 * nothing.
 */
export interface FleetSection<T = Session> {
  key: 'yourMove' | 'running' | 'idle' | 'ended'
  title: string
  sessions: T[]
}

const SECTION_OF: Record<FleetState, FleetSection['key']> = {
  needsYou: 'yourMove',
  stalled: 'yourMove',
  working: 'running',
  starting: 'running',
  ready: 'idle',
  exited: 'ended'
}

const SECTION_TITLE: Record<FleetSection['key'], string> = {
  yourMove: 'Your move',
  running: 'Running',
  idle: 'Ready',
  ended: 'Ended'
}

export function fleetSections<T extends FleetPane & { id: string }>(sessions: T[]): FleetSection<T>[] {
  const ordered = fleetOrder(sessions)
  const out: FleetSection<T>[] = (['yourMove', 'running', 'idle', 'ended'] as const).map((key) => ({
    key,
    title: SECTION_TITLE[key],
    sessions: []
  }))
  for (const s of ordered) out.find((g) => g.key === SECTION_OF[fleetState(s)])!.sessions.push(s)
  return out.filter((g) => g.sessions.length > 0)
}

/**
 * The one line of terminal under a row: what the pane actually said last.
 *
 * This is the difference between "waiting for you" and knowing WHY it is waiting -
 * the CLI's question, its last result line, the error it stopped on - without opening
 * the pane. The lines come from xterm's own buffer (the caller reads them; this stays
 * windowless and testable), bottom up, and most of what sits at the bottom of an agent
 * CLI is furniture: the frame of its drawn input box, a bare prompt char, a spinner, a
 * rule. A line made only of that is skipped; the first line with words in it wins. The
 * frame's own edges are stripped so `│ text │` reads as its text.
 */
const FRAME_CHARS = /^[\s─-╿▀-▟⠀-⣿·•~✻✽✳✶✢*+=_,.…‥⋯>❯›|\\/-]*$/
export function previewFrom(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let l = lines[i]
    if (!l) continue
    l = l.replace(/^[\s│┃║▏]+/, '').replace(/[\s│┃║▕]+$/, '')
    l = l.replace(/\s+/g, ' ').trim()
    if (!l || FRAME_CHARS.test(l)) continue
    return l.length > 160 ? `${l.slice(0, 159)}…` : l
  }
  return null
}

/** How many rows want a person right now - the number the button wears. */
export function fleetWaiting(sessions: FleetPane[]): number {
  return sessions.filter((s) => {
    const st = fleetState(s)
    return st === 'needsYou' || st === 'stalled'
  }).length
}

export interface Density {
  /** 0-1, how wide the whole bar is drawn - log-scaled, see below */
  weight: number
  /** 0-1 of the drawn bar, the two ends always summing to 1 when there is anything */
  added: number
  removed: number
  total: number
}

/**
 * How much this pane has changed, as one bar.
 *
 * Linear rather than log would make every ordinary diff invisible: 40 lines beside one
 * 3,000-line refactor is 1.3% of the bar, which is the same picture as no changes at all.
 * The log holds a 20-line change at about a third of the width and a 2,000-line one at
 * full, which is the range where "a bit" and "a lot" are the answer anyone wants.
 */
export function density(added: number, removed: number): Density {
  const total = added + removed
  if (total <= 0) return { weight: 0, added: 0, removed: 0, total: 0 }
  const weight = Math.min(1, Math.log10(total + 1) / Math.log10(2000))
  return { weight, added: added / total, removed: removed / total, total }
}

/**
 * The one line of git under a row, or null when git has nothing to say.
 *
 * Written as a sentence rather than a row of counters because the counters are already
 * on the badge in the pane header; what this screen is for is reading eight panes at once
 * without decoding eight sets of arrows.
 */
export function gitLine(info: GitInfo | null | undefined): string | null {
  if (!info) return null
  const bits: string[] = []
  if (info.dirty) bits.push(`${info.dirty} changed`)
  if (info.ahead) bits.push(`${info.ahead} to push`)
  if (info.behind) bits.push(`${info.behind} to pull`)
  if (!bits.length) return 'clean'
  return bits.join(' · ')
}
