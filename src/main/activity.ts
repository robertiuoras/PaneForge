// The disk and the clock behind `shared/activity.ts`.
//
// Main owns it rather than the renderer for the same reason `reclaim.log` does: a window
// that reloads, a renderer that is recreated after a wedge, and a restart all lose
// renderer memory, and "what happened to my pane twenty minutes ago" is exactly the
// question asked after one of those. One small JSON file under userData.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { addActivity, MAX_ACTIVITY, type ActivityEntry } from '../shared/activity'

interface Store {
  /** Newest first. */
  items: ActivityEntry[]
  /** When the list was last opened, so a badge can count what arrived after. */
  seenAt: number
}

let store: Store | null = null
let path = ''
let onChange: ((s: Store) => void) | null = null

function file(): string {
  if (!path) {
    const dir = app.getPath('userData')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* it is the app's own data dir */
    }
    path = join(dir, 'activity.json')
  }
  return path
}

function load(): Store {
  if (store) return store
  let read: Store = { items: [], seenAt: 0 }
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>
    if (Array.isArray(raw.items)) read.items = raw.items.slice(0, MAX_ACTIVITY)
    if (typeof raw.seenAt === 'number') read.seenAt = raw.seenAt
  } catch {
    // No file, or a file half-written by a machine that lost power. An empty list is the
    // honest answer to "what happened recently" when nothing can be read.
    read = { items: [], seenAt: 0 }
  }
  store = read
  return store
}

function save(): void {
  try {
    writeFileSync(file(), JSON.stringify(load()))
  } catch {
    // A list that cannot be written must never be the reason an action does not happen.
  }
}

/** Tell the window whenever the list changes. Set once, from index.ts. */
export function onActivityChange(fn: (s: Store) => void): void {
  onChange = fn
}

/** Record something the app did. A duplicate within `SAME_MS` is dropped silently. */
export function noteActivity(e: ActivityEntry | null): void {
  if (!e) return
  const s = load()
  const next = addActivity(s.items, e)
  if (next === s.items) return
  s.items = next
  save()
  onChange?.(s)
}

export function listActivity(): Store {
  return load()
}

/** The list has been looked at: everything up to now stops counting as new. */
export function markActivitySeen(at = Date.now()): Store {
  const s = load()
  s.seenAt = at
  save()
  onChange?.(s)
  return s
}
