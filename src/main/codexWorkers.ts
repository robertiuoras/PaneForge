// Visibility only: native spawn edges identify children, never whether they are running.
// Python's stdlib reads the local database read-only (Electron 33 has no node:sqlite).
import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodexWorker, CodexWorkerReading } from '../shared/types'

const CHECK_MS = 10_000
const STALE_MS = 5 * 60_000
const READ_BYTES = 256 * 1024
const LIMIT = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const QUERY = `import sqlite3,json,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
c.execute('pragma query_only=ON')
r=c.execute('select t.id,t.rollout_path,t.agent_nickname,t.agent_path from thread_spawn_edges e join threads t on t.id=e.child_thread_id where e.parent_thread_id=? order by t.created_at desc limit 21',(sys.argv[2],)).fetchall()
print(json.dumps(r))`

interface RolloutReading {
  file: string
  offset: number
  model?: string
  effort?: string
  state: CodexWorker['state']
  turn?: string
  skipFirst?: boolean
  head?: { turn?: string; model?: string; effort?: string }
}
interface Reading {
  parent: string
  checkedAt: number
  pending: boolean
  value: CodexWorkerReading
  rollouts: Map<string, RolloutReading>
}
const readings = new Map<string, Reading>()

/** Only native task events prove activity; model and effort come from executed contexts. */
export function scanWorkerLines(r: RolloutReading, text: string): void {
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line)
      const p = record.payload
      if (record.type === 'turn_context') {
        if (typeof p?.model === 'string') r.model = p.model
        if (typeof p?.effort === 'string') r.effort = p.effort
      } else if (record.type === 'event_msg') {
        if (p?.type === 'task_started') {
          r.turn = p.turn_id
          r.state = 'running'
          r.model = undefined
          r.effort = undefined
        } else if ((p?.type === 'task_complete' || p?.type === 'turn_aborted') && (!r.turn || p.turn_id === r.turn)) {
          r.turn = p.turn_id
          r.state = p.type === 'task_complete' ? 'completed' : 'interrupted'
        }
      }
    } catch { /* A partial/unknown record says nothing. */ }
  }
}

function worker(row: string[], readings: Map<string, RolloutReading>, now: number): CodexWorker {
  const [id, file, nickname, path] = row
  const name = path?.split('/').filter(Boolean).pop() || nickname || id.slice(0, 8)
  let r = readings.get(id)
  try {
    const stat = statSync(file)
    let start = r?.file === file && stat.size >= r.offset ? r.offset : Math.max(0, stat.size - READ_BYTES)
    if (!r || r.file !== file || stat.size < r.offset || stat.size - start > READ_BYTES) {
      start = Math.max(0, stat.size - READ_BYTES)
      r = { file, offset: start, state: 'unknown', skipFirst: start > 0 }
      readings.set(id, r)
      // A long first turn may put its executed context outside the tail. Apply
      // a bounded head candidate only to the SAME proven tail turn.
      if (start > 0) {
        const head = Buffer.alloc(Math.min(READ_BYTES, start))
        const fd = openSync(file, 'r')
        try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
        const context: RolloutReading = { file, offset: 0, state: 'unknown' }
        scanWorkerLines(context, head.subarray(0, head.lastIndexOf(10) + 1).toString('utf8'))
        r.head = { turn: context.turn, model: context.model, effort: context.effort }
      }
    }
    if (stat.size > start) {
      const fd = openSync(file, 'r')
      const bytes = Buffer.alloc(Math.min(READ_BYTES, stat.size - start))
      let got: number
      try { got = readSync(fd, bytes, 0, bytes.length, start) } finally { closeSync(fd) }
      const end = bytes.lastIndexOf(10, got - 1)
      if (end >= 0) {
        let text = bytes.subarray(0, end + 1).toString('utf8')
        if (r.skipFirst) text = text.slice(text.indexOf('\n') + 1)
        r.skipFirst = false
        scanWorkerLines(r, text)
        if (!r.model && r.turn && r.turn === r.head?.turn) {
          r.model = r.head.model
          r.effort = r.head.effort
        }
        r.offset = start + end + 1
      }
    }
    const state = r!.state === 'running' && now - stat.mtimeMs > STALE_MS ? 'stale' : r!.state
    return { id, name, nickname: nickname || undefined, model: r!.model, effort: r!.effort, state }
  } catch {
    return { id, name, nickname: nickname || undefined, model: r?.model, effort: r?.effort, state: 'unknown' }
  }
}

/** Async database lookup, throttled per exact native parent; bounded incremental child reads. */
export function codexWorkersFor(pane: string, parent: string | undefined, now = Date.now()): CodexWorkerReading | undefined {
  if (!parent || !UUID.test(parent)) {
    readings.delete(pane)
    return undefined
  }
  let r = readings.get(pane)
  if (!r || r.parent !== parent) {
    r = { parent, checkedAt: -Infinity, pending: false, value: { workers: [], status: 'unknown' }, rollouts: new Map() }
    readings.set(pane, r)
  }
  if (!r.pending && now - r.checkedAt >= CHECK_MS) {
    r.pending = true
    r.checkedAt = now
    const owned = r
    const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    const args = [...(process.platform === 'win32' ? ['-3'] : []), '-c', QUERY, join(home, 'state_5.sqlite'), parent]
    execFile(process.platform === 'win32' ? 'py' : 'python3', args, { windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (readings.get(pane) !== owned) return
      owned.pending = false
      try {
        if (error) throw error
        const rows: string[][] = JSON.parse(stdout)
        if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || !UUID.test(row[0]) || typeof row[1] !== 'string')) throw new Error('Unknown native schema')
        const kept = rows.slice(0, LIMIT)
        const ids = new Set(kept.map(row => row[0]))
        for (const id of owned.rollouts.keys()) if (!ids.has(id)) owned.rollouts.delete(id)
        owned.value = { workers: kept.map(row => worker(row, owned.rollouts, Date.now())), status: rows.length > LIMIT ? 'limited' : 'fresh' }
      } catch {
        owned.value = { workers: owned.value.workers.map(w => ({ ...w, state: w.state === 'running' ? 'stale' : w.state })), status: 'unknown' }
      }
    })
  }
  return r.value
}

export function forgetCodexWorkers(pane: string): void { readings.delete(pane) }
