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
// Older Codex has no tokens_used column: select null there so workers still list.
// UNION (not UNION ALL) stops a looping descendant walk.
const QUERY = `import sqlite3,json,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True,timeout=1)
c.execute('pragma query_only=ON')
k='tokens_used' in [x[1] for x in c.execute('pragma table_info(threads)')]
r=c.execute('select t.id,t.rollout_path,t.agent_nickname,t.agent_path,'+('t.tokens_used' if k else 'null')+' from thread_spawn_edges e join threads t on t.id=e.child_thread_id where e.parent_thread_id=? order by t.created_at desc limit 21',(sys.argv[2],)).fetchall()
p=d=None
if k:
 x=c.execute('select tokens_used from threads where id=?',(sys.argv[2],)).fetchone()
 p=x[0] if x else None
 d=c.execute('with recursive a(id) as (select child_thread_id from thread_spawn_edges where parent_thread_id=? union select e.child_thread_id from thread_spawn_edges e join a on e.parent_thread_id=a.id) select sum(t.tokens_used) from a join threads t on t.id=a.id',(sys.argv[2],)).fetchone()[0]
print(json.dumps({'rows':r,'parent':p,'descendants':d}))`

interface RolloutReading {
  file: string
  offset: number
  model?: string
  effort?: string
  state: CodexWorker['state']
  turn?: string
  startedAt?: number
  endedAt?: number
  updatedAt?: number
  /** Newest native token total in the read tail. */
  tokens?: number
  /** Newest tool call in plain words, and when it was made. */
  action?: string
  actionAt?: number
  skipFirst?: boolean
  /** The first read began mid-file, so a task may have started before it. */
  partial?: boolean
  head?: { turn?: string; model?: string; effort?: string; startedAt?: number }
}
interface Reading {
  parent: string
  checkedAt: number
  pending: boolean
  value: CodexWorkerReading
  rollouts: Map<string, RolloutReading>
}
const readings = new Map<string, Reading>()
type Row = [string, string, string | null, string | null, unknown]

const STEP_CHARS = 60
const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
/** Plain text of a value; encrypted blobs (`gAAAAA...`) and empty strings say nothing. */
function plain(v: unknown): string | undefined {
  const parts = Array.isArray(v) ? v : [v]
  const kept = parts.filter((x): x is string => typeof x === 'string' && !!x.trim() && !x.trim().startsWith('gAAAAA'))
  if (!kept.length || kept.length !== parts.length) return undefined
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}
function cut(text: string): string {
  const chars = Array.from(text)
  return chars.length > STEP_CHARS ? chars.slice(0, STEP_CHARS - 1).join('') + '\u2026' : text
}

/** One quoted string value of `key` in a script's object literal ("", '' or ``). */
function scriptValue(script: string, key: string): string | undefined {
  const m = script.match(new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`)`))
  if (!m) return undefined
  try { return m[1][0] === '"' ? JSON.parse(m[1]) : m[1].slice(1, -1) } catch { return m[1].slice(1, -1) }
}

/** An add-on tool is named `[mcp__]<add-on>__<tool>`: `mcp__node_repl__js` -> `node repl: js`. */
function addOn(name: string): string | undefined {
  const m = /^(?:mcp__)?(.+?)__(.+)$/.exec(name)
  return m ? `${m[1].replace(/_+/g, ' ')}: ${m[2].replace(/_+/g, ' ')}` : undefined
}

/**
 * One tool call in words a non-coder reads. `raw` is a function call's JSON argument string or
 * a custom tool call's raw input. Never throws. Same wording as the CLI reader
 * (`claude-memory/codex/scripts/codex-agents.mjs` `describeStep`).
 */
