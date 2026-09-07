// What has HAPPENED to a copy of a project, in order, rather than what is true about it now.
//
// The lane strip (LaneStrip.tsx, laneWords.ts) draws a copy's present state: somebody has
// it, its work is finished, its work will not go in. That answers "what should I do right
// now" and cannot answer the question actually asked of a desk running eight chats at once
// - "what happened to that copy?". A copy that was stuck for an hour, was taken over by
// another chat, was settled and went out in v0.8.200 leaves no trace at all: every one of
// those facts was a boolean that flipped back, and the only place any of it was ever said
// was a sentence a hook printed into whichever chat sent the next prompt.
//
// So this is the log. It is built by DIFFING the readings the app already takes of the lane
// ledger - no new file is written by the engine, no git is spawned, nothing in
// scripts/lane.mjs changes - and it is a READING like shared/activity.ts: no row does
// anything when pressed, because everything in it has already happened.
//
// The reference for the shape is block/buzz's activity feed (Apache-2.0, dossier at
// claude-memory/toolstash/repo-dossiers/block--buzz.md): an append-only ordered event log
// with a stable key per event, deduplicated on that key, ordered by the moment rather than
// by arrival, so a late or replayed reading lands in the right place instead of at the top.

import type { LaneBoard, LaneBoardEntry } from './types'

/**
 * What kind of thing happened to a copy.
 *
 * Every one of these is a fact somebody can act on, and every one of them is invisible five
 * seconds later in the strip. A state that is still true is NOT in this list: "waiting for
 * the release" is drawn on the row, live, where the reason can change - a line here saying
 * it started waiting would be re-read tomorrow as though it still were.
 */
export type LaneEventKind =
  | 'taken'
  | 'given'
  | 'ready'
  | 'stuck'
  | 'unstuck'
  | 'shipped'
  | 'gone'

/** The word drawn on the left of a row. Plain: never `lane`, `merge`, `conflict`, `trunk`. */
export const LANE_EVENT_WORDS: Record<LaneEventKind, string> = {
  taken: 'Started',
  given: 'Free',
  ready: 'Finished',
  stuck: 'Stuck',
  unstuck: 'Settled',
  shipped: 'Went out',
  gone: 'Abandoned'
}

export interface LaneEvent {
  /**
   * Stable and derived, never random: the same happening seen twice - two windows, a
   * reading replayed after a restart, a seed that overlaps a live diff - is one row.
   * `<repo>|<lane>|<device>|<kind>|<at>`.
   */
  id: string
  /** When it happened, epoch ms. Seeded events carry the REAL moment, not the read. */
  at: number
  /** The main checkout of the project this copy belongs to. */
  repo: string
  /** The slot as the engine spells it (`main`, `a`...). Never drawn - `what` is. */
  lane: string
  /** The desk, when the reading named one. Two desks can hold one slot at once. */
  device: string | null
  kind: LaneEventKind
  /** The copy in plain words, as the strip would head its row: `PaneForge copy 3`. */
  what: string
  /** The chat's own name, when it had left one behind. */
  chat?: string
  /** The second line, when there is one worth reading. */
  why?: string
}

/**
 * How many are kept, across every project.
 *
 * A busy desk writes a handful a day; this is a fortnight of one. It is not an audit trail
 * - `<repo>/.git/paneforge-lanes.json` and the engine's own output are still what a
 * month-old release is reconstructed from.
 */
export const MAX_LANE_EVENTS = 200

/**
 * Two events this close together saying the same thing are one thing happening.
 *
 * The same value shared/activity.ts uses, for the same reason: a change is seen by the
 * sweep that caused it and by the poll that follows it.
 */
export const SAME_MS = 2500

/** The event's stable key. Exported because the seed and the diff must agree on it. */
export function laneEventId(e: Omit<LaneEvent, 'id'>): string {
  return `${e.repo}|${e.lane}|${e.device ?? ''}|${e.kind}|${e.at}`
}

/**
 * Add an event, keeping the list ordered newest first.
 *
 * Ordered by the MOMENT, not by arrival. A seeded event is often hours older than
 * everything already in the list, and putting it on top - which is what an append would do
 * - would make the log say the copy got stuck after it was settled. Returns the SAME array
 * when nothing was added, so a caller can compare by reference and skip a write.
 */
export function addLaneEvent(list: LaneEvent[], event: LaneEvent): LaneEvent[] {
  const dup = list.some(
    (x) =>
      x.id === event.id ||
      (x.repo === event.repo &&
        x.lane === event.lane &&
        x.device === event.device &&
        x.kind === event.kind &&
        Math.abs(x.at - event.at) < SAME_MS)
  )
  if (dup) return list
  const next = [...list, event].sort((a, b) => b.at - a.at)
  return next.length > MAX_LANE_EVENTS ? next.slice(0, MAX_LANE_EVENTS) : next
}

/** Everything about one copy, newest first. */
export function eventsFor(list: LaneEvent[], repo: string, lane: string): LaneEvent[] {
  return list.filter((e) => e.repo === repo && e.lane === lane)
}

/** The row key a reading is indexed by: two desks can hold one slot of one repo at once. */
function keyOf(repo: string, lane: LaneBoardEntry): string {
  return `${repo}|${lane.lane}|${lane.device ?? ''}`
}

