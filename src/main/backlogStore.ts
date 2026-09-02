// Reading A1's backlog off disk. Reading only - the backlog has one writer, and it is
// `claude-config/backlog.mjs`.
//
// The judgement is `shared/taskBrief.ts`; this is the path, the read and the cache, the
// same split as `main/promptForge.ts` and `main/handoffSteps.ts`.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot } from './config'
import { loadTemplate } from './promptForge'
import { findTask, foldBacklog, taskBrief, type BacklogRow, type TaskRefusal } from '../shared/taskBrief'

/** How long a reading is trusted. The log is appended to by a script, not by this app. */
const CACHE_MS = 30_000

/** Where the store lives. `PF_BACKLOG` points the test at a fixture. */
export function backlogPath(): string {
  return (
    process.env.PF_BACKLOG ||
    join(projectsRoot(), 'claude-memory', 'claude-config', 'ledger', 'backlog.jsonl')
  )
}

let cache: { at: number; path: string; mtimeMs: number; store: Map<string, BacklogRow> } | null = null

/**
 * The backlog as it stands, or an empty store when this machine has none.
 *
 * An unreadable file answers EMPTY rather than throwing, and the caller turns empty into a
 * refusal that says so - the same rule `backlog.mjs` states for itself: an unreadable store
 * is UNKNOWN and never a silent pass.
 */
export function backlogStore(now = Date.now()): Map<string, BacklogRow> {
  const path = backlogPath()
  let mtimeMs = 0
  try {
    mtimeMs = existsSync(path) ? statSync(path).mtimeMs : 0
  } catch {
    mtimeMs = 0
  }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs && now - cache.at < CACHE_MS)
    return cache.store
  let store = new Map<string, BacklogRow>()
  try {
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return l.trim() ? (JSON.parse(l) as BacklogRow) : null
        } catch {
          // One torn line in an append-only log is one torn line, not a dead store.
          return null
        }
      })
      .filter((r): r is BacklogRow => !!r)
    store = foldBacklog(rows)
  } catch {
    /* absent or unreadable - an empty store, and the caller says so out loud */
  }
  cache = { at: now, path, mtimeMs, store }
  return store
}

/** The prompt a pane opened on this task starts with, or the reason there is none. */
export function briefForTask(ref: string): { prompt: string } | TaskRefusal {
  const store = backlogStore()
  if (!store.size) return { error: `no backlog on this machine (${backlogPath()})` }
  const brief = taskBrief(findTask(store, ref), loadTemplate('build-feature'))
  return typeof brief === 'string' ? { prompt: brief } : brief
}
