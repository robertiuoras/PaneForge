/**
 * Today's and this week's token spend, read off the transcripts on this machine.
 *
 * Only the Discord presence asks for this, and only while a row is actually written to
 * say it - `tokenSpend()` returns the last answer instantly and refreshes at most once
 * per REFRESH_MS in the background. That is not tidiness: `~/.claude/projects` on this
 * Mac is 2.7 GB over 7,546 files, and main reading a folder in full on a timer is the
 * 2026-09-06 lesson (main at 83-118% CPU, 402 transcript heads a second).
 *
 * Three things keep it cheap:
 *   - mtime decides what is opened at all; a file untouched since before the window
 *     cannot hold a row inside it.
 *   - each file is read from its TAIL (READ_TAIL), so a month-long transcript costs the
 *     same as a fresh one, and the first partial line is dropped.
 *   - every read is async. Nothing here may block main.
 */
import { readdir, readFile, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  NO_TOKEN_SPEND,
  readTokenRow,
  tallyTokens,
  weekStart,
  type TokenRow,
  type TokenSpend
} from '../shared/tokenTally'

/** Cheapest honest cadence: the presence itself is throttled to one frame per 15s. */
const REFRESH_MS = 5 * 60_000
/** A day of slack on the mtime window, for a clock that moved or a file touched late. */
const MTIME_SLACK_MS = 36 * 60_000 * 60
/** Enough tail to carry a week of turns; a transcript's rows are ~2 KB each. */
const READ_TAIL = 8 * 1024 * 1024

function roots(): string[] {
  const home = homedir()
  return [
    process.env.PF_CLAUDE_HOME || join(home, '.claude', 'projects'),
    join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions')
  ]
}

/** Every `.jsonl` under a root, at any depth, newest-first filtering done by the caller. */
async function transcripts(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await transcripts(p, out, depth + 1)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
}

/** The tail of a file as text, whole lines only. */
async function tail(file: string): Promise<string> {
  let fh
  try {
    fh = await open(file, 'r')
    const { size } = await fh.stat()
    if (size <= READ_TAIL) return await readFile(file, 'utf8')
    const buf = Buffer.alloc(READ_TAIL)
    const { bytesRead } = await fh.read(buf, 0, READ_TAIL, size - READ_TAIL)
    const text = buf.toString('utf8', 0, bytesRead)
    return text.slice(text.indexOf('\n') + 1)
  } catch {
    return ''
  } finally {
    await fh?.close().catch(() => {})
  }
}

let spend: TokenSpend = { ...NO_TOKEN_SPEND }
let countedAt = 0
let running = false

async function recount(now: number): Promise<void> {
  const cutoff = weekStart(now) - MTIME_SLACK_MS
  const files: string[] = []
  for (const r of roots()) await transcripts(r, files)
  const rows: TokenRow[] = []
  for (const f of files) {
    let mtime = 0
    try {
      mtime = (await stat(f)).mtimeMs
    } catch {
      continue
    }
    if (mtime < cutoff) continue
    for (const line of (await tail(f)).split('\n')) {
      const row = readTokenRow(line)
      if (row) rows.push(row)
    }
  }
  spend = tallyTokens(rows, Date.now())
}

/**
 * The last answer, immediately - and a refresh started when it is stale.
 *
 * Deliberately never awaited by the caller: a presence frame that waited on a disk walk
 * would be a presence frame that waits on a disk walk.
 */
export function tokenSpend(now = Date.now()): TokenSpend {
  if (!running && now - countedAt >= REFRESH_MS) {
    running = true
    countedAt = now
    void recount(now).catch(() => {}).finally(() => {
      running = false
    })
  }
  return spend
}
