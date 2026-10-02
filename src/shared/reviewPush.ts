// The phone push for a finished chat that left something for the person (Robert,
// 2026-10-02: "I should get notifs now things are done. Eg draft ready for me but from
// paneforge not from the email agent").
//
// Pure: `main/reviews.ts` decides WHEN (the moment the row's notice goes out, on either
// machine) and posts it through `main/limitWaves.ts` `postPush`; this file decides WHETHER
// and WHAT. `scripts/review-push-test.mjs` pins it.

import { replyPersonSteps } from './doneClose'
import { pushPayload, type PushPayload } from './limitWave'
import type { ReviewRecord } from './reviews'

/** The TaskDriver app's PaneForge tab (`taskdriver-mobile` `pushRouting.ts` `/paneforge`). */
export const REVIEW_PUSH_HREF = '/paneforge'

export type ReviewPush = PushPayload & { href: string; data: { reviewId: string; machine: 'mac' | 'pc'; paneNumber?: number } }

/** What is left for the person: a result's open steps, or a decision/blocker's first line. */
export function stepsForPerson(r: Pick<ReviewRecord, 'kind' | 'report'>): string[] {
  if (r.kind === 'decision' || r.kind === 'blocked') {
    const first = r.report.split('\n').map((l) => l.trim()).find(Boolean)
    return first ? [first] : []
  }
  // "Robert: read the draft" reads "For you: read the draft" - the push already says whose.
  return r.kind === 'result' ? replyPersonSteps(r.report).map((s) => s.replace(/^(?:\*\*)?(?:Robert|you)(?:\*\*)?\s*[:\-\u2013\u2014]\s*/i, '')) : []
}

const base = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/**
 * One push per row, or null. Null for: a row that asked for no notice, a row already reviewed
 * or already pushed, a copy of another machine's row (the owner pushes it), a shell, a chat
 * the person was looking at when it finished (`looked`), a chat another pane opened and
 * collects the summary of (`opener` reports its steps itself, one push not two), and a result with nothing left for
 * the person - a finished chat with nothing to do is a Review row, not a buzz in a pocket.
 */
export function reviewPush(
  r: ReviewRecord & { pushSentAt?: string },
  machine: 'mac' | 'pc',
  looked = false,
  opener?: string
): ReviewPush | null {
  if (!r.notify || r.reviewedAt || r.pushSentAt || r.origin || looked || opener || r.provider === 'shell') return null
  const steps = stepsForPerson(r)
  if (!steps.length) return null
  const project = base(r.cwd)
  const title = r.kind === 'blocked' ? `Stuck, needs you: ${steps[0]}` : r.kind === 'decision' ? `Your call: ${steps[0]}` : `For you: ${steps[0]}`
  const chat = `${r.paneNumber ? `Chat ${r.paneNumber}` : 'A chat'} on the ${machine === 'pc' ? 'PC' : 'Mac'} (${project}, "${r.title}")`
  const more = steps.slice(1)
  const body = `${chat} finished.${more.length ? ` Also for you: ${more.join('; ')}.` : ''}`
  return {
    ...pushPayload(title, body, `paneforge-review-${machine}-${r.id}`),
    href: REVIEW_PUSH_HREF,
    data: { reviewId: r.id, machine, ...(r.paneNumber ? { paneNumber: r.paneNumber } : {}) }
  }
}
