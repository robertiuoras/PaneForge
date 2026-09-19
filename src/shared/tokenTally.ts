/**
 * What the agents on this machine have spent, in tokens, today and over the week.
 *
 * The number exists so a presence row can say it, and nothing else reads it. It is
 * counted from the transcripts the CLIs already write - no hook, no wrapper, no
 * cooperation from the agent - which is the same reason `promptArchive.ts` reads
 * keystrokes rather than asking Claude Code for a hook: a per-CLI integration goes
 * stale and is silent when it does.
 *
 * The one thing measured here that is not obvious: Claude Code writes the SAME
 * assistant message several times while it streams, each copy carrying the finished
 * usage block. Three rows, one id, one spend (measured 2026-09-19 on a real
 * transcript: `msg_011CfAyw8AnjN4n3NffTQrzz` appeared three times with identical
 * usage a second apart). Counting rows rather than messages trebles the day.
 */

/** A message's spend, once. */
export interface TokenRow {
  /** epoch ms */
  at: number
  /** the message's own identity, for the dedupe */
  key: string
  tokens: number
}

/**
 * Everything the model was billed for, cache included.
 *
 * Cache reads are the bulk of a long session and leaving them out makes a heavy day
 * read as a light one, so the number is the total - the same total `ccusage` prints.
 */
function claudeTokens(u: Record<string, unknown>): number {
  const n = (k: string): number => {
    const v = u[k]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  }
  return (
    n('input_tokens') +
    n('output_tokens') +
    n('cache_creation_input_tokens') +
    n('cache_read_input_tokens')
  )
}

/**
 * One JSONL line from an agent's transcript, or null when it says nothing about spend.
 *
 * Both shapes are read here rather than in two modules because the caller walking the
 * disk does not care which CLI wrote a folder, and a row that parses as neither is a
 * row to skip rather than a file to give up on: a transcript is appended to while this
 * runs, so its last line is routinely half-written.
 */
export function readTokenRow(line: string): TokenRow | null {
  const text = line.trim()
  if (!text || text[0] !== '{') return null
  let row: Record<string, any>
  try {
    row = JSON.parse(text)
  } catch {
    return null
  }
  // Claude Code: one row per assistant message, usage on the message itself.
  const usage = row?.message?.usage
  if (usage && typeof usage === 'object') {
    const at = Date.parse(row.timestamp ?? '')
    const tokens = claudeTokens(usage)
    if (!Number.isFinite(at) || tokens <= 0) return null
    // `requestId` alone repeats across the streamed copies too, so either half is
    // enough; both are joined so a retry of the same message under a new request is
    // still counted once, which is what it cost.
    const key = String(row.message.id ?? row.requestId ?? `${at}:${tokens}`)
    return { at, key, tokens }
  }
  // Codex: a `token_count` event, whose `last_token_usage` is that turn's own spend.
  if (row?.type === 'event_msg' && row?.payload?.type === 'token_count') {
    const total = row.payload?.info?.last_token_usage?.total_tokens
    const at = Date.parse(row.timestamp ?? '')
    if (!Number.isFinite(at) || typeof total !== 'number' || !(total > 0)) return null
    return { at, key: `codex:${at}:${total}`, tokens: total }
  }
  return null
}

/** Local midnight, `days` days back. Local because a day is the user's day, not UTC's. */
export function dayStart(now: number, days = 0): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.getTime()
}

export interface TokenSpend {
  /** since local midnight */
  today: number
  /** since local midnight six days ago, so "this week" includes today */
  week: number
  /** when this was counted */
  at: number
}

export const NO_TOKEN_SPEND: TokenSpend = { today: 0, week: 0, at: 0 }

/** The window worth reading at all - anything older cannot reach either number. */
export function weekStart(now: number): number {
  return dayStart(now, 6)
}

/**
 * Sums rows into the two numbers, dropping repeats by key.
 *
 * Takes an iterable rather than an array: the walker hands over lines file by file and
 * a week of transcripts is not a list worth holding.
 */
export function tallyTokens(rows: Iterable<TokenRow>, now: number): TokenSpend {
  const start = weekStart(now)
  const midnight = dayStart(now)
  const seen = new Set<string>()
  let today = 0
  let week = 0
  for (const r of rows) {
    if (r.at < start || r.at > now + 60_000) continue
    if (seen.has(r.key)) continue
    seen.add(r.key)
    week += r.tokens
    if (r.at >= midnight) today += r.tokens
  }
  return { today, week, at: now }
}

/**
 * The number as a line of a presence says it: `1.2M`, `340k`, `912`.
 *
 * A raw `1483920` on a profile card is not read, it is skimmed past, and Discord gives
 * the line 128 characters for everything including the words around it.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
}