/**
 * How a copy is named in a row, given by the caller.
 *
 * The plain name of a copy lives in `shared/place.ts` (`describePlace`), which this file
 * deliberately does not reach for: the name is decided once, by whoever is drawing, and
 * frozen INTO the event. A copy renamed or deleted next week must not silently rewrite
 * what a row said happened to it in August.
 */
export type NameCopy = (repo: string, lane: LaneBoardEntry) => string

/**
 * The events between two readings of one project's lanes.
 *
 * `prev` missing means this project has never been read in this run. That is NOT the same
 * as nothing having happened, and it is not an excuse to invent: a first reading emits only
 * what carries a REAL moment of its own - a disagreement's own start, and the lanes the
 * last release names - and starts watching everything else from now. Eight rows saying "a
 * chat started working in it" stamped with the moment the app launched would be eight lies
 * on a list nobody can check.
 */
export function laneChanges(
  prev: LaneBoard | undefined,
  next: LaneBoard,
  nameCopy: NameCopy,
  now = Date.now()
): LaneEvent[] {
  const out: LaneEvent[] = []
  const make = (
    lane: LaneBoardEntry,
    kind: LaneEventKind,
    at: number,
    why?: string
  ): void => {
    const base = {
      at: Math.min(at, now),
      repo: next.repo,
      lane: lane.lane,
      device: lane.device ?? null,
      kind,
      what: nameCopy(next.repo, lane),
      ...(lane.chatTitle ? { chat: lane.chatTitle } : {}),
      ...(why ? { why } : {})
    }
    out.push({ id: laneEventId(base), ...base })
  }

  const before = new Map<string, LaneBoardEntry>()
  for (const l of prev?.lanes ?? []) before.set(keyOf(next.repo, l), l)

  for (const lane of next.lanes) {
    const was = before.get(keyOf(next.repo, lane))

    // A disagreement carries its own start, so it is the one thing a FIRST reading can say
    // truthfully - and it is the one worth saying, because a copy left out of every release
    // is exactly what the strip exists to surface and what nothing remembers afterwards.
    if (lane.conflicted && !was?.conflicted) {
      make(lane, 'stuck', lane.conflictSince ?? now, lane.conflictDetail)
    }
    if (!lane.conflicted && was?.conflicted) make(lane, 'unstuck', now)

    // Everything below needs a previous reading: without one there is no moment to stamp,
    // only the moment somebody opened the app.
    if (!was) continue

    if (lane.held && !was.held) make(lane, 'taken', now)
    // A hand-over is one event, not a give and a take: the slot never stopped being held,
    // a different chat is simply in it now. Saying "nobody is using it" about a copy that
    // was never free for an instant is the false half of that pair.
    else if (lane.held && was.held && lane.session && was.session && lane.session !== was.session) {
      make(lane, 'taken', now)
    } else if (!lane.held && was.held) make(lane, 'given', now)

    if (lane.gone && !was.gone) make(lane, 'gone', now)
    if (lane.ready && !was.ready) make(lane, 'ready', now)
  }

  // A row that was in the last reading and is not in this one. The engine leaves an empty
  // slot out entirely, so this is how a copy being given back is usually seen - but only
  // when the PROJECT is still being read. A whole project going quiet (its last chat closed,
  // so nothing polls it any more) would otherwise write "nobody is using it" against every
  // copy at once, which is a sentence about the app, not about the work.
  for (const [key, was] of before) {
    if (next.lanes.some((l) => keyOf(next.repo, l) === key)) continue
    if (!was.held && !was.conflicted) continue
    const base = {
      at: now,
      repo: next.repo,
      lane: was.lane,
      device: was.device ?? null,
      kind: 'given' as const,
      what: nameCopy(next.repo, was),
      ...(was.chatTitle ? { chat: was.chatTitle } : {})
    }
    out.push({ id: laneEventId(base), ...base })
  }

  // What went out. `lastShip` names the copies whose work was in the release, and carries
  // the moment it happened - so this is truthful on a first reading too, and it is the only
  // place a copy's work is ever tied to a version number.
  const ship = next.lastShip
  if (ship && (!prev?.lastShip || prev.lastShip.at !== ship.at)) {
    for (const slot of ship.lanes) {
      const lane =
        next.lanes.find((l) => l.lane === slot) ??
        prev?.lanes.find((l) => l.lane === slot) ??
        ({ lane: slot, dir: next.repo, branch: '', device: next.device } as unknown as LaneBoardEntry)
      // A release the engine recorded without a version - a merge-mode repo like this one
      // ships work without cutting one - says the true half rather than `in null`.
      make(lane, 'shipped', ship.at, ship.version ? `in ${ship.version}` : undefined)
    }
  }

  return out
}

/**
 * The sentence on a row, after the verb in `LANE_EVENT_WORDS`.
 *
 * The verb carries the kind, so this must not repeat it - "Stuck · two chats changed the
 * same lines" reads as one sentence; "Stuck · it got stuck" reads as a bug.
 */
export function laneEventLine(e: LaneEvent): string {
  switch (e.kind) {
    case 'taken':
      return e.chat ? `a chat called "${e.chat}"` : 'a chat is working in it'
    case 'given':
      return 'nobody is working in it'
    case 'ready':
      return 'its work is waiting to go out'
    case 'stuck':
      return e.why ? `two chats changed ${e.why}` : 'two chats changed the same lines'
    case 'unstuck':
      return 'somebody picked between the two versions'
    case 'shipped':
      return e.why ?? 'its work went out'
    case 'gone':
      return 'the chat that had it never came back'
  }
}
