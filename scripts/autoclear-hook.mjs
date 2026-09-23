#!/usr/bin/env node
// Auto-clear, shipped with the app: Claude Code's Stop and SessionStart hook.
//
// A pane whose session has grown past the context line is cleared and continued from a
// handoff file. Until this file existed the hook doing that lived in one person's private
// notes repo, so the feature worked on exactly one machine. This one is self-contained
// (node builtins only) and ships as an extraResource; `src/main/autoclearHooks.ts` wires
// it into ~/.claude/settings.json.
//
//   --event=stop   past the line with no fresh handoff -> exit 2 once, asking the session
//                  to write one (Claude Code shows stderr to the model, which carries on).
//                  With a fresh handoff that has open steps -> write a request file the
//                  app picks up (`src/main/autoclearRequests.ts`) and counts down from.
//   --event=start  after a /clear, hand the fresh session the handoff as context.
//
// It never talks to the app over the network: the request is a file in the app's own
// folder. It does nothing outside a PaneForge pane (no PF_PANE), or with AUTOCLEAR=off.
//
// The handoff path MUST be the one the app reads, so `slugFor`, `paneSlot`,
// `handoffCandidates` and the Next-steps judgement are mirrors of src/shared/handoffSteps.ts.
// scripts/autoclear-hook-test.mjs holds the two copies to the same answers.

import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_AT = 180_000
/** A handoff older than this is about earlier work, not this turn. */
const FRESH_MS = 30 * 60_000
/** SessionStart hands over a handoff only this young. */
const INJECT_MS = 2 * 60 * 60_000
/** The handoff reader's own ceiling (`main/handoffSteps.ts`). */
const MAX_HANDOFF = 64 * 1024
/** How much of the transcript's end is read for the last usage row. */
const TAIL_BYTES = 4 * 1024 * 1024
const LOG_MAX = 256 * 1024

// ---------------------------------------------------------------- mirrors of shared/handoffSteps.ts

export function slugFor(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9-]/g, '-')
}

export function paneSlot(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || '')) ? `.pane-${id}` : ''
}

export function handoffCandidates(cwd, paneId, claudeHome, symlinked) {
  const dir = String(cwd || '')
  const parts = dir.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? ''
  const out = []
  const add = (proj, name) => {
    const p = `${claudeHome}/projects/${proj}/memory/${name}`
    if (!out.includes(p)) out.push(p)
  }
  const cwdSlot = (d) => (symlinked(`${claudeHome}/projects/${slugFor(d)}`) ? '.' + (d.split(/[\\/]/).pop() ?? '') : '')
  const proj = slugFor(dir)
  const cslot = cwdSlot(dir)
  add(proj, `session-handoff${paneSlot(paneId) || cslot}.md`)
  if (cslot) add(proj, `session-handoff${cslot}.md`)
  add(proj, 'session-handoff.md')
  const main = dir.replace(/-[a-z]$/, '')
  if (main !== dir) {
    if (paneSlot(paneId)) add(slugFor(main), `session-handoff${paneSlot(paneId)}.md`)
    add(slugFor(main), `session-handoff.${base}.md`)
    add(slugFor(main), 'session-handoff.md')
  }
  return out
}

export function openNextSteps(md) {
  const text = String(md || '')
  const start = text.search(/^#{1,4}\s*Next steps\b/im)
  if (start < 0) return []
  const rest = text.slice(start).split('\n').slice(1)
  const steps = []
  for (const raw of rest) {
    if (/^#{1,4}\s/.test(raw)) break
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)
    if (!m) continue
    const body = m[1].replace(/^\[[ xX]\]\s*/, '').replace(/\*\*/g, '').trim()
    if (!body) continue
    if (/^(none|nothing|n\/a|-)\b/i.test(body)) continue
    steps.push(body)
  }
  return steps
}

const BLOCKED_OPENER =
  /^(only\b|once\b|after\b|when\b|whenever\b|if\b|wait\b|waiting\b|blocked\b|pending\b|watch\b|monitor\b|leave\b|keep an eye\b)/i
const PERSON_OWNED =
  /\b(your call|his call|her call|their call|robert\b|you own|you decide|you:|ask (?:him|her|them)|needs? (?:a )?(?:purchase|payment|password|credential|passphrase|approval)|sign in|log in|buy\b|approve\b)/i

export function actionableNextSteps(md) {
  return openNextSteps(md).filter((body) => !BLOCKED_OPENER.test(body) && !PERSON_OWNED.test(body))
}

// ---------------------------------------------------------------- this machine

/** Same override the app's handoff reader honours (`main/handoffSteps.ts`). */
export function claudeHome() {
  return process.env.PF_CLAUDE_HOME || join(homedir(), '.claude')
}

/** The app's userData folder when no --user-data was given: Electron's default for this app name. */
export function defaultUserData() {
  const name = 'claude-orchestrator'
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), name)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name)
}

