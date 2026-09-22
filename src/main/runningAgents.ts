// The main-side reader for `shared/runningAgents.ts`: which background agents a Claude
// pane's conversation still has running, read off the transcript the pane is writing.
//
// Cheap by construction, because this runs from the session sweep for every Claude pane
// (2026-09-06: a folder read in full once a second cost the main process 83-118% CPU):
//
//   - the caller hands over the transcript path it already resolved for the model chip,
//     so this never lists a folder,
//   - a `statSync` per pane at most every `CHECK_MS`, and bytes are read only when the file
//     grew - and then only the bytes appended since the last read,
//   - the first read of a conversation starts at most `FIRST_READ_BYTES` from the end: an
//     agent launched further back than that in one conversation is older than anything
//     worth holding a pane for (`AGENT_MAX_AGE_MS`).

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { logHandoff } from './activationLog'
import { agentWords, newAgentScan, runningAgents, scanAgentLines, type AgentScan } from '../shared/runningAgents'

const CHECK_MS = 3_000
const FIRST_READ_BYTES = 8 * 1024 * 1024

interface Reading {
  file: string
  /** bytes of `file` already scanned, always at a line boundary */
  offset: number
  scan: AgentScan
  checkedAt: number
  /** what was last said about this pane, so the log hears only CHANGES */
  words?: string
}

const readings = new Map<string, Reading>()

function readFrom(file: string, start: number, end: number): { text: string; consumed: number } {
  const len = end - start
  if (len <= 0) return { text: '', consumed: 0 }
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try {
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got)
      if (n <= 0) break
      got += n
    }
    // Only whole lines: a line still being written is read on the next look. A newline
    // byte is never part of a multi-byte UTF-8 character, so cutting there never splits one.
    const nl = buf.lastIndexOf(10, got - 1)
    if (nl < 0) return { text: '', consumed: 0 }
    return { text: buf.subarray(0, nl + 1).toString('utf8'), consumed: nl + 1 }
  } finally {
    closeSync(fd)
  }
}

/**
 * The words for what this pane still has running in the background (`a background agent
 * (Visual review Design 4 pages)`), or undefined when nothing is - or nothing could be read.
 *
 * `since` is when this pane's CLI process started: agents launched before it died with the
 * process that launched them. A failed read answers undefined, never a hold: this feeds
 * refusals, and a reading nobody could take must not switch a feature off.
 */
export function backgroundAgentsFor(
  paneId: string,
  file: string | null | undefined,
  since: number | undefined,
  now = Date.now()
): string | undefined {
  if (!file) {
    readings.delete(paneId)
    return undefined
  }
  let r = readings.get(paneId)
  if (r && r.file === file && now - r.checkedAt < CHECK_MS) return wordsOf(r, since, now)
  try {
    const size = statSync(file).size
    if (!r || r.file !== file || size < r.offset) {
      const start = Math.max(0, size - FIRST_READ_BYTES)
      r = { file, offset: start, scan: newAgentScan(), checkedAt: now, words: r?.words }
      if (start > 0) {
        // Started mid-file: drop the partial first line.
        const head = readFrom(file, start, Math.min(size, start + 1024 * 1024))
        const nl = head.text.indexOf('\n')
        r.offset = nl < 0 ? size : start + Buffer.byteLength(head.text.slice(0, nl + 1))
      }
      readings.set(paneId, r)
    }
    r.checkedAt = now
    if (size > r.offset) {
      // A conversation that grew by more than a first read since the last look is read
      // from the same tail a first read would take.
      const from = size - r.offset > FIRST_READ_BYTES ? size - FIRST_READ_BYTES : r.offset
      const got = readFrom(file, from, size)
      if (from !== r.offset) {
        r.scan = newAgentScan()
        const nl = got.text.indexOf('\n')
        scanAgentLines(r.scan, nl < 0 ? '' : got.text.slice(nl + 1))
      } else {
        scanAgentLines(r.scan, got.text)
      }
      r.offset = from + got.consumed
    }
  } catch {
    return undefined
  }
  return wordsOf(r, since, now)
}

function wordsOf(r: Reading, since: number | undefined, now: number): string | undefined {
  return agentWords(runningAgents(r.scan, { since, now }))
}

/**
 * Say it in handoff.log when a pane starts or stops holding a background agent - the
 * reason every automatic move, sleep and close of it is refused in the meantime. Once per
 * change, never once per sweep.
 */
export function noteBackgroundAgents(paneId: string, words: string | undefined): void {
  const r = readings.get(paneId)
  const before = r?.words
  if (before === words) return
  if (r) r.words = words
  if (words) logHandoff(`handoff: ${paneId} will not be moved, slept or closed automatically - ${words} is still running`)
  else if (before) logHandoff(`handoff: ${paneId} background agent finished - automatic moves may take it again`)
}

export function forgetBackgroundAgents(paneId: string): void {
  readings.delete(paneId)
}
