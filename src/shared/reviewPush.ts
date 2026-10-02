// A finished chat that needs the person is ONE push on their phone (TaskDriver notify),
// from either desk. `main/reviews.ts` asks this file at every Review notice and posts.
//
// Narrow on purpose: of ~70 rows a day closing into Review, ~15 need a person (measured
// 2026-10-02, Mac 475 + PC 53 rows in 7 days). Only a decision, a block, or a step the
// person owns pushes; never one they already looked at or marked reviewed, never one whose
// opener collects the summary (it reports the steps itself), never the other desk's copy.

import { replyPersonSteps } from './doneClose'
import { pushPayload, type PushPayload } from './limitWave'
import type { ReviewRecord } from './reviews'

/** A Review row with the time its push landed. Not part of the row's duplicate digest. */
export type PushedReview = ReviewRecord & { pushedAt?: string }

export interface ReviewPushContext {
  /** The pane was looked at after its turn ended (`doneVerdict().read`). */
  read: boolean
  /** The pane that opened this one: its summary and steps go there. */
  opener?: string
  machine: 'PC' | 'Mac'
  /** This desk's name in the dedupe key, asked only for a row that pushes. */
  host: () => string
}

const TITLE_CHARS = 140
const LINE_CHARS = 200

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)
const folderName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

/** The report's first line of prose: what a decision or a block is about. */
function firstLine(report: string): string {
  const line = report
    .split('\n')
    .map((l) => l.replace(/^\s*(#+|[-*>]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim())
    .find(Boolean)
  return line ? clip(line, LINE_CHARS) : ''
}

/** TaskDriver dedupes on this, so one row is one push however often it is sent. */
export function reviewPushKey(host: string, id: string): string {
  return `paneforge-review:${host}:${id}`
}

/** The push this Review row earns, or null when it earns none. */
export function reviewPush(record: PushedReview, ctx: ReviewPushContext): PushPayload | null {
  if (!record.notify || record.reviewedAt || record.pushedAt || record.origin || ctx.read || ctx.opener) return null
  const steps = replyPersonSteps(record.report)
  let title: string
  let lines: string[]
  if (record.kind === 'decision' || record.kind === 'blocked') {
    title = `${record.kind === 'decision' ? 'Decision for you' : 'Blocked'}: ${record.title}`
    lines = [firstLine(record.report), ...steps.map((s) => `- ${s}`)].filter(Boolean)
  } else if (steps.length) {
    title = `Needs you: ${steps[0]}`
    lines = steps.slice(1).map((s) => `- ${s}`)
  } else return null
  const body = [`${folderName(record.cwd)} - ${record.title} (${ctx.machine})`, ...lines].join('\n')
  return pushPayload(clip(title, TITLE_CHARS), body, reviewPushKey(ctx.host(), record.id))
}

export const PUSH_TRIES = 3
/** The waits before the second and the third try. */
export const PUSH_RETRY_MS = [10_000, 60_000] as const

export interface PushDeliveryDeps {
  post(payload: PushPayload): Promise<boolean>
  wait(ms: number): Promise<void>
  /** The row as it is on disk now: when its push landed, if it has. */
  pushedAt(id: string): string | undefined
  /** Write `pushedAt` onto the row as it is on disk now. */
  markPushed(id: string, at: string): void
  /** One line per attempt to `phone-push.log`: title, key, ok/failed. Never the token. */
  log(line: string): void
  now(): Date
}

const inFlight = new Set<string>()

/** Post one row's push: up to three tries, `pushedAt` written once one lands. */
export async function deliverReviewPush(
  id: string,
  payload: PushPayload,
  d: PushDeliveryDeps
): Promise<'sent' | 'already' | 'in-flight' | 'failed'> {
  if (inFlight.has(id)) return 'in-flight'
  if (d.pushedAt(id)) return 'already'
  inFlight.add(id)
  try {
    for (let n = 1; n <= PUSH_TRIES; n++) {
      if (n > 1) await d.wait(PUSH_RETRY_MS[n - 2])
      let ok = false
      try {
        ok = await d.post(payload)
      } catch {
        ok = false
      }
      d.log(`${d.now().toISOString()} ${ok ? 'ok' : 'failed'} try ${n}/${PUSH_TRIES} ${payload.dedupe_key} ${JSON.stringify(payload.title)}`)
      if (ok) {
        d.markPushed(id, d.now().toISOString())
        return 'sent'
      }
    }
    d.log(`${d.now().toISOString()} gave up after ${PUSH_TRIES} tries ${payload.dedupe_key}`)
    return 'failed'
  } finally {
    inFlight.delete(id)
  }
}