function symlinked(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** This pane's own handoff: the pane-scoped slot, the file the block message names. */
export function paneHandoffPath(cwd, paneId) {
  return handoffCandidates(cwd, paneId, claudeHome(), symlinked)[0]
}

function readHandoff(path) {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_HANDOFF) return null
    return { path, mtimeMs: st.mtimeMs, text: readFileSync(path, 'utf8') }
  } catch {
    return null
  }
}

/** input + cache_read + cache_creation of the last assistant row that carries usage. */
export function contextTokens(transcriptPath) {
  let fd
  try {
    fd = openSync(transcriptPath, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || line[0] !== '{') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.type !== 'assistant') continue
      const u = row.message?.usage
      if (!u) continue
      return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    }
  } catch {
    /* no transcript is no evidence */
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return 0
}

/**
 * Ids of this session's background subagents still in flight, read off its transcript.
 * `/clear` restarts the CLI and kills them; a Bash background job survives it, which is
 * why the app no longer refuses over one (`autoClearAsk` in `src/main/index.ts`) and this
 * is the one refusal left. A background `Agent` launch answers `Async agent launched ...
 * agentId: X` (a `SendMessage` resume answers `resumedAgentId`) and reports back as a
 * `<task-notification>` with the same `<tool-use-id>`; a launch with no notification is
 * still running. Mirrors `runningAgentsOf` in the private hook; unreadable = [] (a
 * transcript we cannot read never blocks the clear forever).
 */
export function runningAgents(transcriptPath) {
  let text
  try {
    text = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const answered = new Map()
  const launched = new Set()
  const notified = new Set()
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.includes('<task-notification>')) {
      for (const m of line.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) notified.add(m[1])
      continue
    }
    if (!/"tool_use"|"tool_result"/.test(line)) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const content = row?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type === 'tool_use' && (c.name === 'Agent' || c.name === 'SendMessage')) launched.add(c.id)
      else if (c?.type === 'tool_result' && launched.has(c.tool_use_id) && !c.is_error) {
        const t = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x?.text || '').join('\n')
        const id = t.match(/Async agent launched[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/)?.[1] ?? t.match(/"resumedAgentId"\s*:\s*"([^"]+)"/)?.[1]
        if (id) answered.set(c.tool_use_id, id)
      }
    }
  }
  return [...answered].filter(([use]) => !notified.has(use)).map(([, id]) => id)
}

export function blockMessage(tokens, threshold, path) {
  return (
    `AUTO-CLEAR: this session is at ~${Math.round(tokens / 1000)}k tokens of context, past the ${Math.round(threshold / 1000)}k line, ` +
    `and this pane has no fresh handoff. Write one now to exactly this path:\n${path}\n` +
    `It needs a \`## State\` section (what is done, whether it is verified, what is mid-flight, the key files) and a ` +
    `\`## Next steps\` numbered list of what is genuinely still open. If nothing is left, put the single word None under ` +
    `\`## Next steps\` and no clear happens. A step waiting on an event or on a person counts as nothing to do.\n` +
    `Then end your turn. PaneForge counts down, clears this pane, and the fresh session starts from that file - nothing else survives.`
  )
}

// ---------------------------------------------------------------- I/O

function arg(argv, name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='))
  if (i < 0) return undefined
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1]
}

/**
 * Written straight to the descriptor (the caller ends with `process.exit`). Stdout is
 * ASCII-escaped: on Windows without Node the output passes through PowerShell's pipe
 * (`laneHooks.ts` `runnerFor`), which would re-decode UTF-8 in the console code page.
 */
function put(fd, text) {
  const buf = Buffer.from(fd === 1 ? text.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : text)
  let off = 0
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off)
    } catch (e) {
      if (e?.code !== 'EAGAIN') return
    }
  }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function makeLog(dir) {
  return (line) => {
    try {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'autoclear-hook.log')
      try {
        if (statSync(file).size > LOG_MAX) renameSync(file, file + '.old')
      } catch {
        /* first line */
      }
      appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* the log must never be what breaks the hook */
    }
  }
}

