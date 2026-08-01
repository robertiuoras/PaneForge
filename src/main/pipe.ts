// Tee a pane's output to a file while it is still running - tmux's `pipe-pane`.
//
// The transcript in `history.ts` already keeps every byte, but it keeps them in the
// app's own profile directory, under a session id nobody typed, flushed on a 1.5s
// timer. That answers "what did this pane say last Tuesday". It does not answer the
// thing tmux's pipe-pane is for: something ELSE - a `tail -f`, a log viewer, a second
// agent - watching a run as it happens, in a file the person chose.
//
// So this writes straight through: one stream write per chunk, no debounce. What it
// does not do is buffer without limit. A tee pointed at a slow disk (or a network
// share that has gone away) would otherwise grow the process's memory for as long as
// the pane keeps talking, to protect bytes nobody is reading yet. Past the cap the
// chunk is DROPPED and counted, and the count is on the pane's chip - a tee that is
// losing output says so rather than quietly costing memory.
//
// Deliberately electron-free: `scripts/pipe-test.mjs` imports it directly.

import { createWriteStream, type WriteStream } from 'node:fs'
import { AnsiStream } from '../shared/ansi'
import type { PipeInfo } from '../shared/types'

/** How much unwritten output may queue before chunks are dropped instead. */
const MAX_PENDING = 2 * 1024 * 1024

export interface PipeOptions {
  path: string
  /** Strip escape sequences, for a file a person or an agent is going to read. */
  text?: boolean
  /** Add to the file rather than replacing it. */
  append?: boolean
}

interface Tee {
  stream: WriteStream
  info: PipeInfo
  ansi: AnsiStream | null
  /** Writes are refused after close: a stream error can arrive after the last chunk. */
  closed: boolean
}

const tees = new Map<string, Tee>()

/**
 * Start (or replace) the tee on one pane. Throws only if the file cannot be opened
 * synchronously - a disk that fills up later surfaces as an error on the stream, which
 * ends the tee and leaves the pane running.
 */
export function startPipe(id: string, opts: PipeOptions): PipeInfo {
  stopPipe(id)
  const stream = createWriteStream(opts.path, { flags: opts.append ? 'a' : 'w' })
  const info: PipeInfo = {
    path: opts.path,
    text: Boolean(opts.text),
    startedAt: Date.now(),
    bytes: 0,
    dropped: 0
  }
  const tee: Tee = { stream, info, ansi: opts.text ? new AnsiStream() : null, closed: false }
  // An unhandled 'error' on a stream is a process-level throw, and this one is on the
  // path every keystroke's echo travels: a tee pointed at a folder that gets deleted
  // must cost the pane nothing worse than losing the tee.
  stream.on('error', () => {
    tee.closed = true
    tees.delete(id)
  })
  tees.set(id, tee)
  return info
}

export function stopPipe(id: string): void {
  const tee = tees.get(id)
  if (!tee) return
  tees.delete(id)
  tee.closed = true
  // Whatever the stripper was holding back is real output: an escape sequence that
  // never finished is still bytes the pane printed.
  const rest = tee.ansi?.end() ?? ''
  try {
    if (rest) tee.stream.write(rest)
    tee.stream.end()
  } catch {
    /* already torn down */
  }
}

export function stopAllPipes(): void {
  for (const id of [...tees.keys()]) stopPipe(id)
}

export function pipeInfo(id: string): PipeInfo | undefined {
  return tees.get(id)?.info
}

/** Called for every chunk of pty output. Must stay cheap and must never throw. */
export function feedPipe(id: string, chunk: string): void {
  const tee = tees.get(id)
  if (!tee || tee.closed || !chunk) return
  const text = tee.ansi ? tee.ansi.push(chunk) : chunk
  if (!text) return
  // writableLength is what has been handed to the stream and not yet written to the
  // fd. Growing means the consumer is slower than the pane.
  if (tee.stream.writableLength > MAX_PENDING) {
    tee.info.dropped += Buffer.byteLength(text)
    return
  }
  try {
    tee.stream.write(text)
    tee.info.bytes += Buffer.byteLength(text)
  } catch {
    /* the error handler above has already retired this tee */
  }
}
