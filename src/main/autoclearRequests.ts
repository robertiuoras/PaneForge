// Auto-clear requests that arrive as files.
//
// The shipped Stop hook (scripts/autoclear-hook.mjs) asks for a clear by writing
// <userData>/autoclear-requests/<pane>.json - no port, no pairing code, nothing a stranger's
// machine has to have set up. Each file is read, deleted, and handed to the same code the
// `autoclear:ask` channel runs, so the countdown card and every refusal are the one path.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { acLog } from './autoclearLog'

/** A request older than this is about a turn long gone (the app was closed when it came). */
const STALE_MS = 10 * 60_000

let watcher: FSWatcher | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** Read, delete and hand over every waiting request. Exported for the test. */
export function drainRequests(dir: string, handle: (raw: unknown) => { ok: boolean; reason?: string }, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let handled = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue // `.tmp` is a request still being written
    const file = join(dir, name)
    let text: string
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
      text = readFileSync(file, 'utf8')
      unlinkSync(file)
    } catch {
      continue // gone already, or taken by another pass
    }
    if (now - mtimeMs > STALE_MS) {
      acLog(`request file ${name} dropped - ${Math.round((now - mtimeMs) / 60_000)} min old`)
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      acLog(`request file ${name} dropped - not JSON`)
      continue
    }
    try {
      const res = handle(raw)
      acLog(`request file ${name} -> ${res.ok ? 'armed' : 'refused'}${res.reason ? ` (${res.reason})` : ''}`)
    } catch (e) {
      acLog(`request file ${name} failed - ${(e as Error).message}`)
    }
    handled++
  }
  return handled
}

/** Watch the folder, and take whatever arrived while the app was closed. Never throws. */
export function startAutoClearRequests(dir: string, handle: (raw: unknown) => { ok: boolean; reason?: string }): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (e) {
    acLog(`request folder ${dir} unavailable - ${(e as Error).message}`)
    return
  }
  drainRequests(dir, handle)
  try {
    // One rename fires several events; a short beat folds them into one pass.
    watcher = watch(dir, () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        drainRequests(dir, handle)
      }, 150)
    })
    watcher.on('error', (e) => acLog(`request folder watch failed - ${e.message}`))
  } catch (e) {
    acLog(`request folder watch failed - ${(e as Error).message}`)
  }
}

export function stopAutoClearRequests(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
}
