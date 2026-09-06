// Reading what a Codex pane's conversation actually ran at.
//
// The parse is `shared/effort.ts`'s (`lastTurnEffort`); this file is the disk and the
// cache and nothing else, the same split as `main/paneModel.ts` - a node test can follow
// a value import into a shared file, never into a main-side one.
//
// Codex writes a `turn_context` line at the start of every turn, and that line carries
// the effort the turn ran at. It is the ONLY evidence this feature accepts: the keys it
// sends may have been eaten by a menu, a trust prompt, or a composer that was not where
// it looked, and the TUI's own footer is a screen rather than a fact.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { lastTurnContext, ROLLOUT_TAIL_BYTES } from '../shared/effort'

export interface TurnReading {
  effort?: string
  model?: string
}

interface Reading {
  turn: TurnReading
  size: number
  mtimeMs: number
}

const cache = new Map<string, Reading>()

/** The last `ROLLOUT_TAIL_BYTES` of a file, or as much of it as exists. */
function tailOf(path: string, size: number): string {
  const len = Math.min(size, ROLLOUT_TAIL_BYTES)
  if (len <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The effort on the newest turn a rollout recorded, or undefined when it has not said.
 *
 * Cached on the file's own SIZE and mtime rather than on a clock: this runs on the 1s
 * sweep, and a rollout only changes when a turn starts. A cache keyed on the wall clock
 * would serve yesterday's answer for its whole window even though the file has already
 * moved (the autoclear handoff-cache lesson, 2026-09-04).
 */
export function rolloutTurn(path: string | null): TurnReading {
  if (!path) return {}
  let size = 0
  let mtimeMs = 0
  try {
    const st = statSync(path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    cache.delete(path)
    return {}
  }
  const hit = cache.get(path)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.turn
  let turn: TurnReading = {}
  try {
    turn = lastTurnContext(tailOf(path, size)) ?? {}
  } catch {
    /* unreadable, or gone mid-read - not evidence either way */
  }
  cache.set(path, { turn, size, mtimeMs })
  return turn
}

/** Drop a pane's cached reading. Mirrors `forgetPaneModel` - called when a pane closes. */
export function forgetRolloutTurn(path: string | null): void {
  if (path) cache.delete(path)
}
