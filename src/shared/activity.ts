// What the app did on its own, kept so somebody can read it afterwards.
//
// Everything in the resource ladder already writes its reasoning somewhere: the idle
// sweep to `reclaim.log`, the automatic /clear to `autoclear-app.log`, a rename to a
// three-second card in the corner. All of those are either a file under userData or a
// card that is gone in seconds, so the question Robert actually asks - "what just
// happened to my pane, and when" - had no answer on screen at all.
//
// This is that answer: a short list of things the app decided by itself, newest first,
// each with the plain sentence and the moment. It is a READING, never a control - the
// list cannot close, move or clear anything, and nothing in it is a countdown. Anything
// still deciding is drawn as a card in the corner where it can be stopped.
//
// One entry per thing that HAPPENED. A sweep that only picked a pane (`armed`) is not an
// entry: the countdown card is already on screen saying so, and a line saying "about to
// close" that is then kept open is a lie left on a list nobody re-reads.

/** What kind of thing happened. The word on the row's left comes from `KIND_WORDS`. */
export type ActivityKind =
  | 'closed'
  | 'moved'
  | 'slept'
  | 'cleared'
  | 'named'
  | 'trimmed'
  | 'updated'
  | 'recovered'
  | 'stopped'

export interface ActivityEntry {
  /** Unique per entry, so a list can be keyed without using the index. */
  id: string
  /** When it happened, epoch ms. */
  at: number
  kind: ActivityKind
  /** What it happened TO: `(3) taskdriver`. The verb is the row's `KIND_WORDS`, not this. */
  what: string
  /** Why, if there is a reason worth a second line. Optional on purpose. */
  why?: string
}

/**
 * How many are kept. Two days of a busy desk is well under this; the list exists to
 * answer "what happened in the last while", not to be an audit trail - `reclaim.log`
 * and `autoclear-app.log` are still the files to read when a week-old close matters.
 */
export const MAX_ACTIVITY = 120

/** The word drawn on the left of a row. Plain, never the code's own name for it. */
export const KIND_WORDS: Record<ActivityKind, string> = {
  closed: 'Closed',
  moved: 'Moved',
  slept: 'Asleep',
  cleared: 'Cleared',
  named: 'Renamed',
  trimmed: 'Trimmed',
  updated: 'Updated',
  recovered: 'Recovered',
  stopped: 'Stopped'
}

/**
 * Two entries that say the same thing this close together are one thing happening,
 * not two. A close writes its own line and the sweep that ordered it may write another.
 */
export const SAME_MS = 2500

/**
 * Add an entry, newest first, capped.
 *
 * Returns the SAME array when the entry is a duplicate, so a caller can compare by
 * reference and skip a write and a broadcast that would change nothing.
 */
export function addActivity(list: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  const dup = list.some(
    (x) => x.kind === entry.kind && x.what === entry.what && Math.abs(x.at - entry.at) < SAME_MS
  )
  if (dup) return list
  return [entry, ...list].slice(0, MAX_ACTIVITY)
}

/** How many entries arrived since the list was last looked at. */
export function unreadCount(list: ActivityEntry[], seenAt: number): number {
  return list.filter((x) => x.at > seenAt).length
}

/**
 * Turn a `reclaim.log` line into an entry, or nothing.
 *
 * The sweep's own vocabulary (`armed`, `event`, `log`) stops here: everything past this
 * function is a sentence. `armed` is deliberately nothing - see the note at the top.
 */
export function activityFromReclaim(
  raw: Record<string, unknown>,
  at = Date.now()
): ActivityEntry | null {
  const event = typeof raw.event === 'string' ? raw.event : ''
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'a pane'
  const idleMin = typeof raw.idleMin === 'number' ? raw.idleMin : undefined
  const quiet = idleMin && idleMin > 0 ? `it had been quiet ${idleMin} min` : undefined
  // The row already carries the verb in `KIND_WORDS`, so the sentence must not repeat it:
  // "Closed closed (3) taskdriver" was the first thing this drew on a real desk.
  if (event === 'closed') return entry('closed', name, quiet ?? 'nothing was running in it', at)
  if (event === 'slept') return entry('slept', name, quiet, at)
  if (event === 'moved') {
    const to = typeof raw.to === 'string' && raw.to ? ` to ${raw.to}` : ''
    return entry('moved', `${name}${to}`, 'this machine was running out of memory', at)
  }
  if (event === 'trimmed') return entry('trimmed', name, 'to give the machine memory back', at)
  return null
}

/** Build an entry with an id nothing else will produce. */
export function entry(kind: ActivityKind, what: string, why: string | undefined, at = Date.now()): ActivityEntry {
  return { id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at, kind, what, why }
}
