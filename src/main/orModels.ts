// Keeps a copy of OpenRouter's model list on disk so the picker can offer a model
// published after this build was cut.
//
// Three rules, and all three are the same rule: this may never be in anybody's way.
// The list is read from MEMORY by `listAgents`, which is synchronous and runs on every
// dialog open; the fetch happens in the background and its failure is silent; and a
// catalogue that is missing, stale or rubbish leaves the app exactly as it was before
// any of this existed - a hand-written shortcut list, with "Other..." for the rest.
//
// The endpoint is public and takes no key: it is the same list the website draws.

import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCatalogue, type OrRawModel } from '../shared/orCatalogue'

const URL = 'https://openrouter.ai/api/v1/models'
/** Twelve hours: models are published on the scale of days, and this costs a request. */
const TTL_MS = 12 * 60 * 60 * 1000
const TIMEOUT_MS = 8000

interface Cache {
  at: number
  models: OrRawModel[]
}

let mem: Cache | null = null
let loaded = false
let inFlight: Promise<void> | null = null

function file(): string {
  return join(app.getPath('userData'), 'openrouter-models.json')
}

function load(): Cache | null {
  if (loaded) return mem
  loaded = true
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Cache
    if (raw && typeof raw.at === 'number' && Array.isArray(raw.models)) mem = raw
  } catch {
    // No file yet, or a half-written one. Either way there is nothing to say: the
    // caller falls back to the built-in list and the next refresh writes a good one.
  }
  return mem
}

/** What the picker should offer right now. Never fetches, never blocks, never throws. */
export function orCatalogue(): OrRawModel[] {
  return load()?.models ?? []
}

/** True when the copy on disk is old enough to be worth a request. */
export function orStale(): boolean {
  const c = load()
  return !c || Date.now() - c.at > TTL_MS
}

/**
 * Fetch and store, in the background.
 *
 * `onNew` fires only when the list actually CHANGED, so a dialog is not rebuilt
 * twelve times a day for a file that says the same thing. A rejection is swallowed on
 * purpose - an offline laptop is the ordinary case, not an error anybody can act on.
 */
export async function refreshOrModels(onNew?: () => void): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const stop = AbortSignal.timeout(TIMEOUT_MS)
    try {
      const res = await fetch(URL, { signal: stop, headers: { accept: 'application/json' } })
      if (!res.ok) return
      const models = parseCatalogue(await res.json())
      // An empty answer is a failed answer, never a catalogue with nothing in it -
      // writing it would blank the menu until the next refresh twelve hours later.
      if (!models.length) return
      const before = mem?.models.length ?? 0
      const changed = before !== models.length || JSON.stringify(mem?.models.map((m) => m.id)) !== JSON.stringify(models.map((m) => m.id))
      mem = { at: Date.now(), models }
      loaded = true
      try {
        writeFileSync(file(), JSON.stringify(mem))
      } catch {
        // A read-only userData still leaves the list usable for this run.
      }
      if (changed) onNew?.()
    } catch {
      // Offline, DNS, a timeout, a 500. All of them mean "keep the old list".
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
