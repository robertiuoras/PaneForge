// Finding a pane's handoff on disk, and how often that is worth doing.
//
// The path math is `shared/handoffSteps.ts`'s (`handoffCandidates`), a mirror of the hook's
// own list in claude-config/autoclear.mjs. This file is the disk and the cache and nothing
// else - which is also what makes the math testable, since a node test cannot follow a
// value import from a main-side file to an extensionless sibling.

import { lstatSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  digest?: string
  meta?: { paneId: string; agent: string; resumeId: string; cwd: string; createdAt: number }
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
      if (st.size > 64 * 1024) continue
      const bytes = readFileSync(p)
      const text = bytes.toString('utf8')
      const steps = actionableNextSteps(text)
      const match = /<!--\s*paneforge-handoff\s+({[^>]+})\s*-->/.exec(text)
      let meta: HandoffReading['meta']
      try { const x = match ? JSON.parse(match[1]) : null; if (x && typeof x.paneId === 'string' && typeof x.agent === 'string' && typeof x.resumeId === 'string' && typeof x.cwd === 'string' && Number.isFinite(x.createdAt)) meta = x } catch { /* invalid metadata */ }
      best = { path: p, open: steps.length, steps, mtimeMs: st.mtimeMs, digest: createHash('sha256').update(bytes).digest('hex'), meta }
    } catch {
      /* absent, or unreadable - neither is evidence about the work */
    }
  }
  cache.set(key, { at: now, reading: best })
  return best
}

export function verifiedPaneHandoff(cwd: string, paneId: string, agent: string, resumeId: string, now = Date.now()): HandoffReading | null {
  const hand = handoffFor(cwd, paneId, now)
  const meta = hand.meta
  if (!hand.path || !meta || meta.paneId !== paneId || meta.agent !== agent || meta.resumeId !== resumeId || meta.cwd !== cwd || now - meta.createdAt > 20 * 60_000 || meta.createdAt > now) return null
  try {
    const st = statSync(hand.path)
    if (now - st.mtimeMs > 20 * 60_000 || st.mtimeMs > now + 1_000 || st.size > 64 * 1024 || handoffCandidates(cwd, paneId, homedir(), symlinked)[0] !== hand.path) return null
    const bytes = readFileSync(hand.path)
    if (bytes.length > 64 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hand.digest) return null
    const text = bytes.toString('utf8')
    for (const heading of ['Objective', 'Constraints', 'Completed', 'Next steps', 'Verification', 'Running jobs']) {
      const found = new RegExp(`^#+\\s*${heading}\\s*\\n\\s*[^#\\s]`, 'mi').test(text)
      if (!found) return null
    }
    return hand
  } catch { return null }
}

/** Drop a pane's cached reading, so the next read is fresh. Called when a pane closes. */
export function forgetHandoff(paneId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${paneId} `)) cache.delete(key)
}

/** Everything, for tests and for anything that could move the answer. */
export function clearHandoffCache(): void {
  cache.clear()
}
