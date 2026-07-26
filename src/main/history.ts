// Searchable transcripts. Every pane's output is appended to a file so that
// "what did Codex say about the migration last Tuesday" is answerable after the
// pane is long gone, and so any past session can be relaunched in its folder.
//
// Storage is one .log (raw terminal bytes) plus one .json (metadata) per session
// under userData/history. Plain files on purpose: greppable, deletable, and no
// database to corrupt.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { HistoryEntry, HistoryHit, Session } from '../shared/types'

/** Stop one runaway pane filling the disk; the newest output is what matters. */
const MAX_LOG_BYTES = 8 * 1024 * 1024
/** Buffer writes so a chatty agent does not cause a syscall per keystroke echo. */
const FLUSH_MS = 1500

let enabled = true
const pending = new Map<string, string>()
const sizes = new Map<string, number>()
let flushTimer: NodeJS.Timeout | null = null

function dir(): string {
  const d = join(app.getPath('userData'), 'history')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

const logFile = (id: string): string => join(dir(), `${id}.log`)
const metaFile = (id: string): string => join(dir(), `${id}.json`)

export function setHistoryEnabled(on: boolean): void {
  enabled = on
  if (!on) pending.clear()
}

/** Called when a session starts (or restarts) so the metadata matches the pane. */
export function recordStart(s: Session): void {
  if (!enabled) return
  try {
    const entry: HistoryEntry = {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      agent: s.agent,
      model: s.model,
      startedAt: s.createdAt,
      bytes: 0
    }
    writeFileSync(metaFile(s.id), JSON.stringify(entry), 'utf8')
  } catch {
    /* unwritable profile - history is a nicety, never fatal */
  }
}

export function recordData(id: string, chunk: string): void {
  if (!enabled) return
  if ((sizes.get(id) ?? 0) > MAX_LOG_BYTES) return
  pending.set(id, (pending.get(id) ?? '') + chunk)
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_MS)
    flushTimer.unref?.()
  }
}

export function recordEnd(id: string): void {
  flush()
  writeEnd(id)
}

/**
 * Close out every session in one pass.
 *
 * recordEnd() flushes the pending buffers before each write, so tearing eight panes
 * down on the way out meant eight full flushes of the same map. On the quit path that
 * is the difference between the app being gone and the app being gone in a moment.
 */
export function endAll(ids: string[]): void {
  flush()
  for (const id of ids) writeEnd(id)
}

function writeEnd(id: string): void {
  try {
    const raw = readFileSync(metaFile(id), 'utf8')
    const entry = JSON.parse(raw) as HistoryEntry
    entry.endedAt = Date.now()
    entry.bytes = sizes.get(id) ?? entry.bytes
    writeFileSync(metaFile(id), JSON.stringify(entry), 'utf8')
  } catch {
    /* no metadata (history was off when it started) */
  }
  sizes.delete(id)
}

export function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const [id, text] of pending) {
    try {
      appendFileSync(logFile(id), text, 'utf8')
      sizes.set(id, (sizes.get(id) ?? 0) + Buffer.byteLength(text))
    } catch {
      /* keep going: one bad file must not stall the others */
    }
  }
  pending.clear()
}

export function list(): HistoryEntry[] {
  try {
    return readdirSync(dir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const e = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as HistoryEntry
          const log = logFile(e.id)
          e.bytes = existsSync(log) ? statSync(log).size : 0
          return e
        } catch {
          return null
        }
      })
      .filter((e): e is HistoryEntry => Boolean(e) && Boolean(e!.id))
      .sort((a, b) => b.startedAt - a.startedAt)
  } catch {
    return []
  }
}

/** Substring search across every transcript. Case-insensitive, newest first. */
export function search(query: string, limit = 200): HistoryHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  flush()
  const hits: HistoryHit[] = []
  for (const entry of list()) {
    if (hits.length >= limit) break
    const file = logFile(entry.id)
    if (!existsSync(file)) continue
    let text: string
    try {
      text = strip(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.toLowerCase().includes(q)) continue
      hits.push({
        id: entry.id,
        title: entry.title,
        cwd: entry.cwd,
        agent: entry.agent,
        startedAt: entry.startedAt,
        line: line.trim().slice(0, 300)
      })
      if (hits.length >= limit) break
    }
  }
  return hits
}

export function read(id: string): string {
  flush()
  try {
    return strip(readFileSync(logFile(id), 'utf8'))
  } catch {
    return ''
  }
}

export function remove(id: string): void {
  for (const f of [logFile(id), metaFile(id)]) {
    try {
      rmSync(f, { force: true })
    } catch {
      /* already gone */
    }
  }
}

/** Delete transcripts older than `days`; 0 means keep forever. */
export function prune(days: number): void {
  if (!days || days <= 0) return
  const cutoff = Date.now() - days * 86_400_000
  for (const e of list()) if (e.startedAt < cutoff) remove(e.id)
}

/**
 * Terminal output is full of escape sequences and cursor moves. Searching raw
 * bytes would miss "npm install" when the CLI painted it in colour, so strip the
 * control codes for search and for the transcript viewer.
 */
function strip(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (window titles)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colour, cursor)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>c]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}
