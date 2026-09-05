// Clearing a pane that has no Stop hook to speak for it.
//
// The claude path is decided by `claude-config/autoclear.mjs`, which runs INSIDE the
// session, knows the token count exactly and asks this app for a countdown. Codex and
// Antigravity have no such hook, so the same job has to be done from the outside: read
// the size the CLI writes down for itself, and arm the same countdown when it is past the
// line. Everything visible to the user is identical - the same card, the same Keep
// button, the same refusals - because this is a second way of DECIDING, not a second way
// of clearing.
//
// Two rules hold the whole file up:
//
// 1. An agent whose clear command we cannot name is never typed into. `clearCommandFor`
//    returns null for it and this loop skips it for ever. The cost of guessing is a slash
//    command sent as a PROMPT into somebody's live session.
// 2. An estimate we cannot make is not an estimate of zero, and not a reason to act. Every
//    reader here returns null on anything it does not understand, and null means skip.

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AUTOCLEAR,
  clearCommandFor,
  resumeBrief,
  watchDecision,
  type AutoClearConfig
} from '../shared/autoclear'
import { backJobOf } from './usage'
import { handoffFor } from './handoffSteps'
import { acLog } from './autoclearLog'
import type { Session } from '../shared/types'
import { ensureAntigravityBridge, PF_CONTEXT_FILE, antigravityDir } from './antigravityBridge'
import { getConfig } from './config'
import type { AutoClearArm, SessionManager } from './sessions'

/**
 * A minute. The thing being watched moves at the speed of a turn ending, and the reading
 * comes off a file the CLI wrote whenever it last felt like it - so a tighter poll reads
 * the same number more often and a looser one lets a session grow another turn.
 */
const TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let manager: SessionManager | null = null
/** pane id -> when this watcher last armed it. The cooldown in `watchDecision`. */
const armedAt = new Map<string, number>()

/** A fresh handoff is a turn, not a polling race. Never clear while it is being prepared. */
const HANDOFF_TIMEOUT_MS = 5 * 60_000
const HANDOFF_REQUEST =
  'Write the canonical session handoff now. Preserve the current objective, work state, changed files or commits, verification, and only actionable Next steps. Do not begin new work after writing it.'
const CONTINUE_HANDOFF = 'Continue the handoff: work its Next steps in order, and do not re-do finished items.'

type Preparing = { startedAt: number; beforeMtime: number; tokens: number }
const preparing = new Map<string, Preparing>()

function config(): AutoClearConfig {
  return { ...DEFAULT_AUTOCLEAR, ...(getConfig().autoClear ?? {}) }
}

/**
 * Read the first line of a file without reading the file.
 *
 * Codex's session meta is line one of a rollout, and it carries the whole system prompt -
 * tens of kilobytes - while the rollout itself can be megabytes. `readFileSync` on every
 * candidate, once a minute, for every codex pane, is a lot of disk for one `cwd` field.
 */
function firstLine(path: string, cap = 512 * 1024): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(64 * 1024)
    let text = ''
    while (text.length < cap) {
      const n = readSync(fd, buf, 0, buf.length, text.length)
      if (n <= 0) break
      text += buf.subarray(0, n).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) return text.slice(0, nl)
    }
    return text ? text : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The last `bytes` of a file, as text. Used to find the newest row without a full read. */
function tailText(path: string, bytes = 256 * 1024): string | null {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const from = Math.max(0, size - bytes)
    const len = size - from
    if (len <= 0) return null
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, from)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Every `rollout-*.jsonl` under ~/.codex/sessions, newest first. Dated dirs, depth 3. */
function rollouts(newerThan: number): { path: string; mtime: number }[] {
  const root = join(homedir(), '.codex', 'sessions')
  const found: { path: string; mtime: number }[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0) walk(p, depth - 1)
        continue
      }
      if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue
      try {
        const mtime = statSync(p).mtimeMs
        if (mtime >= newerThan) found.push({ path: p, mtime })
      } catch {
        /* it went away between the listing and the stat */
      }
    }
  }
  // YYYY / MM / DD, so three levels of directory below the root.
  walk(root, 3)
  return found.sort((a, b) => b.mtime - a.mtime)
}

