// The desk: which panes were open, so a restart of any kind can put them back.
//
// Kept in its own file rather than in config.json. config is rewritten on every
// settings toggle, and a truncated config resets every setting the user has; a
// truncated desk costs one set of panes, which is what it was for anyway. The
// update path used to be the only writer (config.restoreSessions, written on the
// way into the installer), so a PC restart, a power cut or a crash lost the lot.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { StartSessionRequest } from '../shared/types'
import { emptyDeskStands } from '../shared/restoreTurn'

/** Why the desk was written. Only `update` restores without asking. */
export type DeskReason = 'quit' | 'update' | 'live'

export interface Desk {
  specs: StartSessionRequest[]
  /** epoch ms of the write */
  at: number
  /** true when the app was actually asked to leave: false means crash or power cut */
  clean: boolean
  reason: DeskReason
}

/** Older than this and those panes are not the desk you remember leaving. */
export const MAX_DESK_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Twelve CLIs starting at once on a cold boot pegs the machine. */
export const MAX_RESTORE = 12
/** A burst of pane changes settles for this long before it costs a write. */
const DEBOUNCE_MS = 1500
/** Backstop tick, so a power cut loses at most this much of the desk. */
const TICK_MS = 15_000

function file(): string {
  return join(app.getPath('userData'), 'desk.json')
}

/**
 * Signature of the last write. An idle desk must not touch the disk every 15
 * seconds: the app runs all day beside real work and a spinning write is the
 * same kind of rudeness as taking focus.
 */
let lastWritten = ''
let timer: NodeJS.Timeout | null = null
/**
 * An offer is on screen and unanswered. Until it is answered, an empty desk is
 * not news - the app simply has no panes yet - and must not overwrite the panes
 * still being offered. Answering "Start fresh" clears the desk explicitly.
 */
let hold = false
/**
 * A pane has been open at some point since the offer went up. See `emptyDeskStands`:
 * on the PC the offer sat unanswered from a 23:13 relaunch, a pane opened over it by
 * `pf open`, was closed at 01:36 - and the empty desk was never written, so desk.json
 * still listed the closed pane an hour later (2026-09-03).
 */
let usedSinceOffer = false
/**
 * The desk this run leaves has been written. Nothing may write after it.
 *
 * The two quit paths overlap: `before-quit` fires, tears the panes down, and then
 * `window-all-closed` arrives with every session already dead - so a second write
 * would record an empty desk over the real one, and quitting would be the one
 * restart that loses your panes.
 */
let sealed = false

export function setDeskHold(on: boolean): void {
  hold = on
  if (on) usedSinceOffer = false
}

export function readDesk(): Desk | null {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Desk>
    if (!Array.isArray(raw.specs)) return null
    return {
      specs: raw.specs.filter((s) => s && typeof s.cwd === 'string'),
      at: typeof raw.at === 'number' ? raw.at : 0,
      clean: Boolean(raw.clean),
      reason: raw.reason === 'quit' || raw.reason === 'update' ? raw.reason : 'live'
    }
  } catch {
    return null
  }
}

export function saveDesk(specs: StartSessionRequest[], reason: DeskReason): void {
  if (sealed) return
  if (specs.length) usedSinceOffer = true
  if (emptyDeskStands(hold, usedSinceOffer)) return
  const desk: Desk = { specs, at: Date.now(), clean: reason !== 'live', reason }
  const sig = JSON.stringify({ specs, reason })
  // An unchanged desk is only worth rewriting when the reason changed - "the app
  // left cleanly" is the one bit a crash cannot forge.
  if (sig === lastWritten) return
  try {
    mkdirSync(dirname(file()), { recursive: true })
    // Write-then-rename, like config: a crash mid-write must not leave a half file
    // that reads as "no desk" on the next launch.
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(desk, null, 2), 'utf8')
    renameSync(tmp, file())
    lastWritten = sig
  } catch {
    /* read-only profile - the running app is unaffected */
  }
}

/** Forget the desk. Called once the panes have been handed back, or turned down. */
export function clearDesk(): void {
  lastWritten = ''
  try {
    rmSync(file(), { force: true })
  } catch {
    /* nothing to clear */
  }
}

/**
 * Keep the desk current while the app runs.
 *
 * `note()` is called from the session list changing (a pane started, exited, was
 * renamed or switched agent) and settles for a moment first, because starting a
 * swarm is six of those events in a second. The tick behind it is what makes a
 * power cut survivable: without it a pane's folder or title could drift for an
 * hour with nothing written.
 */
export function startDeskAutosave(snapshot: () => StartSessionRequest[]): (immediate?: boolean) => void {
  const write = (): void => saveDesk(snapshot(), 'live')
  setInterval(write, TICK_MS).unref()
  return (immediate = false) => {
    if (timer) clearTimeout(timer)
    if (immediate) {
      write()
      return
    }
    timer = setTimeout(write, DEBOUNCE_MS)
    timer.unref()
  }
}

/**
 * The desk as it is being left. Cancels a pending debounce first, so the last
 * write of a run is the real one rather than a stale snapshot landing after it.
 */
export function saveDeskOnExit(specs: StartSessionRequest[], reason: DeskReason = 'quit'): void {
  if (timer) clearTimeout(timer)
  timer = null
  saveDesk(specs, reason)
  sealed = true
}

/** A folder that has since been deleted or renamed cannot be reopened. */
export function paneMissing(spec: StartSessionRequest): boolean {
  return !spec.cwd || !existsSync(spec.cwd)
}