export function describeStep(name: string, raw: unknown): string {
  let args: Record<string, unknown> = {}
  let script: string | undefined
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
    } catch { script = raw }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw as Record<string, unknown>
  // Code mode: a custom `exec` input is a short script. Name the first tool it calls and
  // never put the script itself on screen.
  if (name === 'exec' && script !== undefined) {
    const call = script.match(/tools\.(\w+)\(/)
    if (!call) return 'Running a script'
    const rest = script.slice(call.index)
    return describeStep(call[1], { cmd: scriptValue(rest, 'cmd'), path: scriptValue(rest, 'path'), chars: scriptValue(rest, 'chars'), task_name: scriptValue(rest, 'task_name') })
  }
  // Other raw input: its first line, unless it is broken JSON (never shown).
  const text = script !== undefined && !script.trimStart().startsWith('{') ? script.split('\n').map(l => l.trim()).find(Boolean) : undefined
  const base = (v: unknown): string | undefined => plain(v)?.split(/[\\/]/).filter(Boolean).pop()
  const detail = (words: string, value: string | undefined): string => cut(value ? `${words}: ${value}` : words)
  switch (name) {
    case 'exec_command': case 'shell': case 'shell_command': case 'local_shell': case 'exec':
      return detail('Running a command', plain(args.cmd) ?? plain(args.command) ?? plain(text))
    case 'wait': return 'Checking on a running command'
    case 'write_stdin': return typeof args.chars === 'string' && args.chars && !args.chars.startsWith('gAAAAA') ? 'Typing into a running command' : 'Checking on a running command'
    case 'wait_agent': return 'Waiting for its helpers'
    case 'spawn_agent': return detail('Starting a helper', plain(args.task_name))
    case 'send_input': case 'send_message': case 'followup_task': return 'Messaging a helper'
    case 'close_agent': return 'Closing a helper'
    case 'apply_patch': return 'Editing files'
    case 'read_file': { const b = base(args.path); return cut(b ? `Reading ${b}` : 'Reading a file') }
    case 'write_file': { const b = base(args.path); return cut(b ? `Writing ${b}` : 'Writing a file') }
    case 'view_image': return 'Looking at an image'
    case 'search_contents': case 'grep': case 'rg': return 'Searching files'
    case 'list_items': case 'list_dir': return 'Listing files'
    case 'update_plan': return 'Updating its plan'
    case 'web_search': case 'search': case 'web__run': return 'Searching the web'
    default: return cut(`Using ${addOn(name) ?? (name || 'a tool')}`)
  }
}

/** Only native task events prove activity; model and effort come from executed contexts. */
export function scanWorkerLines(r: RolloutReading, text: string): void {
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line)
      const p = record.payload
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
      if (Number.isFinite(at)) r.updatedAt = at
      if (record.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call') && typeof p.name === 'string' && p.name) {
        r.action = describeStep(p.name, p.type === 'function_call' ? p.arguments : p.input)
        r.actionAt = Number.isFinite(at) ? at : undefined
      } else if (record.type === 'turn_context') {
        if (typeof p?.model === 'string') r.model = p.model
        if (typeof p?.effort === 'string') r.effort = p.effort
      } else if (record.type === 'event_msg') {
        if (p?.type === 'token_count') {
          const total = count(p.info?.total_token_usage?.total_tokens)
          if (total !== undefined) r.tokens = total
        } else if (p?.type === 'task_started') {
          r.turn = p.turn_id
          r.state = 'running'
          r.startedAt = Number.isFinite(at) ? at : undefined
          r.endedAt = undefined
          r.model = undefined
          r.effort = undefined
        } else if ((p?.type === 'task_complete' || p?.type === 'turn_aborted') && (!r.turn || p.turn_id === r.turn)) {
          r.turn = p.turn_id
          r.state = p.type === 'task_complete' ? 'completed' : 'interrupted'
          r.endedAt = Number.isFinite(at) ? at : undefined
        }
      }
    } catch { /* A partial/unknown record says nothing. */ }
  }
}

