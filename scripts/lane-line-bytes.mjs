// How much lane text the prompt hook puts into Claude chats, per prompt, on this machine.
//
// Reads the main-thread Claude Code transcripts under ~/.claude/projects, takes the newest N
// prompts (default 900) and prints, in bytes per prompt:
//
//   every  the line on every prompt of a chat that has one (how it was until 2026-09-26)
//   live   what the installed hook really injected (its `Assigning lane...` rows)
//   after  a replay of lane-hook.mjs since 2026-10-09: once per change of who holds which
//          checkout, again after each SessionStart (lane-once-test)
//
// A prompt the hook stayed quiet on is replayed with that chat's last printed table, so
// `after` is an upper bound: a chat that went quiet (no other chat in the repo) is counted
// as if it would print again after a SessionStart. Transcript rows copied into a resumed
// session's file are counted once (by uuid).
//
//   node scripts/lane-line-bytes.mjs [prompts]

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const N = Number(process.argv[2]) || 900
const root = join(homedir(), '.claude', 'projects')
const files = []
for (const d of readdirSync(root)) {
  let names = []
  try {
    names = readdirSync(join(root, d))
  } catch {
    continue
  }
  for (const f of names) if (f.endsWith('.jsonl')) files.push(join(root, d, f))
}
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const events = []
const uuids = new Set()
let prompts = 0
for (const f of files) {
  // Newest files first; stop once well past N prompts (resumed chats reach further back).
  if (prompts > N * 3) break
  let text = ''
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    // Cheap test before parsing: tool calls and replies are most of every file.
    if (!(line.includes('Assigning lane') || line.includes('SessionStart:') || line.includes('queued_command') || (line.startsWith('{"parentUuid"') && line.includes('"type":"user"') && !line.includes('"tool_use_id"')))) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.isSidechain || !r.uuid || uuids.has(r.uuid)) continue
    uuids.add(r.uuid)
    const t = Date.parse(r.timestamp ?? '')
    const sid = r.sessionId
    const a = r.attachment
    if (!t || !sid) continue
    if (r.type === 'user' && !r.isMeta && !r.isCompactSummary) {
      const c = r.message?.content
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((x) => x?.type === 'tool_result'))) {
        events.push({ t, sid, kind: 'prompt' })
        prompts++
      }
    } else if (a?.type === 'queued_command') {
      events.push({ t, sid, kind: 'prompt' })
      prompts++
    } else if (a?.type === 'hook_success' && a.hookName === 'UserPromptSubmit' && a.command === 'Assigning lane...' && a.content) {
      events.push({ t, sid, kind: 'lane', text: a.content })
    } else if (a?.type === 'hook_success' && /^SessionStart:/.test(a.hookName ?? '')) {
      events.push({ t, sid, kind: 'start' })
    }
  }
}
events.sort((a, b) => a.t - b.t)
const all = events.filter((e) => e.kind === 'prompt')
if (!all.length) {
  console.log('no prompts found')
  process.exit(1)
}
const from = all[Math.max(0, all.length - N)].t

// lane-hook.mjs keys on the table WITHOUT another chat's progress word; same rule on the text.
const PROGRESS = /another chat: (finished but conflicting with \S+|finished, waiting for the release|mid-edit, uncommitted changes|\d+ commits?, not marked done yet|no work yet)/
const claimsOf = (text) => text.split('\n').map((l) => l.replace(PROGRESS, 'another chat')).join('\n')
const bytes = (s) => Buffer.byteLength(s)

const chats = new Map() // sid -> { last: printed text, told: claims key since SessionStart }
const sum = { n: 0, every: 0, live: 0, livePrints: 0, after: 0, afterPrints: 0 }
const open = new Map() // sid -> the prompt whose hook output is still arriving
const settle = (p) => {
  const c = chats.get(p.sid) ?? {}
  chats.set(p.sid, c)
  if (p.printed) c.last = p.printed
  const text = p.printed ?? c.last
  if (p.inWindow) sum.n++
  if (!text) return
  const key = claimsOf(text)
  const says = c.told !== key
  c.told = key
  if (!p.inWindow) return
  sum.every += bytes(text)
  if (p.printed) {
    sum.live += bytes(p.printed)
    sum.livePrints++
  }
  if (says) {
    sum.after += bytes(text)
    sum.afterPrints++
  }
}
for (const e of events) {
  if (e.kind === 'start') {
    if (open.has(e.sid)) settle(open.get(e.sid))
    open.delete(e.sid)
    const c = chats.get(e.sid)
    if (c) c.told = undefined
  } else if (e.kind === 'prompt') {
    if (open.has(e.sid)) settle(open.get(e.sid))
    open.set(e.sid, { sid: e.sid, inWindow: e.t >= from, printed: null })
  } else if (open.has(e.sid)) {
    open.get(e.sid).printed = e.text
  }
}
for (const p of open.values()) settle(p)

const per = (b) => Math.round(b / sum.n)
const day = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
console.log(
  `prompts=${sum.n} from=${day(from)}Z to=${day(events.at(-1).t)}Z ` +
    `every=${per(sum.every)} live=${per(sum.live)} after=${per(sum.after)} B/prompt ` +
    `(prints: live ${sum.livePrints}, after ${sum.afterPrints})`
)
