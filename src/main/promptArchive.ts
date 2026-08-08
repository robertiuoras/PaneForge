// "You have asked this before."
//
// The expensive part of a repeated ask is never the typing — it is the agent re-reading the
// repo, re-searching GitHub and re-deriving an answer that already exists, at full token
// price, because nothing in the loop remembers that the question was settled in March. This
// is the thing that remembers.
//
// ─── why it lives in the app and not in a CLI hook ──────────────────────────────────────
//
// Claude Code can already do this for itself: a `UserPromptSubmit` hook sees the prompt and
// can inject a warning. Codex has no such hook, and neither does the next agent — there are
// thirteen in `shared/agents.ts` and the list grows. A per-CLI hook is therefore a feature
// that works for one agent, silently does nothing for the rest, and has to be rewritten
// every time a new one ships.
//
// PaneForge hosts the pty. `shared/draft.ts` already reconstructs what is being typed from
// the raw bytes, for every agent, without any of them knowing — which is how the improve
// chip works. So the archive is fed and read from there, and the answer is the same whether
// the pane is running Claude, Codex, or something that does not exist yet.
//
// ─── what it will not do ────────────────────────────────────────────────────────────────
//
// It never blocks, never types, never cancels. A repeat is often deliberate — the same
// deploy check every morning, a retry of something that failed. The whole of what happens by
// itself is a chip in the corner of the pane saying where the earlier ask went, on the same
// contract as the improve chip beside it. Being wrong therefore costs a glance, which is the
// budget a heuristic on somebody's half-typed sentence deserves.

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IDF_MIN_CORPUS,
  MIN_PROMPT_TOKENS,
  NEAR_MATCH,
  promptMatchWeighted,
  promptTokenIdf,
  promptTokens,
  QUIET_MS
} from '../shared/promptKey'
import type { PriorPrompt } from '../shared/types'

/**
 * One archived ask. Single letters because this file is appended to on every prompt anyone
 * types on this machine, forever, and the keys would otherwise be most of it.
 */
interface Entry {
  /** sha1 of the sorted token set — the dedupe key */
  h: string
  /** the significant tokens, stored so a lookup does not re-tokenise the whole archive */
  t: string[]
  /** a preview, capped: what gets shown, never what gets matched */
  x: string
  /** the project folder it was typed in */
  o: string | null
  /** which agent it was typed at — 'claude', 'codex', … */
  a: string | null
  /** how many times this exact ask has been made */
  n: number
  /** first and last use, ISO */
  f: string
  l: string
  /** what it produced, once anything knows — `<repo> <sha> <subject>` */
  out: string | null
}

/** The preview is only ever shown sliced to ~180 chars, so this is already generous. The
    full text is deliberately NOT kept: an archive of every prompt ever typed is a liability,
    and the tokens are all the matching needs. */
const TEXT_CAP = 300
const MAX_ENTRIES = 6000

let cache: Map<string, Entry> | null = null
let lines = 0
/** mtime of each external archive when it was last read, so a re-read only happens when the
    file has actually changed. */
const externalSeen = new Map<string, number>()
let external: Entry[] = []

function archivePath(): string {
  const dir = app.getPath('userData')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* it is the app's own data dir; if this fails nothing else works either */
  }
  return join(dir, 'prompt-archive.jsonl')
}

/** sha1 of the sorted token set. Lives here rather than in `shared/promptKey.ts` because
    `node:crypto` cannot cross into the renderer bundle, and the renderer only ever needs to
    display a match, never to compute a key. */
function promptHash(text: string): string {
  return createHash('sha1').update(promptTokens(text).join(' ')).digest('hex')
}

/**
 * The same fingerprint, for callers outside this file - D3's dispatch report carries it
 * so TaskDriver can find the `prompt_log` row this ask came from. A wrapper rather than
 * exporting `promptHash` itself, so the canonical algorithm keeps exactly one name inside
 * this file and `test:recall`'s parity contract keeps exactly one thing to check.
 */
export function promptFingerprint(text: string): string {
  return promptHash(text)
}