function worker(row: Row, readings: Map<string, RolloutReading>, now: number): CodexWorker {
  const [id, file, nickname, path] = row
  const tokensOf = (rollout?: number): number | undefined => {
    const known = [count(row[4]), rollout].filter((n): n is number => n !== undefined)
    return known.length ? Math.max(...known) : undefined
  }
  const name = path?.split('/').filter(Boolean).pop() || nickname || id.slice(0, 8)
  let r = readings.get(id)
  try {
    const stat = statSync(file)
    let start = r?.file === file && stat.size >= r.offset ? r.offset : Math.max(0, stat.size - READ_BYTES)
    if (!r || r.file !== file || stat.size < r.offset || stat.size - start > READ_BYTES) {
      start = Math.max(0, stat.size - READ_BYTES)
      // A record bigger than the read tail restarts the read; the same file's last step and
      // tokens stay until newer ones are read (PC "Hume" 2026-10-03: 3 records in 256 KB).
      const kept = r?.file === file ? { tokens: r.tokens, action: r.action, actionAt: r.actionAt } : {}
      r = { file, offset: start, state: 'unknown', skipFirst: start > 0, partial: start > 0, ...kept }
      readings.set(id, r)
      // A long first turn may put its executed context outside the tail. Apply
      // a bounded head candidate only to the SAME proven tail turn.
      if (start > 0) {
        const head = Buffer.alloc(Math.min(READ_BYTES, start))
        const fd = openSync(file, 'r')
        try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
        const context: RolloutReading = { file, offset: 0, state: 'unknown' }
        scanWorkerLines(context, head.subarray(0, head.lastIndexOf(10) + 1).toString('utf8'))
        r.head = { turn: context.turn, model: context.model, effort: context.effort, startedAt: context.startedAt }
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
        if (r.turn && r.turn === r.head?.turn) {
          r.model ??= r.head.model
          r.effort ??= r.head.effort
          r.startedAt ??= r.head.startedAt
        }
        r.offset = start + end + 1
      }
    }
    // Newer of last event and file time: NTFS holds the modified time of a file Codex keeps
    // open (PC "Hume" 2026-10-03: mtime 2 h 7 min behind the last event while it worked).
    const seen = Math.max(r!.updatedAt ?? -Infinity, stat.mtimeMs)
    // A long task's start can sit far before the read tail (PC "Hume": ~80 MB). A finished
    // task ends with its finish near the end, so dated events with no task event at all =
    // in progress. Start time and model stay unknown: that turn is not proven.
    const observed = r!.state === 'unknown' && !r!.turn && r!.partial && r!.updatedAt !== undefined ? 'running' : r!.state
    const state = observed === 'running' && now - seen > STALE_MS ? 'stale' : observed
    return { id, name, nickname: nickname || undefined, model: r!.model, effort: r!.effort, state,
      startedAt: r!.startedAt, endedAt: r!.endedAt, updatedAt: r!.updatedAt,
      tokens: tokensOf(r!.tokens), action: r!.action, actionAt: r!.actionAt }
  } catch {
    return { id, name, nickname: nickname || undefined, model: r?.model, effort: r?.effort, state: 'unknown',
      tokens: tokensOf(r?.tokens), action: r?.action, actionAt: r?.actionAt }
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
        const out: { rows?: unknown; parent?: unknown; descendants?: unknown } = JSON.parse(stdout)
        const rows = out?.rows
        if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || !UUID.test(row[0]) || typeof row[1] !== 'string')) throw new Error('Unknown native schema')
        const kept = (rows as Row[]).slice(0, LIMIT)
        const ids = new Set(kept.map(row => row[0]))
        for (const id of owned.rollouts.keys()) if (!ids.has(id)) owned.rollouts.delete(id)
        const workers = kept.map(row => worker(row, owned.rollouts, Date.now()))
        // Helpers' own helpers count too: the database sum walks every level below this chat.
        const listed = workers.filter(w => w.tokens !== undefined)
        const shares = [count(out.descendants), listed.length ? listed.reduce((sum, w) => sum + w.tokens!, 0) : undefined].filter((n): n is number => n !== undefined)
        owned.value = { workers, status: rows.length > LIMIT ? 'limited' : 'fresh',
          parentTokens: count(out.parent), subagentTokens: shares.length ? Math.max(...shares) : undefined }
      } catch {
        owned.value = { ...owned.value, workers: owned.value.workers.map(w => ({ ...w, state: w.state === 'running' ? 'stale' : w.state })), status: 'unknown' }
      }
    })
  }
  return r.value
}

export function forgetCodexWorkers(pane: string): void { readings.delete(pane) }