/**
 * How much context this codex session is carrying, or null.
 *
 * MEASURED, not assumed, against
 * `~/.codex/sessions/2026/08/27/rollout-2026-08-27T14-38-45-01a04183-...jsonl` (127
 * `token_count` events, codex-cli 0.150.0-alpha.8). Two candidate fields, and only one of
 * them is the context:
 *
 *   - `total_token_usage.input_tokens` reached 14,138,311 against a
 *     `model_context_window` of 258,400. That is cumulative BILLING for the session, 54x
 *     the window, and reading it as context would clear every codex pane on its second turn.
 *   - `last_token_usage.input_tokens` ran 36,104 -> 184,182 -> 123,975 across the session,
 *     the second number being a compaction. That is the context.
 *
 * The spec's fallback formula was `input_tokens + cached_input_tokens`. It is wrong and is
 * deliberately not used: `cached_input_tokens` is a SUBSET of `input_tokens`, not a second
 * bucket - proved on the same row, where input 130,427 + output 1,441 equals `total_tokens`
 * 131,868 exactly, leaving no room for the 123,520 cached. Adding them reads 253,947 out of
 * a 258,400 window and would clear a pane that is barely half full.
 */
export function codexContextTokens(cwd: string, openedAt: number): number | null {
  // The pane's own rollout, and no older one: `openedAt` is when this pane appeared, so a
  // file last written before that belongs to some other codex session in the same folder.
  for (const { path } of rollouts(openedAt)) {
    const head = firstLine(path)
    if (!head) continue
    let meta: { payload?: { cwd?: string } }
    try {
      meta = JSON.parse(head) as { payload?: { cwd?: string } }
    } catch {
      continue
    }
    if (meta?.payload?.cwd !== cwd) continue
    const tail = tailText(path)
    if (!tail) return null
    const lines = tail.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue
      try {
        const row = JSON.parse(lines[i]) as {
          payload?: { info?: { last_token_usage?: { input_tokens?: number; total_tokens?: number } } }
        }
        const last = row.payload?.info?.last_token_usage
        const n = last?.input_tokens ?? last?.total_tokens
        return typeof n === 'number' && n > 0 ? n : null
      } catch {
        // A truncated first line is normal - the tail read starts mid-file - and every
        // other line here is a whole row, so keep walking backwards.
        continue
      }
    }
    return null
  }
  return null
}

