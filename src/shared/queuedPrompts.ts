/**
 * A prompt that has been accepted for a pane but not yet typed into it.
 *
 * `queuePrompt` waits for an idle composer, which is right - a return sent into a booting
 * CLI is swallowed - but until 2026-09-07 that wait happened in MEMORY ONLY. Measured on
 * the main profile: two `pf open ... --prompt <brief>` calls at 05:19Z both landed on one
 * pane that was mid-turn, sat in the queue, and were gone by 05:45 when the pane was
 * recreated. `history/s7-mtqs4bj1.log` has zero occurrences of either brief: they were
 * never typed, and nothing anywhere said so. Robert: "we can never drop or lose a prompt
 * that's sent".
 *
 * So an accepted prompt is written to disk the moment it is accepted and removed only when
 * a TURN proves it went in - the same proof `queuePrompt` already uses. Anything still on
 * disk at launch is a prompt the app owes somebody, and `restorePanes` re-queues it into
 * the pane that came back.
 *
 * The arithmetic is here, with no disk and no Electron in it, so it can be tested by
 * building one store, throwing it away, and rebuilding it from the JSON it wrote.
 */

/** One prompt this app has promised to type, keyed by `key` in the store. */
export interface QueuedPrompt {
  /** The session that was to receive it, as it was known when the prompt was accepted. */
  id: string
  /** Unique per acceptance: one pane can hold two queued prompts. */
  key: string
  /** What to type, in full - the whole point is that this survives. */
  text: string
  /** When it was accepted. */
  at: number
  /** The folder the pane was in, so a dropped prompt can be found by project. */
  cwd?: string
}

/** Every prompt currently owed, keyed by `key`. */
export type QueuedPromptStore = Record<string, QueuedPrompt>

/** How much of a prompt goes into a log line - enough to recognise it, never the lot. */
export const PREVIEW_CHARS = 120

/** The first line of a prompt, capped, for a log a person reads. */
export function preview(text: string): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > PREVIEW_CHARS ? one.slice(0, PREVIEW_CHARS) + '…' : one
}

/** A key nothing else can collide with: the pane, the moment, and a counter for the tie. */
let seq = 0
export function newQueueKey(id: string, at: number): string {
  seq = (seq + 1) % 1_000_000
  return `${id}-${at.toString(36)}-${seq.toString(36)}`
}

/**
 * Read a store back off disk.
 *
 * A file half-written, hand-edited or from an older build must not stop the app: every row
 * is checked and anything that is not a prompt with a pane and some text is dropped. An
 * unreadable file is an EMPTY store, never a crash - but it is also never treated as proof
 * that nothing was owed, which is why the caller logs what it read.
 */
export function readStore(raw: unknown): QueuedPromptStore {
  const out: QueuedPromptStore = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Partial<QueuedPrompt>
    if (typeof row.id !== 'string' || !row.id) continue
    if (typeof row.text !== 'string' || !row.text) continue
    out[key] = {
      id: row.id,
      key,
      text: row.text,
      at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined
    }
  }
  return out
}

/** Add one, returning a new store - the caller writes what comes back. */
export function noteQueued(store: QueuedPromptStore, row: QueuedPrompt): QueuedPromptStore {
  return { ...store, [row.key]: { ...row } }
}

/** Remove one, whether it was typed or dropped. */
export function clearQueued(store: QueuedPromptStore, key: string): QueuedPromptStore {
  if (!(key in store)) return store
  const out = { ...store }
  delete out[key]
  return out
}

/**
 * The prompts owed to one pane, oldest first.
 *
 * A restored pane is a NEW session with a new id, and the desk names the pane it is
 * replacing (`scrollbackId`), so the lookup is by the id the prompt was accepted under.
 */
export function owedTo(store: QueuedPromptStore, id: string): QueuedPrompt[] {
  return Object.values(store)
    .filter((row) => row.id === id)
    .sort((a, b) => a.at - b.at)
}

/**
 * Move a pane's owed prompts onto the id it came back as.
 *
 * Re-keyed rather than copied: the old rows are gone from the store, so a restore that
 * happens twice cannot type one prompt twice.
 */
export function carryOver(
  store: QueuedPromptStore,
  oldId: string,
  newId: string
): { store: QueuedPromptStore; prompts: QueuedPrompt[] } {
  const owed = owedTo(store, oldId)
  if (!owed.length) return { store, prompts: [] }
  let next = store
  const prompts: QueuedPrompt[] = []
  for (const row of owed) {
    next = clearQueued(next, row.key)
    const moved: QueuedPrompt = { ...row, id: newId, key: newQueueKey(newId, row.at) }
    next = noteQueued(next, moved)
    prompts.push(moved)
  }
  return { store: next, prompts }
}

/** Why a queued prompt left the store without being typed. */
export type QueueDrop = 'unsent' | 'abandoned' | 'gone' | 'expired' | 'replaced'

const DROP_WORDS: Record<QueueDrop, string> = {
  unsent: 'the returns were never proven',
  abandoned: 'somebody else was using the pane',
  gone: 'the pane closed before it was typed',
  expired: 'the wait ran out',
  replaced: 'it was superseded'
}

/**
 * The one line a lost prompt leaves behind.
 *
 * Written for every ending that is not a proven submit, so "where did my prompt go" is a
 * grep and never a reconstruction. It carries the pane, the reason and the first
 * `PREVIEW_CHARS` characters, which is what makes it findable at all.
 */
export function dropLine(row: QueuedPrompt, why: QueueDrop): string {
  return `${row.id} queued prompt LOST (${why}: ${DROP_WORDS[why]}) - ${preview(row.text)}`
}

/** The line written when a prompt IS typed and proven, so the pair reads as a ledger. */
export function sentLine(row: QueuedPrompt): string {
  return `${row.id} queued prompt submitted - ${preview(row.text)}`
}
