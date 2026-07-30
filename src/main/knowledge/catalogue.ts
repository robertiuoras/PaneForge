// Capability records, as a knowledge provider.
//
// Two sources, merged: the bundled seed (so the feature works on first launch with
// nothing installed) and `userData/capabilities/*.jsonl`, one JSON object per line. Plain
// files rather than a database, for the reason `history.ts` gives: greppable, deletable,
// nothing to corrupt, and a bad line costs one record rather than the store.
//
// A user record with the same `id` as a seed record replaces it, which is how a seed
// entry gets promoted once somebody has actually verified it.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Capability, RankInput } from '../../shared/capability'
import { isStale, parseCapability, PER_CATEGORY_CAP, score, select } from '../../shared/capability'
import { SEED } from '../../shared/capabilitySeed'
import type { KnowledgeNote, KnowledgeProvider, KnowledgeQuery } from '../../shared/knowledge'
import { applyPolicy } from '../../shared/knowledge'

let cache: Capability[] | null = null

function userDir(): string {
  try {
    return join(app.getPath('userData'), 'capabilities')
  } catch {
    return ''
  }
}

/** Everything loadable, seed first, user records overriding by id. */
export function loadCapabilities(): Capability[] {
  if (cache) return cache
  const byId = new Map<string, Capability>()
  for (const raw of SEED) {
    const r = parseCapability(raw)
    if (r.ok) byId.set(r.value.id, r.value)
  }

  const dir = userDir()
  if (dir && existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      let text: string
      try {
        text = readFileSync(join(dir, file), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        const r = parseCapability(raw)
        // A record that fails validation is dropped, never repaired: a half-understood
        // capability record is how a licence or a security note goes missing.
        if (r.ok) byId.set(r.value.id, r.value)
      }
    }
  }

  // The per-category cap, applied by keeping the most recently verified. A catalogue that
  // grows without eviction is a bookmark folder.
  const byCategory = new Map<string, Capability[]>()
  for (const c of byId.values()) {
    const list = byCategory.get(c.category) ?? []
    list.push(c)
    byCategory.set(c.category, list)
  }
  const out: Capability[] = []
  for (const list of byCategory.values()) {
    list.sort((a, b) => Date.parse(b.lastVerified) - Date.parse(a.lastVerified))
    out.push(...list.slice(0, PER_CATEGORY_CAP))
  }
  cache = out
  return out
}

export function invalidateCapabilities(): void {
  cache = null
}

/** Create the folder so a user has somewhere obvious to drop their own records. */
export function ensureCapabilityDir(): string {
  const dir = userDir()
  if (!dir) return ''
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* read-only profile - the catalogue still works from the seed */
  }
  return dir
}

/**
 * Render one record as the compact text that may reach a prompt.
 *
 * Fielded, never free-form. `description` has already been truncated to 200 characters by
 * `parseCapability` and is quoted here, so a description that contains instructions
 * arrives as a quoted attribute of a named thing rather than as a line of the brief -
 * which is the whole of the catalogue-poisoning mitigation.
 */
export function renderCapability(c: Capability, now = Date.now()): string {
  const flags: string[] = []
  if (!c.status || c.status === 'draft' || c.status === 'inbox') flags.push('UNVERIFIED')
  if (c.status === 'superseded') flags.push('RULED OUT')
  if (isStale(c, now)) flags.push('STALE')
  const head = `${c.name} (${c.category}${flags.length ? ' · ' + flags.join(' · ') : ''})`
  const lines = [
    `- ${head}: "${c.description}"`,
    `  licence ${c.licence} · cost ${c.cost} · perf: ${c.performance || 'unknown'}`,
    `  a11y: ${c.accessibility || 'unknown'}`
  ]
  if (c.limitations.length) lines.push(`  limits: ${c.limitations.join('; ')}`)
  if (c.whyNot) lines.push(`  ruled out: ${c.whyNot}${c.supersededBy ? ` (use ${c.supersededBy})` : ''}`)
  lines.push(`  source: ${c.source}`)
  return lines.join('\n')
}

export interface CatalogueContext {
  stack: string[]
  dependencies: string[]
}

/**
 * The catalogue as a `KnowledgeProvider`.
 *
 * It scores through `capability.select`, which is where the real policy lives: a record
 * the project already depends on scores zero, an incompatible one scores zero, and at
 * most one per category survives.
 */
export function catalogueProvider(context: CatalogueContext): KnowledgeProvider {
  return {
    name: 'catalogue',
    available: () => true,
    async search(q: KnowledgeQuery): Promise<KnowledgeNote[]> {
      const all = loadCapabilities()
      const terms = `${q.task} ${q.keywords?.join(' ') ?? ''}`
        .toLowerCase()
        .split(/[^a-z0-9+#.-]+/)
        .filter((t) => t.length > 2)

      const input: RankInput = {
        stack: context.stack,
        dependencies: context.dependencies,
        terms
      }

      const pool = q.category ? all.filter((c) => c.category === q.category) : all
      // `select` filters to recommendable records. When untrusted material is explicitly
      // asked for, score the whole pool instead and let `applyPolicy` decide - the notes
      // still carry `trusted: false` and render with UNVERIFIED on them.
      const chosen = q.includeUntrusted
        ? scoreAll(pool, input, q.limit ?? 3)
        : select(pool, input, q.limit ?? 3)

      const notes: KnowledgeNote[] = chosen.map(({ capability: c, score }) => ({
        id: c.id,
        title: c.name,
        provider: 'catalogue',
        source: c.source,
        status: c.status,
        sensitivity: c.sensitivity,
        updated: c.lastVerified,
        stale: isStale(c),
        text: renderCapability(c),
        score,
        trusted: c.status === 'reviewed' || c.status === 'verified'
      }))

      return applyPolicy(notes, q)
    }
  }
}

function scoreAll(
  pool: Capability[],
  input: RankInput,
  limit: number
): Array<{ capability: Capability; score: number }> {
  // Same shape as `select`, minus the trust filter, and still one per category.
  const scored = pool
    .map((capability) => ({
      capability,
      score: scoreUntrusted(capability, input)
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const out: Array<{ capability: Capability; score: number }> = []
  for (const s of scored) {
    if (seen.has(s.capability.category)) continue
    seen.add(s.capability.category)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

function scoreUntrusted(c: Capability, input: RankInput): number {
  // Reuse the real scorer by asking it about a copy that is temporarily `reviewed`, so
  // the ranking is identical and only the gate differs. The record itself is untouched
  // and still reports its own status everywhere it is shown.
  //
  // `superseded` is excluded even here: it is in the catalogue to answer "why not X",
  // which the sheet asks explicitly, not to be offered as a thing to use.
  if (c.status === 'superseded' || c.status === 'archived') return 0
  return score({ ...c, status: 'reviewed' }, input)
}
