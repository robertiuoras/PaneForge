// The desk: which panes were open, so a restart of any kind can put them back.
//
// Kept in its own file rather than in config.json. config is rewritten on every
// settings toggle, and a truncated config resets every setting the user has; a
// truncated desk costs one set of panes, which is what it was for anyway. The
// update path used to be the only writer (config.restoreSessions, written on the
// way into the installer), so a PC restart, a power cut or a crash lost the lot.
//
// The 15 second tick and the debounce write ASYNCHRONOUSLY. 2026-09-07: a sibling
// timer in history.ts wrote with appendFileSync and parked the entire app inside one
// write(2) for over 50 minutes while the machine was in a disk stall. Only the paths
// with no later turn still write synchronously - quitting, updating, going to sleep -
// because a write handed to the thread pool on the way out never lands.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { StartSessionRequest } from '../shared/types'
import { deskToWrite } from '../shared/restoreTurn'

/** Why the desk was written. Only `update` restores without asking. */
export type DeskReason = 'quit' | 'update' | 'live'

export interface Desk {
  specs: StartSessionRequest[]
  /** epoch ms of the write */
  at: number
  /** true when the app was actually asked to leave: false means crash or power cut */
  clean: boolean
  reason: DeskReason
  /** Internal ordering generation; unlike `at`, this changes for every disk snapshot. */
  writtenAt?: number
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
/** A terminal snapshot is never targeted by the live writer that may still be draining. */
function exitFile(): string {
  return join(app.getPath('userData'), 'desk.exit.json')
}
function clearFile(): string {
  return join(app.getPath('userData'), 'desk.clear')
}
/**
 * The desk before the last `clearDesk`. One generation, never read by the app: a
 * "Start fresh" click or a bug that empties the desk is then a rename away from undone
 * instead of gone, which is what the 2026-09-03 loss of eleven panes needed and did not
 * have.
 */
function prevFile(): string {
  return join(app.getPath('userData'), 'desk.prev.json')
}

/**
 * Signature of the last write. An idle desk must not touch the disk every 15
 * seconds: the app runs all day beside real work and a spinning write is the
 * same kind of rudeness as taking focus.
 */
let lastWritten = ''
let timer: NodeJS.Timeout | null = null
/**
 * The desk being offered, while the offer is on screen and unanswered. Every write
 * until then carries these panes in front of the live ones (`deskToWrite`), under the
 * offered desk's own reason and age: a dismissed dialog, a pane opened over it and a
 * self-restart for an update must all leave the offer standing. Answering clears it -
 * "Start fresh" through `clearDesk`, "Restore" through `restorePanes`.
 */
let pending: Desk | null = null
/**
 * The desk this run leaves has been written. Nothing may write after it.
 *
 * The two quit paths overlap: `before-quit` fires, tears the panes down, and then
 * `window-all-closed` arrives with every session already dead - so a second write
 * would record an empty desk over the real one, and quitting would be the one
 * restart that loses your panes.
 */
let sealed = false
/** The newest desk waiting for the disk, and the write already in flight. */
let waiting: { desk: Desk; sig: string } | null = null
let inflight: Promise<void> | null = null
let writeNumber = 0
let lastGeneration = 0
let clearedThrough = 0

function generation(previous = 0): number {
  lastGeneration = Math.max(lastGeneration + 1, Date.now(), previous + 1)
  return lastGeneration
}

export function setDeskHold(offered: Desk | null): void {
  pending = offered
}

export function readDesk(): Desk | null {
  const read = (path: string): Desk | null => {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Desk>
      if (!Array.isArray(raw.specs)) return null
      return {
        specs: raw.specs.filter((s) => s && typeof s.cwd === 'string'),
        at: typeof raw.at === 'number' ? raw.at : 0,
        clean: Boolean(raw.clean),
        reason: raw.reason === 'quit' || raw.reason === 'update' ? raw.reason : 'live',
        writtenAt: typeof raw.writtenAt === 'number' && Number.isFinite(raw.writtenAt) ? raw.writtenAt : 0
      }
    } catch {
      return null
    }
  }
  const live = read(file())
  const terminal = read(exitFile())
  let clearedAt = 0
  try {
    clearedAt = Number(readFileSync(clearFile(), 'utf8')) || 0
  } catch {
    /* no clear tombstone */
  }
  lastGeneration = Math.max(lastGeneration, live?.writtenAt ?? 0, terminal?.writtenAt ?? 0, clearedAt)
  clearedThrough = Math.max(clearedThrough, clearedAt)
  if (clearedAt > 0 && clearedAt >= Math.max(live?.writtenAt ?? 0, terminal?.writtenAt ?? 0)) return null
  if (!terminal) return live
  if (!live || (terminal.writtenAt ?? 0) >= (live.writtenAt ?? 0)) return terminal
  return live
}

