// Exact-session, current-context telemetry. Never use lifetime token spending.
import { closeSync, openSync, readSync, fstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { codexTranscriptPath, transcriptPath } from './transcripts'
import type { ContextUsage } from '../shared/types'

const MAX_TAIL = 1024 * 1024
const FRESH_MS = 5 * 60_000
export function codexContextUsage(cwd: string, id: string, now = Date.now()): ContextUsage | null {
  const file = codexTranscriptPath(cwd, id)
  if (!file) return null
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    const start = Math.max(0, stat.size - MAX_TAIL)
    const bytes = Buffer.alloc(stat.size - start)
    const count = readSync(fd, bytes, 0, bytes.length, start)
    let text = bytes.toString('utf8', 0, count)
    if (start) text = text.slice(text.indexOf('\n') + 1)
    // A writer can be appending its last JSONL record during this read.
    text = text.slice(0, text.lastIndexOf('\n') + 1)
    let last: ContextUsage | null = null
    let model: string | undefined
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: any
      try { row = JSON.parse(line) } catch { return null }
      if (row.type === 'turn_context') {
        const next = row.payload?.model
        if (typeof next !== 'string' || !next) { last = null; model = undefined; continue }
        if (model !== next) last = null
        model = next
      }
      if (row.type === 'compacted' || (row.type === 'event_msg' && /compact/i.test(String(row.payload?.type ?? '')))) {
        last = null
        continue
      }
      if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue
      const info = row.payload.info
      // Rate-limit-only updates carry null info and do not replace token telemetry.
      if (info == null) continue
      const used = info.last_token_usage?.total_tokens
      const window = info.model_context_window
      const at = Date.parse(row.timestamp || '')
      if (!model || !Number.isSafeInteger(used) || !Number.isSafeInteger(window) ||
          used < 0 || window <= 0 || used > window || !Number.isFinite(at) || at > now) {
        last = null
        continue
      }
      const percent = Math.round(used / window * 100)
      last = { used, window, at, model, percent,
        advisory: percent >= 80 ? 'boundary' : percent >= 60 ? 'prepare' : undefined }
    }
    return last && now - last.at <= FRESH_MS ? last : null
  } catch { return null } finally { if (fd >= 0) closeSync(fd) }
}

/** Proof is a user-message row in this exact new conversation, not a sent Enter. */
export function receivedContinuation(cwd: string, id: string, agent: string, digest: string): boolean {
  const file = agent === 'codex' ? codexTranscriptPath(cwd, id) : agent === 'claude' ? transcriptPath(cwd, id) : null
  if (!file) return false
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size, start = Math.max(0, size - MAX_TAIL)
    const bytes = Buffer.alloc(size - start)
    const n = readSync(fd, bytes, 0, bytes.length, start)
    let text = bytes.toString('utf8', 0, n)
    if (start) text = text.slice(text.indexOf('\n') + 1)
    for (const line of text.split('\n')) {
      let row: any
      try { row = JSON.parse(line) } catch { continue }
      const message = agent === 'codex' && row.type === 'response_item' ? row.payload : agent === 'claude' && row.type === 'user' && row.sessionId === id ? row.message : null
      if (!message || (agent === 'codex' && (message.type !== 'message' || message.role !== 'user'))) continue
      const body = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
        ? message.content.filter((block: any) => block.type === 'input_text' || block.type === 'text').map((block: any) => block.text ?? '').join('\n') : ''
      if (createHash('sha256').update(body.trim()).digest('hex') === digest) return true
    }
    return false
  } catch { return false } finally { if (fd >= 0) closeSync(fd) }
}