/**
 * Every entry, merged by hash, later line winning.
 *
 * Append-only with last-wins-on-read rather than a rewrite per prompt: two panes finishing a
 * prompt in the same instant would otherwise race for the file, and losing an archive row is
 * a silent wrong answer later rather than a visible failure now.
 */
function load(): Map<string, Entry> {
  if (cache) return cache
  const byHash = new Map<string, Entry>()
  lines = 0
  let raw = ''
  try {
    raw = readFileSync(archivePath(), 'utf8')
  } catch {
    cache = byHash
    return byHash
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    lines++
    try {
      const e = JSON.parse(line) as Entry
      if (!e?.h) continue
      const prev = byHash.get(e.h)
      byHash.set(e.h, prev ? { ...prev, ...e } : e)
    } catch {
      /* a torn line from a kill mid-append; the rest of the file is still good */
    }
  }
  cache = byHash
  return byHash
}

function append(e: Entry): void {
  try {
    appendFileSync(archivePath(), JSON.stringify(e) + '\n')
    lines++
  } catch {
    /* an archive that cannot be written is a feature that does nothing, not a broken app */
  }
}

/** Rewrite as one line per hash, newest MAX_ENTRIES kept. */
function compact(byHash: Map<string, Entry>): void {
  const all = [...byHash.values()].sort((a, b) => String(a.l).localeCompare(String(b.l)))
  const keep = all.slice(-MAX_ENTRIES)
  try {
    writeFileSync(archivePath(), keep.map((e) => JSON.stringify(e)).join('\n') + '\n')
    lines = keep.length
  } catch {
    /* next time */
  }
}

/**
 * Archives written by something else, merged in read-only.
 *
 * This is what makes the answer cover work done OUTSIDE this app — a prompt typed into a
 * bare terminal, or into Claude Code before PaneForge existed. Robert points it at the
 * shared store his own hooks write (`claude-memory/claude-config/prompt-log/prompts.jsonl`),
 * which also carries prompts posted in Discord; for everyone else it is empty and the
 * feature runs on the app's own history alone.
 *
 * Read-only on purpose. Writing into a file another tool owns means agreeing with it about a
 * format forever, and the two disagree already (it keeps fields this does not).
 */
function loadExternal(paths: string[]): Entry[] {
  let changed = false
  for (const p of paths) {
    let mtime = 0
    try {
      mtime = statSync(p).mtimeMs
    } catch {
      mtime = 0
    }
    if (externalSeen.get(p) !== mtime) {
      externalSeen.set(p, mtime)
      changed = true
    }
  }
  for (const seen of externalSeen.keys()) if (!paths.includes(seen)) changed = true
  if (!changed) return external

  const byHash = new Map<string, Entry>()
  for (const p of paths) {
    let raw = ''
    try {
      raw = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Partial<Entry>
        if (!e?.h || !Array.isArray(e.t)) continue
        const prev = byHash.get(e.h)
        const merged: Entry = {
          h: e.h,
          t: e.t,
          x: String(e.x ?? ''),
          o: e.o ?? null,
          a: e.a ?? null,
          n: Number(e.n ?? 1),
          f: String(e.f ?? e.l ?? ''),
          l: String(e.l ?? e.f ?? ''),
          out: e.out ?? null
        }
        byHash.set(e.h, prev ? { ...prev, ...merged } : merged)
      } catch {
        /* someone else's file; a line we cannot read is not our problem to report */
      }
    }
  }
  external = [...byHash.values()]
  return external
}

/**
 * Rarity weights over the whole archive, so two prompts sharing everyday vocabulary ("fix",
 * "deploy", "the bot") stop looking like repeats of each other.
 *
 * Below `IDF_MIN_CORPUS` this returns null and every token counts 1: rarity is meaningless
 * on a handful of prompts, where every shared token looks common and real repeats score near
 * zero. A fresh install sits there for its first day or two.
 */
function weightsFor(all: Entry[]): Map<string, number> | null {
  const corpus = all.filter((e) => e.t?.length).map((e) => e.t)
  if (corpus.length < IDF_MIN_CORPUS) return null
  try {
    return promptTokenIdf(corpus)
  } catch {
    return null
  }
}

