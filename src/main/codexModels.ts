// Reads what Codex already knows about itself: the model list it keeps in
// `~/.codex/models_cache.json`, and the newest release it recorded in
// `~/.codex/version.json`.
//
// No network and no schedule. Codex refreshes both files itself whenever it runs, so
// this app's job is only to look. Everything here is silent on failure: a machine
// without Codex, a half-written file, a renamed field - each leaves the app exactly as
// it was before any of this existed, with the two hand-written ids and "Other...".
//
// The cache is keyed on the file's MTIME, not on a wall clock. A 30-second timer over a
// file that changes when the CLI updates itself answers with yesterday's list for
// thirty seconds after the change and calls it fresh (see the autoclear handoff-cache
// lesson, 2026-09-04: a re-check that reads a stale cache is no re-check).

import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isOutdated,
  latestFromVersionFile,
  parseCodexModels,
  versionOf,
  type CodexRawModel
} from '../shared/codexCatalogue'

/** Codex honours CODEX_HOME; everything else lives under the user's home. */
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

/** One reader for both files: parsed JSON, or null, re-read only when the file changed. */
function cachedJson(): (name: string) => unknown {
  const seen = new Map<string, { at: number; value: unknown }>()
  return (name: string) => {
    const path = join(codexHome(), name)
    let at = 0
    try {
      at = statSync(path).mtimeMs
    } catch {
      // No file. Forget any copy we held: Codex removed or was never installed, and
      // serving the last good list from a machine that no longer has it is worse than
      // saying nothing.
      seen.delete(name)
      return null
    }
    const hit = seen.get(name)
    if (hit && hit.at === at) return hit.value
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      seen.set(name, { at, value })
      return value
    } catch {
      // Half-written, or not JSON. Do NOT cache the failure - the next read is a
      // millisecond away and the file is probably mid-write.
      return null
    }
  }
}

const read = cachedJson()

/** Codex's own model rows, or [] when there is no readable cache. Never throws. */
export function codexCatalogue(): CodexRawModel[] {
  return parseCodexModels(read('models_cache.json'))
}

/** The newest release Codex has heard of, or '' when it has not said. */
export function codexLatest(): string {
  return latestFromVersionFile(read('version.json'))
}

/**
 * The version of the binary on PATH, asked once per app run.
 *
 * `execFile`, never `execFileSync`: this is read from `listAgents`, which runs on every
 * dialog open on the main thread, and a spawn that blocks it is the Windows busy cursor.
 * The first call returns '' and starts the ask; the answer reaches the next call, which
 * is the same contract `orModels.ts` has with its fetch.
 */
let installed = ''
let asking = false
export function codexInstalledVersion(bin: string, onNew?: () => void): string {
  if (!installed && !asking) {
    asking = true
    execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err, out) => {
      asking = false
      if (err) return
      const v = versionOf(String(out))
      if (!v) return
      installed = v
      onNew?.()
    })
  }
  return installed
}

/** Both readings, as one answer for the picker. */
export function codexUpdateNeeded(bin: string, onNew?: () => void): boolean {
  return isOutdated(codexInstalledVersion(bin, onNew), codexLatest())
}

/** After an update runs, the number we hold is the OLD one. */
export function forgetCodexVersion(): void {
  installed = ''
}
