/**
 * The pure reading behind the Review list: which finished sessions are worth showing, which
 * of those still need a person, and the few small words drawn on each row (a status, a first
 * line, a relative time). Kept out of the component so a plain node script can prove every
 * bucket without touching React or a window.
 */

import type { ReviewRecord } from './reviews'

/** Row shapes nobody asked for and that only clutter the list. */
export function visibleReviews(records: ReviewRecord[]): ReviewRecord[] {
  return records.filter((r) => {
    if (r.provider === 'shell') return false
    if (r.kind === 'closed' && !(r.prompt ?? '').trim()) return false
    if (/^\/\w+\s*$/.test((r.prompt ?? '').trim())) return false
    return true
  })
}

export type ReviewFilter = 'needs' | 'done' | 'all'

/** True when a person still has to look at this row. */
export function needsAttention(r: ReviewRecord): boolean {
  return r.attention === true || r.kind === 'blocked' || r.kind === 'decision'
}

export function filterReviews(records: ReviewRecord[], filter: ReviewFilter): ReviewRecord[] {
  if (filter === 'all') return records
  if (filter === 'needs') return records.filter(needsAttention)
  return records.filter((r) => !needsAttention(r))
}

/** The first line worth reading - blank leading lines dropped, nothing after it kept. */
export function firstLine(text: string): string {
  const lines = (text ?? '').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** The word on the right of a row. Never the raw `kind`/`attention` value. */
export function statusWord(r: Pick<ReviewRecord, 'kind' | 'attention'>): string {
  if (r.kind === 'closed') return 'Closed'
  if (r.kind === 'blocked') return 'Blocked'
  if (r.attention || r.kind === 'decision') return 'Needs you'
  return 'Done'
}

/**
 * `just now` / `5 min ago` / `3 h ago` / `yesterday` / `Sep 12` - the same day keeps hours,
 * the calendar day before that says `yesterday`, anything older is a date nobody has to do
 * arithmetic against.
 */
export function ago(at: number, now: number = Date.now()): string {
  const ms = now - at
  if (!(ms >= 0)) return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  const day = 24 * 3_600_000
  const startOfNow = new Date(now)
  startOfNow.setHours(0, 0, 0, 0)
  const startOfAt = new Date(at)
  startOfAt.setHours(0, 0, 0, 0)
  const dayDiff = Math.round((startOfNow.getTime() - startOfAt.getTime()) / day)
  if (dayDiff <= 0) return `${Math.floor(ms / 3_600_000)} h ago`
  if (dayDiff === 1) return 'yesterday'
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
