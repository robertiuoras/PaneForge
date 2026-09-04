// Finding what a Claude Code pane's transcript says it is really running.
//
// The parse is `shared/paneModel.ts`'s (`lastAssistantModel`, `resolveCatalogueValue`).
// This file is the disk and the cache and nothing else, the same split as
// `handoffSteps.ts` / `main/handoffSteps.ts` - a node test can follow a value import into
// a shared file, never a value import into a main-side one, so keeping the arithmetic on
// the shared side is what makes it testable at all.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { lastAssistantModel, resolveCatalogueValue, TAIL_BYTES } from '../shared/paneModel'

/** How stale a cached reading may be. A transcript grows with every turn, not every second. */
const CACHE_MS = 30_000

interface ModelReading {
  raw: string | undefined
  mtimeMs: number
}

const cache = new Map<string, { at: number; reading: ModelReading }>()

/** The last `TAIL_BYTES` of a file, or as much of it as exists. Never the whole file. */
function tailOf(path: string, size: number): string {
  const len = Math.min(size, TAIL_BYTES)
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
 * The raw model id a Claude Code transcript's last assistant turn ran under.
 *
 * Cached per path for CACHE_MS, and re-read only when the file's own mtime has moved past
 * the cached reading's - the same contract `handoffFor` learned the hard way (2026-09-04):
 * a cache that trusts the wall clock over the file can serve a stale answer for the whole
 * window even though the thing it is a cache OF already changed.
 */
export function transcriptModel(path: string | null, now = Date.now()): string | undefined {
  if (!path) return undefined
  const hit = cache.get(path)
  if (hit && now - hit.at < CACHE_MS) {
    try {
      if (statSync(path).mtimeMs === hit.reading.mtimeMs) return hit.reading.raw
    } catch {
      return undefined // gone since the last read - no reading to serve
    }
  }
  let reading: ModelReading = { raw: undefined, mtimeMs: 0 }
  try {
    const st = statSync(path)
    const raw = lastAssistantModel(tailOf(path, st.size))
    reading = { raw, mtimeMs: st.mtimeMs }
  } catch {
    /* unreadable, or vanished mid-read - not evidence about the model */
  }
  cache.set(path, { at: now, reading })
  return reading.raw
}

/**
 * What the pane's card should say the model is: the transcript's real id, mapped onto
 * this build's own catalogue value, or the launch value when the transcript has nothing
 * to say (no transcript yet, unreadable, or an id the catalogue has never heard of).
 */
export function liveModelFor(
  path: string | null,
  launchValue: string | undefined,
  catalogueValues: string[],
  now = Date.now()
): string | undefined {
  const raw = transcriptModel(path, now)
  if (!raw) return launchValue
  return resolveCatalogueValue(raw, catalogueValues) ?? launchValue
}

/** Drop a pane's cached reading. Mirrors `forgetHandoff` - called when a pane closes. */
export function forgetPaneModel(path: string | null): void {
  if (path) cache.delete(path)
}

/** Everything, for tests. */
export function clearPaneModelCache(): void {
  cache.clear()
}
