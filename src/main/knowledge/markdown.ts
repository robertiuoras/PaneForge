// The Markdown knowledge provider: an Obsidian vault read directly.
//
// This is the fallback, not the preferred path. Where `vaultindex.py` is available it
// wins, because it enforces the sensitivity guarantee at INDEX BUILD time - a restricted
// note's text is never written to the database at all - and a filter applied at query
// time, which is all this file can do, is one forgotten flag from a leak. This provider
// exists so the feature still works on a machine with no Python and no index, and it is
// written to fail closed at every step where the indexed version fails closed earlier.
//
// No YAML dependency: the frontmatter contract is `key: value` and short lists, and
// pulling in a parser to read ten known keys would be a runtime dependency in an app
// whose only two are node-pty and electron-updater.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Lifecycle, Sensitivity } from '../../shared/capability'
import type { KnowledgeNote, KnowledgeProvider, KnowledgeQuery } from '../../shared/knowledge'
import { applyPolicy } from '../../shared/knowledge'

/**
 * Folders that are never read.
 *
 * `60 Datasets` and `80 Archive` are excluded for the reasons the vault's own
 * `sources.json` gives and they are worth repeating: training and evaluation material
 * must never come back as if it were knowledge, which is how an agent starts quoting its
 * own test answers; and superseded material that still answers a query is worse than no
 * answer.
 */
const EXCLUDED = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.vault-index',
  'node_modules',
  '60 Datasets',
  '80 Archive',
  '99 Attachments'
])

const MAX_FILES = 4000
const MAX_DEPTH = 6
const EXCERPT_CHARS = 700

/** Days after which a note has to say it is past its review window. */
const STALE_DAYS = 365

export function expandHome(p: string): string {
  if (!p) return ''
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Where an Obsidian vault conventionally lives, per platform.
 *
 * Offered in Settings as a starting point, never assumed: the configured path always
 * wins, and an unconfigured provider is simply unavailable rather than guessing.
 */
export function defaultVaultCandidates(): string[] {
  const home = homedir()
  return [
    join(home, 'Documents', 'Obsidian Vault'),
    join(home, 'Obsidian'),
    join(home, 'Documents', 'Obsidian')
  ]
}

/** The first candidate that is really a folder on this machine, or ''. Never assumed. */
export function firstExistingVault(): string {
  for (const p of defaultVaultCandidates()) {
    try {
      if (statSync(p).isDirectory()) return p
    } catch {
      /* not this one */
    }
  }
  return ''
}

interface Front {
  type?: string
  status?: Lifecycle
  sensitivity?: Sensitivity
  updated?: string
  project?: string
  area?: string
  title?: string
}

/** Parse the four required keys and the few optional ones. Anything else is ignored. */
export function frontmatter(text: string): { front: Front; body: string } {
  if (!text.startsWith('---')) return { front: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { front: {}, body: text }
  const head = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const front: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // A list value (`[a, b]` or a `- ` block) is not something this reads; the fields it
    // needs are all scalars, and half-parsing a list is worse than ignoring it.
    if (value.startsWith('[')) continue
    front[m[1]] = value
  }
  return { front: front as Front, body }
}

function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (out.length >= MAX_FILES) return
    if (EXCLUDED.has(name)) continue
    const full = join(dir, name)
    // The exclusion list is applied to the path relative to the vault root too, so
    // "80 Archive" is excluded wherever it sits rather than only at the top.
    const rel = relative(root, full)
    if (rel.split(sep).some((part) => EXCLUDED.has(part))) continue
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(root, full, depth + 1, out)
    else if (name.toLowerCase().endsWith('.md')) out.push(full)
  }
}

function termsOf(q: KnowledgeQuery): string[] {
  const raw = `${q.task} ${q.keywords?.join(' ') ?? ''} ${q.category ?? ''}`.toLowerCase()
  return [...new Set(raw.split(/[^a-z0-9+#.-]+/).filter((t) => t.length > 2))]
}

const STATUS_WEIGHT: Record<Lifecycle, number> = {
  verified: 1.4,
  reviewed: 1.15,
  draft: 0.7,
  inbox: 0.5,
  superseded: 0.2,
  archived: 0.2
}

export interface MarkdownProviderOptions {
  /** Vault root. Empty means the provider is unavailable. */
  vaultPath: string
  name?: string
}

export function markdownProvider(options: MarkdownProviderOptions): KnowledgeProvider {
  const root = expandHome(options.vaultPath)
  const name = options.name ?? 'markdown'

  return {
    name,
    available(): boolean {
      if (!root || !isAbsolute(root)) return false
      try {
        return statSync(root).isDirectory()
      } catch {
        return false
      }
    },
    async search(q: KnowledgeQuery): Promise<KnowledgeNote[]> {
      if (!this.available()) return []
      const files: string[] = []
      walk(root, root, 0, files)
      const terms = termsOf(q)
      if (!terms.length) return []

      const now = Date.now()
      const notes: KnowledgeNote[] = []
      for (const file of files) {
        let raw: string
        try {
          raw = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const { front, body } = frontmatter(raw)

        // Fail closed. A note with no sensitivity is `internal`, which the vault's own
        // config also does; a note that says `restricted` is dropped here and never
        // scored, so it cannot reach the ranking loop at all.
        const sensitivity = (front.sensitivity ?? 'internal') as Sensitivity
        if (sensitivity === 'restricted') continue
        const status = (front.status ?? 'draft') as Lifecycle

        const haystack = `${front.title ?? ''} ${relative(root, file)} ${body}`.toLowerCase()
        let hits = 0
        for (const t of terms) if (haystack.includes(t)) hits += 1
        if (!hits) continue

        // A private note is only reachable from its own project, which is `T4`: there is
        // no query that returns project A's private note while working in project B.
        if (sensitivity === 'private' && (!q.project || front.project !== q.project)) continue

        const updated = front.updated ?? ''
        const age = updated ? (now - Date.parse(updated)) / 86_400_000 : Number.NaN
        const stale = Number.isNaN(age) ? true : age > STALE_DAYS
        const projectBoost = q.project && front.project === q.project ? 1.6 : 1
        const freshness = Number.isNaN(age) ? 0.7 : Math.max(0.4, 1 - age / (STALE_DAYS * 2))

        notes.push({
          id: relative(root, file).replace(/\\/g, '/'),
          title: front.title ?? file.split(sep).pop()?.replace(/\.md$/i, '') ?? 'note',
          provider: name,
          source: relative(root, file).replace(/\\/g, '/'),
          status,
          sensitivity,
          updated,
          stale,
          text: body.trim().slice(0, EXCERPT_CHARS),
          score: hits * (STATUS_WEIGHT[status] ?? 0.5) * projectBoost * freshness,
          trusted: status === 'reviewed' || status === 'verified'
        })
      }

      return applyPolicy(notes, q).sort((a, b) => b.score - a.score)
    }
  }
}
