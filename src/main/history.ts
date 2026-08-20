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
// One stripper, not two: the live tee in `pipe.ts` needs the same rules a chunk at a
// time, and two copies of "what counts as an escape sequence" drift in exactly the way
// nobody notices - a transcript and its tee disagreeing about the same run.
import { stripAnsi as strip } from '../shared/ansi'
import { gistOf } from '../shared/gist'
import type { HistoryEntry, HistoryHit, Session } from '../shared/types'
import { firstAskIn } from './promptArchive'

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

/**
 * A prompt was submitted in this pane. The first one becomes the row's line in History.
 *
 * The FIRST rather than the latest on purpose: the opening ask is what a session was
 * about, and the twentieth is a follow-up inside it ("now do the same for the other file")
 * which reads as nothing at all once the session is closed and the context is gone.
 *
 * Written straight through rather than buffered like the transcript is: this is one small
 * JSON file per submitted prompt, it only ever grows a counter after the first one, and a
 * session whose app was killed must still have its line.
 */
export function noteAsk(id: string, prompt: string): void {
  if (!enabled) return
  const line = gistOf(prompt)
  if (!line) return
  try {
    const entry = JSON.parse(readFileSync(metaFile(id), 'utf8')) as HistoryEntry
    entry.asks = (entry.asks ?? 0) + 1
    if (!entry.gist) entry.gist = line
    writeFileSync(metaFile(id), JSON.stringify(entry), 'utf8')
  } catch {
    /* no metadata yet, or an unwritable profile: a note is a nicety, never fatal */
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
          // Not stored - a folder can come back, and a stale `gone` in a metadata file
          // would outlive the truth. One stat per row, next to the one already being made.
          e.gone = !e.cwd || !existsSync(e.cwd)
          return e
        } catch {
          return null
        }
      })
      .filter((e): e is HistoryEntry => Boolean(e) && Boolean(e!.id))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(backfill)
  } catch {
    return []
  }
}

/**
 * A line for a session that closed before the app recorded one.
 *
 * The prompt archive is the only other place on this machine that knows what was typed,
 * and it is enough for this: an ask carries the project it was typed in and when it was
 * first used, so the earliest one inside a session's own window is very probably its
 * opening ask. Very probably, not certainly - two panes open on one repo at once would
 * share, so the answer is marked as inferred and never written back to the metadata file.
 *
 * Deliberately NOT scraped from the transcript: measured across this machine's pane logs,
 * no recognisable prompt echo survives a redrawn composer, so anything read out of the
 * log would be a confident wrong sentence about which session to bring back.
 */
function backfill(e: HistoryEntry): HistoryEntry {
  if (e.gist || !e.cwd) return e
  try {
    const project = e.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
    const to = e.endedAt ?? e.startedAt + 12 * 3600_000
    const found = project ? firstAskIn(project, e.startedAt, to) : null
    return found ? { ...e, gist: gistOf(found) } : e
  } catch {
    return e
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

/**
 * The last `bytes` of a session's output, ANSI and all - what a restored pane replays so
 * it does not come back blank. `read` above strips, because it answers "what was said";
 * this one must not, because it answers "what was on screen", and the colours, the box
 * drawing and the cursor moves ARE what was on screen.
 *
 * Cut on a line boundary. Slicing raw terminal bytes at an arbitrary offset lands inside
 * an escape sequence often enough to matter, and the terminal draws the tail of it as
 * literal text across the first line - so drop up to the first newline and start clean.
 * Nothing is cut when the whole log is under the cap, since then there is no partial
 * sequence to land in.
 */
export function tail(id: string, bytes: number): string {
  flush()
  try {
    const raw = readFileSync(logFile(id), 'utf8')
    if (raw.length <= bytes) return raw
    const cut = raw.slice(-bytes)
    const nl = cut.indexOf('\n')
    return nl === -1 ? cut : cut.slice(nl + 1)
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

/**
 * The most transcripts may take on disk, oldest dropped first.
 *
 * The age cutoff alone is not a bound: how much 30 days of transcripts weigh depends
 * entirely on how much output the panes produced, and the per-log 8 MB ceiling above caps
 * ONE runaway pane, not four hundred ordinary ones. Measured on this Mac 2026-08-07:
 * 139 files, 155 MB, every one of them inside the 30-day window and so untouched by
 * `days`. Nothing was wrong with any of it - there was simply no number it could not pass.
 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

/**
 * Delete transcripts older than `days`, then anything past `MAX_TOTAL_BYTES`.
 *
 * `days` of 0 means keep forever, and the size cap still applies - "keep forever" is an
 * answer about age, and a disk that fills up is not what it was asking for.
 */
export function prune(days: number): void {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0
  let total = 0
  // Newest first, so the running total crosses the cap exactly where the oldest keepable
  // transcript is: everything after that point goes.
  for (const e of list()) {
    if (cutoff && e.startedAt < cutoff) {
      remove(e.id)
      continue
    }
    total += e.bytes ?? 0
    if (total > MAX_TOTAL_BYTES) remove(e.id)
  }
}

