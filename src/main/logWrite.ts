// The app's diagnostic logs, written without stopping the window.
//
// 2026-09-07: PaneForge froze for over 50 minutes with the main thread parked inside a
// single write(2). The sample named the transcript flush timer in `history.ts`, but every
// file below had the same shape: `appendFileSync` on the main thread, from a sweep, a
// keystroke or a pane's output. A synchronous write has no timeout, so on a machine in a
// disk stall any one of them stops the whole app - and every one of these files is a
// nicety that nobody would trade a window for.
//
// So the append is handed to the thread pool and the caller returns straight away. Writes
// to one file are chained, so lines land in the order they were made, and a write that
// fails is swallowed exactly as the synchronous version swallowed it. Nothing here is for
// a log that has to survive the process leaving: those paths keep their sync write and say
// so with `// sync-on-purpose:`.

import { appendFile, mkdir, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AppendOptions {
  /** Rename the file to `<file>.1` and start again once it passes this many bytes. */
  rotateAt?: number
  /** Or keep only the newest half of the lines once it passes this many bytes. */
  halveAt?: number
  /** Or empty it, for a log whose head stops being worth anything. */
  truncateAt?: number
}

/** The write in flight per file, so two lines cannot land out of the order they were made. */
const chains = new Map<string, Promise<void>>()

/**
 * Add one line to `file`. Never throws, never waits, and never blocks the window.
 */
export function appendLog(file: string, text: string, opts: AppendOptions = {}): void {
  const next = (chains.get(file) ?? Promise.resolve()).then(() => write(file, text, opts))
  // An unhandled rejection out of a log line would be the tail wagging the dog.
  chains.set(file, next)
  void next.finally(() => { if (chains.get(file) === next) chains.delete(file) })
}

async function write(file: string, text: string, opts: AppendOptions): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    if (opts.rotateAt || opts.truncateAt) {
      try {
        const size = (await stat(file)).size
        if (opts.rotateAt && size > opts.rotateAt) await rename(file, file + '.1')
        else if (opts.truncateAt && size > opts.truncateAt) await truncate(file, 0)
      } catch {
        /* first run, or the rotate lost a race - appending is still right */
      }
    }
    await appendFile(file, text)
    if (opts.halveAt) {
      // Trimmed on the way past rather than on a timer: the read only happens once the
      // file has genuinely grown.
      if ((await stat(file)).size > opts.halveAt) {
        const raw = await readFile(file, 'utf8')
        const lines = raw.split('\n').filter(Boolean)
        await writeFile(file, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n')
      }
    }
  } catch {
    /* a log that cannot be written must never be the thing that breaks the app it records */
  }
}

/**
 * Replace `file` wholesale, on the same chain as `appendLog`.
 *
 * A compaction that rewrites a log has to be ordered against the lines already on their
 * way to it, or it drops the ones that had not landed yet.
 */
export function rewriteLog(file: string, text: string): void {
  const next = (chains.get(file) ?? Promise.resolve()).then(async () => {
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
    } catch {
      /* next time */
    }
  })
  chains.set(file, next)
  void next.finally(() => { if (chains.get(file) === next) chains.delete(file) })
}

/** The newest content waiting for each file, and the write already on its way there. */
const latest = new Map<string, string>()
const saving = new Map<string, Promise<void>>()

/**
 * Replace `file` with `text`, when the disk gets round to it.
 *
 * For a small store that is rewritten whole - the strays ledger, the activity list, the
 * lane timeline - where only the newest version matters. A request arriving while a write
 * is in flight replaces whatever was waiting rather than queueing behind it, so a burst
 * costs one extra write instead of a run of stale ones.
 */
export function writeLatest(file: string, text: string): void {
  latest.set(file, text)
  if (!saving.has(file)) saving.set(file, drain(file))
}

async function drain(file: string): Promise<void> {
  try {
    for (;;) {
      const text = latest.get(file)
      if (text === undefined) return
      latest.delete(file)
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, text, 'utf8')
      } catch {
        /* read-only profile: a store that cannot be written is not a broken app */
      }
    }
  } finally {
    saving.delete(file)
  }
}

/** Give terminal diagnostics a bounded chance to finish without blocking the main thread. */
export async function flushLogsOnExit(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([...chains.values(), ...saving.values()]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 250) })
    ])
  } finally {
    clearTimeout(timer)
  }
}