/** What the next write would be, or null when it would change nothing on disk. */
function build(specs: StartSessionRequest[], reason: DeskReason, force = false): { desk: Desk; sig: string } | null {
  const all = deskToWrite(pending?.specs ?? null, specs)
  // While an offer stands the file stays the offered desk - same reason, so the next
  // launch asks again rather than reopening unasked as an `update` would, and the same
  // `at`, so the offer still ages out at seven days instead of being renewed by every
  // write.
  const desk: Desk = pending
    ? { specs: all, at: pending.at, clean: pending.clean, reason: pending.reason, writtenAt: generation() }
    : { specs: all, at: Date.now(), clean: reason !== 'live', reason, writtenAt: generation() }
  const sig = JSON.stringify({ specs: all, reason: desk.reason })
  // An unchanged desk is only worth rewriting when the reason changed - "the app
  // left cleanly" is the one bit a crash cannot forge.
  // A newer desired A must be retained while B is in flight even when the disk previously
  // held A. Otherwise the B completion leaves the wrong desk behind.
  if (!force && sig === lastWritten && !waiting && !inflight) return null
  return { desk, sig }
}

/**
 * Remember the desk, without stopping the window while the disk takes it.
 *
 * Only the newest snapshot is worth writing, so a burst of pane changes arriving while
 * one write is in flight collapses into a single later write rather than a queue of
 * stale desks. `lastWritten` is set once the rename has landed, so a write that failed
 * is retried by the next tick instead of being remembered as done.
 */
export function saveDesk(specs: StartSessionRequest[], reason: DeskReason): void {
  if (sealed) return
  const next = build(specs, reason)
  if (!next) return
  waiting = next
  if (!inflight) inflight = drain()
}

async function drain(): Promise<void> {
  try {
    while (waiting && !sealed) {
      const next = waiting
      waiting = null
      try {
        await mkdir(dirname(file()), { recursive: true })
        // Write-then-rename, like config: a crash mid-write must not leave a half file
        // that reads as "no desk" on the next launch.
        const tmp = `${file()}.live-${++writeNumber}.tmp`
        await writeFile(tmp, JSON.stringify(next.desk, null, 2), 'utf8')
        // The desk this run is leaving was written while this one was on its way to the
        // disk. Renaming now would put a snapshot from before the quit back over it.
        if (sealed) return
        await rename(tmp, file())
        if ((next.desk.writtenAt ?? 0) > clearedThrough) lastWritten = next.sig
      } catch {
        /* read-only profile - the running app is unaffected */
      }
    }
  } finally {
    inflight = null
  }
}

/** The same write, for the paths that have no later turn: see `saveDeskOnExit`. */
function writeDeskSync(next: { desk: Desk; sig: string }): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    const tmp = `${exitFile()}.tmp`
    // sync-on-purpose: quitting, updating or going to sleep, where an asynchronous write
    // handed to the thread pool would never land
    writeFileSync(tmp, JSON.stringify(next.desk, null, 2), 'utf8')
    renameSync(tmp, exitFile())
    lastWritten = next.sig
  } catch {
    /* read-only profile - the running app is unaffected */
  }
}

/**
 * Forget the desk. Called once the panes have been handed back, or turned down.
 * The file is kept one generation back as `desk.prev.json`, never deleted outright.
 */
export function clearDesk(): void {
  lastWritten = ''
  waiting = null
  try {
    const previous = readDesk()
    // An already-issued async rename cannot be cancelled, so make its old snapshot lose.
    // sync-on-purpose: a user clearing the desk must survive an immediately following quit
    writeFileSync(clearFile(), String(clearedThrough = generation()), 'utf8')
    if (previous) writeFileSync(prevFile(), JSON.stringify(previous, null, 2), 'utf8')
    else if (existsSync(file())) renameSync(file(), prevFile())
    rmSync(file(), { force: true })
    rmSync(exitFile(), { force: true })
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
 *
 * `immediate` is the machine going to sleep, and it writes synchronously: the battery
 * may not be there when it wakes, so this one has no later turn either.
 */
export function startDeskAutosave(snapshot: () => StartSessionRequest[]): (immediate?: boolean) => void {
  const write = (): void => saveDesk(snapshot(), 'live')
  setInterval(write, TICK_MS).unref()
  return (immediate = false) => {
    if (timer) clearTimeout(timer)
    if (immediate) {
      if (sealed) return
      const next = build(snapshot(), 'live')
      if (next) writeDeskSync(next)
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
  // Sealed FIRST, and the queue emptied: a tick's asynchronous write may already be part
  // way to the disk, and it must not land its older snapshot on top of the desk this run
  // is leaving. `drain` checks this again before it renames.
  sealed = true
  waiting = null
  const next = build(specs, reason, true)
  if (next) writeDeskSync(next)
}

/** A folder that has since been deleted or renamed cannot be reopened. */
export function paneMissing(spec: StartSessionRequest): boolean {
  return !spec.cwd || !existsSync(spec.cwd)
}