function stateFile(dir, sessionId) {
  return join(dir, 'autoclear-hook', `${String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveState(file, state) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(state))
  } catch {
    /* worst case: asked twice */
  }
}

/** Returns the exit code; stdout/stderr are written here. */
export function run(argv, input, env = process.env, now = Date.now()) {
  if (String(env.AUTOCLEAR || '').toLowerCase() === 'off') return 0
  const pane = String(env.PF_PANE || '')
  if (!/^[A-Za-z0-9_-]+$/.test(pane)) return 0 // not a PaneForge pane
  const event = arg(argv, '--event')
  const dir = arg(argv, '--user-data') || defaultUserData()
  const log = makeLog(dir)
  const sid = String(input.session_id || '')
  const cwd = String(input.cwd || process.cwd())
  const sfile = stateFile(dir, sid)
  const state = loadState(sfile)
  const handoffPath = paneHandoffPath(cwd, pane)
  const tag = `pane=${pane} session=${sid.slice(0, 8)}`

  if (event === 'start') {
    if (input.source !== 'clear') return 0
    const h = readHandoff(handoffPath)
    if (!h || now - h.mtimeMs > INJECT_MS) {
      log(`start ${tag} no-handoff ${handoffPath}`)
      return 0
    }
    // This session is being resumed FROM this file; its Stop must not read it as fresh
    // and clear again before any of the work is done.
    saveState(sfile, { ...state, consumedMtime: h.mtimeMs })
    const additionalContext = `SESSION HANDOFF (${h.path}) - the previous session in this pane was cleared and left this for you. Work its Next steps in order and do not re-do finished items.\n\n${h.text}`
    put(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }))
    log(`start ${tag} injected ${h.path}`)
    return 0
  }

  if (event !== 'stop') return 0
  const threshold = Number(env.AUTOCLEAR_AT) > 0 ? Number(env.AUTOCLEAR_AT) : DEFAULT_AT
  const tokens = input.transcript_path ? contextTokens(String(input.transcript_path)) : 0
  if (tokens < threshold) {
    log(`stop ${tag} under ${tokens}/${threshold}`)
    return 0
  }
  if (state.requested) {
    log(`stop ${tag} already-requested ${tokens}`)
    return 0
  }
  const h = readHandoff(handoffPath)
  const fresh = !!h && now - h.mtimeMs <= FRESH_MS && h.mtimeMs !== state.consumedMtime
  if (!fresh) {
    // stop_hook_active: this Stop is the continuation a block of ours started. Never block
    // twice in a row, and never twice per session - a session that will not write one is
    // left alone rather than wedged.
    if (input.stop_hook_active === true || state.blocked) {
      log(`stop ${tag} already-asked ${tokens}`)
      return 0
    }
    saveState(sfile, { ...state, blocked: now })
    put(2, blockMessage(tokens, threshold, handoffPath) + '\n')
    log(`stop ${tag} block ${tokens}/${threshold} -> ${handoffPath}`)
    return 2
  }
  const steps = actionableNextSteps(h.text)
  if (!steps.length) {
    log(`stop ${tag} no-open-steps ${h.path}`)
    return 0
  }
  // Not recorded as requested: the next Stop after the agent reports back asks again.
  const agents = input.transcript_path ? runningAgents(String(input.transcript_path)) : []
  if (agents.length) {
    log(`stop ${tag} agent-running ${agents.join(',')}`)
    return 0
  }
  const request = {
    paneId: pane,
    steps: steps.slice(0, 12),
    prompt: `Continue the handoff at ${h.path.replace(/\\/g, '/')}: work its Next steps in order, and do not re-do finished items.`,
    handoffPath: h.path.replace(/\\/g, '/'),
    at: now
  }
  try {
    const reqDir = join(dir, 'autoclear-requests')
    mkdirSync(reqDir, { recursive: true })
    const file = join(reqDir, `${pane}.json`)
    // Write then rename: the app's watcher reads only *.json, never a half-written one.
    writeFileSync(file + '.tmp', JSON.stringify(request))
    renameSync(file + '.tmp', file)
  } catch (e) {
    log(`stop ${tag} request-failed ${e?.message ?? e}`)
    return 0
  }
  saveState(sfile, { ...state, requested: now })
  log(`stop ${tag} requested ${steps.length} step(s) ${tokens}/${threshold}`)
  return 0
}

// By name, not by URL: a drive letter's case differs between argv and import.meta.url.
const invoked = /autoclear-hook\.mjs$/.test(String(process.argv[1] || '').replace(/\\/g, '/'))
if (invoked) {
  let code = 0
  try {
    code = run(process.argv.slice(2), readStdin())
  } catch (e) {
    // A crash here must never hold a session: exit 0, say why on stderr.
    put(2, `autoclear-hook: ${e?.message ?? e}\n`)
    code = 0
  }
  process.exit(code)
}
