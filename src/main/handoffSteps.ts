// Finding a pane's handoff on disk, and how often that is worth doing.
//
// The path math is `shared/handoffSteps.ts`'s (`handoffCandidates`), a mirror of the hook's
// own list in claude-config/autoclear.mjs. This file is the disk and the cache and nothing
// else - which is also what makes the math testable, since a node test cannot follow a
// value import from a main-side file to an extensionless sibling.

import { lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { actionableNextSteps, handoffCandidates } from '../shared/handoffSteps'

/** How stale a cached reading may be. A handoff is rewritten once a session, not once a second. */
const CACHE_MS = 30_000

function symlinked(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export interface HandoffReading {
  /** The file the answer came from, or null when this pane has no handoff at all. */
  path: string | null
  /** How many steps a fresh session could start on. 0 WITH a path means a handoff saying None. */
  open: number
  /** The steps themselves, for the countdown card. */
  steps: string[]
  mtimeMs: number
}

const NONE: HandoffReading = { path: null, open: 0, steps: [], mtimeMs: 0 }

const cache = new Map<string, { at: number; reading: HandoffReading }>()

/**
 * Read the newest handoff for this pane.
 *
 * Cached for CACHE_MS per pane. A pane with no handoff is cached too - the commonest case
 * on this desk is a pane that has never written one, and stat-ing six absent paths for
 * every pane on every session list is the cost this avoids.
 */
export function handoffFor(cwd: string, paneId: string, now = Date.now()): HandoffReading {
  const key = `${paneId} ${cwd}`
  const hit = cache.get(key)
  // A cached reading is served only while the file it read is the file on disk. The
  // clear hook rewrites the handoff and asks for the clear inside the same second, and a
  // reading the chip took moments earlier - of a handoff that then said None - refused a
  // clear whose steps were already written (2026-09-04, s10-mtm6ccmk, 206k tokens). The
  // stat is the cheap half; the absent-file case still costs nothing for CACHE_MS.
  if (hit && now - hit.at < CACHE_MS) {
    if (!hit.reading.path) return hit.reading
    try {
      if (statSync(hit.reading.path).mtimeMs === hit.reading.mtimeMs) return hit.reading
    } catch {
      /* gone - read again */
    }
  }
  let best: HandoffReading = NONE
  for (const p of handoffCandidates(cwd, paneId, homedir(), symlinked)) {
    try {
      const st = statSync(p)
      if (st.mtimeMs <= best.mtimeMs) continue
      const steps = actionableNextSteps(readFileSync(p, 'utf8'))
      best = { path: p, open: steps.length, steps, mtimeMs: st.mtimeMs }
    } catch {
      /* absent, or unreadable - neither is evidence about the work */
    }
  }
  cache.set(key, { at: now, reading: best })
  return best
}

/** Drop a pane's cached reading, so the next read is fresh. Called when a pane closes. */
export function forgetHandoff(paneId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${paneId} `)) cache.delete(key)
}

/** Everything, for tests and for anything that could move the answer. */
export function clearHandoffCache(): void {
  cache.clear()
}