/**
 * The best earlier ask this draft repeats, or null.
 *
 * `QUIET_MS` is the load-bearing filter, not the score. A prompt reworded and re-sent two
 * minutes later is the SAME piece of work — a retry, a follow-up, a second go at something
 * that just failed — and warning about that is both wrong and the single most annoying thing
 * this feature could do. Only a repeat from a different stretch of work counts.
 */
export function priorPrompt(
  text: string,
  opts: { extraArchives?: string[]; now?: number } = {}
): PriorPrompt | null {
  const tokens = promptTokens(text)
  // Conversational filler — "yes do it", "carry on", "now the other one". These match
  // everything and mean nothing, and scoring them would put a chip on every third keystroke.
  if (tokens.length < MIN_PROMPT_TOKENS) return null

  const now = opts.now ?? Date.now()
  const hash = promptHash(text)
  const mine = [...load().values()]
  const all = mine.concat(loadExternal(opts.extraArchives ?? []))
  if (!all.length) return null

  const weights = weightsFor(all)
  let best: Entry | null = null
  let bestScore = 0
  for (const e of all) {
    const when = Date.parse(e.l || e.f || '') || 0
    if (now - when <= QUIET_MS) continue
    // An exact hash match is the same ask by definition; scoring it would only re-derive 1.
    const score = e.h === hash ? 1 : promptMatchWeighted(tokens, e.t || [], weights)
    if (score < NEAR_MATCH) continue
    if (score > bestScore || (score === bestScore && String(e.l) > String(best?.l ?? ''))) {
      best = e
      bestScore = score
    }
  }
  if (!best) return null

  return {
    score: bestScore,
    text: String(best.x || '')
      .replace(/\s+/g, ' ')
      .slice(0, 180),
    project: best.o,
    agent: best.a,
    at: best.l || best.f || null,
    uses: best.n || 1,
    outcome: best.out
  }
}

/**
 * Record that this ask was made. Called when a pane's draft is actually SUBMITTED, never
 * while it is being typed — an archive of half-written sentences would match everything
 * badly and would also be a record of things the person decided not to say.
 */
export function recordPrompt(
  text: string,
  meta: { project?: string | null; agent?: string | null } = {}
): void {
  const tokens = promptTokens(text)
  if (tokens.length < MIN_PROMPT_TOKENS) return

  const hash = promptHash(text)
  const byHash = load()
  const prev = byHash.get(hash)
  const nowIso = new Date().toISOString()
  const entry: Entry = {
    h: hash,
    t: tokens,
    x: text.slice(0, TEXT_CAP),
    o: meta.project ?? prev?.o ?? null,
    a: meta.agent ?? prev?.a ?? null,
    n: (prev?.n ?? 0) + 1,
    f: prev?.f ?? nowIso,
    l: nowIso,
    out: prev?.out ?? null
  }
  byHash.set(hash, entry)
  append(entry)
  if (lines > MAX_ENTRIES * 1.5) compact(byHash)
}

/**
 * Say what an ask turned into.
 *
 * `out` has been null for every row this app has ever written, because until the goal
 * queue (I4, `main/goals.ts`) nothing in the app knew what an ask became - the outcomes
 * that did appear all came from an external archive that stamps its own. A finished goal
 * knows: it has the repo, the branches its lanes produced, and what the gate made of them.
 *
 * It does not create a row. An ask this archive has never seen is a miss, not a new entry:
 * `recordPrompt` is fed from the bytes on their way to a pty, and inventing an entry here
 * would mean a mission typed into a dialog quietly became something the recall chip could
 * warn about later.
 */
export function recordOutcome(text: string, outcome: string): boolean {
  const tokens = promptTokens(text)
  if (tokens.length < MIN_PROMPT_TOKENS) return false

  const hash = promptHash(text)
  const byHash = load()
  const prev = byHash.get(hash)
  if (!prev) return false

  const entry: Entry = { ...prev, out: outcome.slice(0, TEXT_CAP), l: new Date().toISOString() }
  byHash.set(hash, entry)
  append(entry)
  return true
}

/** Drop the in-memory copy. Only for the tests, which point `userData` somewhere else. */
export function resetPromptArchive(): void {
  cache = null
  lines = 0
  external = []
  externalSeen.clear()
}