/** One row of `pf-context.jsonl`, as the statusline hook pipes it. */
interface AgyRow {
  pf_ts?: number
  cwd?: string
  workspace?: { current_dir?: string }
  context_window?: {
    context_window_size?: number
    used_percentage?: number
    total_input_tokens?: number
    current_usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

function agyTokens(row: AgyRow): number | null {
  const c = row.context_window
  if (!c) return null
  if (typeof c.total_input_tokens === 'number' && c.total_input_tokens > 0) return c.total_input_tokens
  const u = c.current_usage
  if (u) {
    const n =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    if (n > 0) return n
  }
  // Last resort, and the least precise: a percentage rounded to a whole number of a window
  // that may itself be a default. Only ever used to compare against a threshold.
  if (typeof c.used_percentage === 'number' && typeof c.context_window_size === 'number') {
    const n = Math.round((c.used_percentage / 100) * c.context_window_size)
    if (n > 0) return n
  }
  return null
}

/** The newest rows the bridge wrote, newest first. */
function agyRows(): AgyRow[] {
  const path = join(antigravityDir(), PF_CONTEXT_FILE)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: AgyRow[] = []
  const lines = text.split('\n').filter(Boolean)
  // 40 is well past the number of statusline redraws a minute of one session produces, and
  // it bounds the parse on a file the hook may have been appending to for a week.
  for (let i = lines.length - 1; i >= 0 && out.length < 40; i--) {
    try {
      out.push(JSON.parse(lines[i]) as AgyRow)
    } catch {
      /* a half-written line at the end of an append is normal */
    }
  }
  return out
}

/**
 * How much context this antigravity pane is carrying, or null.
 *
 * The statusline hook is ONE file for the whole machine, and it is the CLI's file rather
 * than ours: every `agy` on this desk writes to it, including ones started in a plain
 * terminal that PaneForge has never heard of. So the newest row is not this pane's row, it
 * is whichever session redrew last - and attribution has to be by the row's own folder,
 * even when only one pane is open. When nothing separates them the answer is null, never a
 * guess: clearing a pane on some other session's size is the one outcome this cannot risk.
 *
 * `panes` only widens the one honest fallback - rows from a bridge old enough not to carry
 * a folder at all, with a single pane they could possibly be about.
 */
export function antigravityContextTokens(cwd: string, panes: number): number | null {
  const rows = agyRows()
  if (!rows.length) return null
  for (const row of rows) {
    const dir = row.workspace?.current_dir ?? row.cwd
    if (dir === cwd) return agyTokens(row)
  }
  if (panes <= 1 && !rows.some((r) => r.workspace?.current_dir ?? r.cwd)) return agyTokens(rows[0])
  return null
}

/** A codex or antigravity pane, or a claude one the env var has opted in. */
function watched(s: Session, claudeToo: boolean): boolean {
  if (!clearCommandFor(s.agent)) return false
  // Anything left that is not one of these two IS claude family - `clearCommandFor` only
  // answers for `bin === 'claude'` beyond them. Those panes belong to the Stop hook, which
  // knows the real token count; two things driving one pane is how a pane gets cleared
  // twice, so this side stays out unless somebody asks for it.
  if (s.agent === 'codex' || s.agent === 'antigravity') return true
  return claudeToo
}

function prepareOrArm(mgr: SessionManager, pane: Session, tokens: number, command: string, now: number): void {
  const prior = preparing.get(pane.id)
  if (prior) {
    if (now - prior.startedAt > HANDOFF_TIMEOUT_MS) {
      preparing.delete(pane.id)
      acLog(`${pane.id} handoff preparation timed out`)
      return
    }
    // The turn that writes the handoff is still running. Its own completion is the only
    // safe point to inspect the file: reading a half-written handoff as complete loses work.
    if (pane.status !== 'idle' || backJobOf(pane.id)) return
    const handoff = handoffFor(pane.cwd, pane.id, now)
    if (!handoff.path || handoff.mtimeMs <= prior.beforeMtime) return
    preparing.delete(pane.id)
    if (!handoff.open || !handoff.steps.length) {
      acLog(`${pane.id} handoff preparation refused: no actionable next steps`)
      return
    }
    const prompt = resumeBrief(
      { paneId: pane.id, steps: handoff.steps, prompt: CONTINUE_HANDOFF, seconds: config().seconds },
      handoff.path
    )
    const res = mgr.armAutoClear(pane.id, {
      steps: handoff.steps,
      prompt,
      seconds: config().seconds,
      command,
      tokens: prior.tokens
    })
    if (res.ok) armedAt.set(pane.id, now)
    acLog(`${pane.id} handoff ${res.ok ? 'validated and countdown armed' : `validated but countdown refused: ${res.reason ?? 'unknown'}`}`)
    return
  }
  const before = handoffFor(pane.cwd, pane.id, now).mtimeMs
  preparing.set(pane.id, { startedAt: now, beforeMtime: before, tokens })
  acLog(`${pane.id} handoff preparation requested at ${Math.round(tokens / 1000)}k context`)
  mgr.sendPrompt(pane.id, HANDOFF_REQUEST)
}

function tick(): void {
  const mgr = manager
  if (!mgr) return
  const cfg = config()
  if (!cfg.watchNonClaude) return
  const claudeToo = process.env.PF_AUTOCLEAR_CLAUDE_WATCH === '1'
  const panes = mgr.list()
  const live = new Set(panes.map((p) => p.id))
  for (const id of armedAt.keys()) if (!live.has(id)) armedAt.delete(id)
  for (const id of preparing.keys()) if (!live.has(id)) preparing.delete(id)
  const agyPanes = panes.filter((p) => p.agent === 'antigravity').length

  for (const pane of panes) {
    if (!watched(pane, claudeToo)) continue
    // Checked before the disk reads as well as inside `watchDecision`: a desk of four busy
    // panes should not walk ~/.codex/sessions four times a minute to be told no.
    // A preparation turn must be observed until it writes a fresh handoff or times out.
    // All other busy panes remain untouched.
    if (pane.status !== 'idle' && !preparing.has(pane.id)) continue
    if (pane.autoClearAt) continue
    // An agent pane that kicked off a build, a Monitor loop or a `run_in_background` shell
    // goes quiet the moment its turn ends: the footer stops, `engaged` drops, the card
    // reads finished - and clearing it now restarts the CLI on top of work that is still
    // going. `shared/paneBackJobs.ts` is the only reading that can see it.
    if (backJobOf(pane.id)) continue
    const tokens =
      pane.agent === 'codex'
        ? codexContextTokens(pane.cwd, pane.openedAt ?? pane.createdAt)
        : pane.agent === 'antigravity'
          ? antigravityContextTokens(pane.cwd, agyPanes)
          : null
    // Native compaction can legitimately drop the same session below the line while it is
    // writing a handoff. That is success, not a reason to use a now-stale handoff to clear
    // it later: abandon this preparation and let the next real threshold crossing decide.
    if (preparing.has(pane.id) && (tokens === null || tokens < cfg.tokens)) {
      preparing.delete(pane.id)
      acLog(`${pane.id} handoff preparation stood down: context is below the threshold`)
      continue
    }
    if (tokens === null) {
      // Said once per pane, not once per minute: with two antigravity panes and no cwd on
      // the rows this is the permanent state, and a line a minute about it is a log nobody
      // can read past.
      if (pane.agent === 'antigravity' && agyPanes > 1 && !warned.has(pane.id)) {
        warned.add(pane.id)
        console.info(
          `autoclear: ${pane.id} not watched - ${agyPanes} antigravity panes and no folder on the statusline rows to tell them apart`
        )
      }
      continue
    }
    const verdict = watchDecision({
      agent: pane.agent,
      status: pane.status,
      tokens,
      threshold: cfg.tokens,
      lastArmMs: armedAt.get(pane.id),
      now: Date.now()
    })
    if (preparing.has(pane.id)) {
      const command = clearCommandFor(pane.agent)
      if (command) prepareOrArm(mgr, pane, tokens, command, Date.now())
      continue
    }
    if (verdict !== 'arm') continue
    const command = clearCommandFor(pane.agent)
    if (!command) continue
    // Do not start a fresh CLI with an empty prompt. A non-Claude watcher has no semantic
    // transcript parser, so it first asks the active agent for its canonical handoff and
    // proceeds only when a newer actionable file proves what can safely continue.
    prepareOrArm(mgr, pane, tokens, command, Date.now())
  }
}

/** Panes already told about, so a permanent condition is logged once. */
const warned = new Set<string>()

/**
 * Start watching, and put the antigravity tee in place.
 *
 * The bridge is ensured HERE rather than at install time because it is the one moment
 * this app knows the CLI is on the machine and the user is running PaneForge anyway: it
 * is a no-op on a desk with no `~/.gemini/antigravity-cli`, and idempotent on one that
 * already has the block.
 */
export function startAutoClearWatch(mgr: SessionManager): void {
  manager = mgr
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      const r = ensureAntigravityBridge()
      if (r.changed) console.info(`autoclear: antigravity statusline bridge ${r.created ? 'written' : 'updated'}`)
    } catch (e) {
      // Never fatal. This runs during startup, and a statusline hook we could not edit is
      // one CLI unwatched, not an app that will not open.
      console.info(`autoclear: antigravity bridge skipped - ${String(e)}`)
    }
  }
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  timer.unref?.()
}

export function stopAutoClearWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
  manager = null
  armedAt.clear()
  warned.clear()
}
