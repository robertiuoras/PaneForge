// Where a queued prompt lives while it waits for a composer.
//
// `shared/queuedPrompts.ts` is the arithmetic and has no disk in it; this is the file and
// the log. Both are plain and greppable for the same reason `history.ts` is: the incident
// this exists for was read back off `autoclear-app.log` and `history/<id>.log`, and the one
// thing missing was any record that a prompt had been accepted at all.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  carryOver,
  clearQueued,
  dropLine,
  newQueueKey,
  noteQueued,
  owedTo,
  readStore,
  sentLine,
  type QueueDrop,
  type QueuedPrompt,
  type QueuedPromptStore
} from '../shared/queuedPrompts'

/** Two files of this size at most, the same cap `autoclearLog.ts` uses. */
const MAX_BYTES = 256 * 1024

function userDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
}

export function queuedPromptsPath(): string {
  return join(userDir(), 'queued-prompts.json')
}

export function queuedPromptsLogPath(): string {
  return join(userDir(), 'queued-prompts.log')
}

/** One line per accepted, submitted or lost prompt. Never throws - see `acLog`. */
export function qpLog(line: string): void {
  try {
    const file = queuedPromptsLogPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run, or the rotate lost a race */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // The ledger must never be the thing that breaks the prompt it is recording.
  }
}

let store: QueuedPromptStore | null = null

function load(): QueuedPromptStore {
  if (store) return store
  try {
    store = readStore(JSON.parse(readFileSync(queuedPromptsPath(), 'utf8')))
  } catch {
    store = {}
  }
  return store
}

function save(next: QueuedPromptStore): void {
  store = next
  try {
    const file = queuedPromptsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2))
  } catch {
    // A prompt that cannot be written down is still typed; only the safety net is lost.
  }
}

/**
 * Accept a prompt: on disk before a single byte of it is typed.
 *
 * Returns the key the caller clears it with. Called from `queuePrompt`, which is the one
 * place in the app that promises to put text into a composer.
 */
export function noteAccepted(id: string, text: string, cwd?: string): string {
  const row: QueuedPrompt = { id, key: newQueueKey(id, Date.now()), text, at: Date.now(), cwd }
  save(noteQueued(load(), row))
  qpLog(`${id} queued prompt accepted (${text.length} chars)`)
  return row.key
}

/** A turn proved it went in. */
export function noteSubmitted(key: string): void {
  const row = load()[key]
  if (row) qpLog(sentLine(row))
  save(clearQueued(load(), key))
}

/** Every other ending. One line, with enough of the prompt to find it again. */
export function noteDropped(key: string, why: QueueDrop): void {
  const row = load()[key]
  if (row) qpLog(dropLine(row, why))
  save(clearQueued(load(), key))
}

/**
 * The prompts a restored pane is still owed, moved onto the id it came back as.
 *
 * Called once per restored pane, with the id the desk saved (`scrollbackId`) and the id the
 * new session was issued. The rows are re-keyed rather than copied, so a second restore
 * cannot type one prompt twice.
 */
export function owedAfterRestore(oldId: string, newId: string): QueuedPrompt[] {
  const moved = carryOver(load(), oldId, newId)
  if (!moved.prompts.length) return []
  save(moved.store)
  for (const row of moved.prompts) qpLog(`${newId} queued prompt recovered from ${oldId} - ${row.text.length} chars`)
  return moved.prompts
}

/**
 * The pane is gone for good: close the rows it was owed, out loud.
 *
 * Without this a closed pane's prompts sit in the ledger for ever, owed to an id nothing
 * will ever restore - the file grows and the promise is quietly untrue. Each one writes its
 * own line with the first 120 characters, which is the whole point: a prompt that was never
 * typed is findable afterwards rather than gone.
 */
export function dropAllFor(id: string, why: QueueDrop = 'gone'): number {
  const owed = owedTo(load(), id)
  let next = load()
  for (const row of owed) {
    qpLog(dropLine(row, why))
    next = clearQueued(next, row.key)
  }
  if (owed.length) save(next)
  return owed.length
}

/** How many prompts a pane is still owed - the reading `sendOrOpen` refuses on. */
export function owedCount(id: string): number {
  return owedTo(load(), id).length
}

/** Only for tests and for a fresh read after the file was replaced underneath us. */
export function forgetQueuedPrompts(): void {
  store = null
}
