// The conversations one Claude Code process ran before the one it is on now.
//
// Every `/clear` - a person's, or the app's own automatic handoff - starts a new transcript
// in the same folder, and the only thing tying them together is the id the CLI was STARTED
// with, which it keeps stamping on its records (`shared/cliTitle.ts` `startedAs`). A card
// whose current conversation is titled for the handoff alone (`Taskdriver AI handoff next
// steps`) reads its name from these instead: see `nextTitle`.
//
// Read once per such conversation, never on a timer: a few file heads in the one folder.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { startedAs, titlesIn, type CliTitles } from '../shared/cliTitle'

/** How far into a transcript the process id is looked for (measured: 220-265 KB in). */
const HEAD_BYTES = 512 * 1024
/** Read the head this much at a time, stopping at the first stamp. */
const CHUNK_BYTES = 64 * 1024
/** How much of an earlier transcript's end is read for its title (as `sweepCliTitle`). */
const TAIL_BYTES = 256 * 1024
/** Newest files looked at in the folder; one process rarely writes more than a handful. */
const MAX_FILES = 40
/** A process started from a conversation that was itself cleared into: follow at most this far. */
const MAX_HOPS = 3

function readBytes(path: string, from: number, bytes: number): Buffer {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(bytes)
    const got = readSync(fd, buf, 0, bytes, from)
    return buf.subarray(0, got)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The process id a transcript file was written under, when it differs from its own.
 *
 * Chunk by chunk and no further than the first stamp: forty whole 1 MB heads in the shared
 * PaneForge folder cost up to 1.3 s cold on the main process (pre-ship review, 2026-09-29).
 */
function processOf(path: string): string | undefined {
  const own = basename(path, '.jsonl')
  const stamp = Buffer.from('"session_id":"')
  // Bytes, not text: a chunk's worth of UTF-8 is fewer characters than bytes.
  let carry = Buffer.alloc(0)
  for (let at = 0; at < HEAD_BYTES; at += CHUNK_BYTES) {
    const part = readBytes(path, at, CHUNK_BYTES)
    const head = Buffer.concat([carry, part])
    const cut = head.indexOf(stamp)
    // The whole stamp (50 bytes) must be in hand; one cut in two waits for the next chunk.
    if (cut >= 0 && (head.length - cut >= 64 || part.length < CHUNK_BYTES)) {
      return startedAs(head.subarray(cut, cut + 64).toString('latin1'), own)
    }
    if (part.length < CHUNK_BYTES) break
    carry = head.subarray(Math.max(0, head.length - 80))
  }
  return undefined
}

function titlesOf(path: string): CliTitles {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return {}
  }
  const from = Math.max(0, size - TAIL_BYTES)
  const text = readBytes(path, from, size - from).toString('utf8')
  // The first line of a tail read is usually cut; `titlesIn` skips what does not parse.
  return titlesIn(text)
}

/**
 * The titles of the conversations the CLI that wrote `path` ran before it, newest first.
 *
 * The process's first conversation is the file named by its id; every later one is a file
 * in the same folder stamped with that id, last written before this one. Nothing to say -
 * a conversation that was not born from a `/clear`, a folder that cannot be read - is `[]`.
 */
export function earlierTitles(path: string): CliTitles[] {
  const out: CliTitles[] = []
  const dir = dirname(path)
  let files: { path: string; at: number }[]
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(dir, f)
        try {
          return { path: p, at: statSync(p).mtimeMs }
        } catch {
          return { path: p, at: 0 }
        }
      })
      .filter((f) => f.at > 0)
      .sort((a, b) => b.at - a.at)
  } catch {
    return out
  }
  let current = path
  const seen = new Set([path])
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const origin = processOf(current)
    if (!origin) break
    const first = join(dir, `${origin}.jsonl`)
    const firstAt = files.find((f) => f.path === first)?.at
    if (firstAt === undefined) break
    // The chain's middle: written after the first conversation ended, before `current`
    // (still being written, so every other member is older), under the same process id.
    const middle = files
      .filter((f) => !seen.has(f.path) && f.path !== first && f.at >= firstAt)
      .slice(0, MAX_FILES)
      .filter((f) => processOf(f.path) === origin)
    for (const f of middle) {
      seen.add(f.path)
      out.push(titlesOf(f.path))
    }
    if (seen.has(first)) break
    seen.add(first)
    out.push(titlesOf(first))
    current = first
  }
  return out
}
