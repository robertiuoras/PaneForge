// Context observation for panes that have no Stop hook to speak for them.
//
// The claude path is decided by `claude-config/autoclear.mjs`, which runs INSIDE the
// session, knows the token count exactly and asks this app for a countdown. Codex has
// native compaction, and a fresh conversation without a deliberate handoff loses task
// state; this watcher never types `/new` or a synthetic handoff into it. Antigravity does
// not expose a session-owned continuation record, so it is also observed but never reset.
//
// This file never types into a non-Claude agent pane. A context number is not proof of a
// safe continuation, and unknown CLI commands are never guessed.

import {
  DEFAULT_AUTOCLEAR,
  type AutoClearConfig
} from '../shared/autoclear'
import { acLog } from './autoclearLog'
import { getConfig } from './config'
import type { SessionManager } from './sessions'

/** A low-frequency policy notice for newly opened panes. */
const TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let manager: SessionManager | null = null
/** One durable explanation per pane rather than a line each minute. */
const nativePolicyLogged = new Set<string>()

function config(): AutoClearConfig {
  return { ...DEFAULT_AUTOCLEAR, ...(getConfig().autoClear ?? {}) }
}

/**
 * The policy is deliberately executed before any rollout/statusline disk read. A context
 * threshold is not a task boundary, and this process cannot prove a handoff belongs to the
 * visible agent session. Deliberate clear+handoff remains available through `autoclear:ask`.
 */
export function runAutoClearWatchTick(
  mgr: Pick<SessionManager, 'list'>,
  cfg = config(),
  log: (line: string) => void = acLog
): void {
  if (!cfg.watchNonClaude) return
  const panes = mgr.list()
  const live = new Set(panes.map((pane) => pane.id))
  for (const id of nativePolicyLogged) if (!live.has(id)) nativePolicyLogged.delete(id)
  for (const pane of panes) {
    if (pane.agent !== 'codex' && pane.agent !== 'antigravity') continue
    if (nativePolicyLogged.has(pane.id)) continue
    nativePolicyLogged.add(pane.id)
    log(`${pane.id} automatic reset skipped: ${pane.agent === 'codex' ? 'Codex uses native context compaction' : 'no session-owned handoff proof'}`)
  }
}

function tick(): void {
  if (manager) runAutoClearWatchTick(manager)
}

/** Observe newly opened panes without reading agent transcripts or typing into them. */
export function startAutoClearWatch(mgr: SessionManager): void {
  manager = mgr
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
}

export function stopAutoClearWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
  manager = null
  nativePolicyLogged.clear()
}
