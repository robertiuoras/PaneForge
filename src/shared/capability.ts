// A capability record: one library, pattern, tool or technique the improver may NAME in
// a brief.
//
// Naming is the whole boundary. Nothing here installs a package, adds a dependency, runs
// an MCP server or grants a tool anything - the record is text that ends up in a prompt a
// person reads first.
//
// ## Why the lifecycle words are the vault's and not this file's
//
// The knowledge vault (`~/Documents/Obsidian Vault`, indexed by
// `claude-memory/claude-config/vault-index`) already has a status vocabulary that
// retrieval ranks on: `inbox draft reviewed verified superseded archived`, with
// `trusted_status = [reviewed, verified]` enforced at query time and `status_weight`
// deciding the order. A capability is a note like any other, so it uses those words.
//
// The obvious alternative - `discovered → evaluated → tested → verified → recommended` -
// reads better in a design document and is unusable: `vaultindex.py` would score every
// one of those as an unknown status, `doctor` would report them all as malformed, and a
// capability could never be promoted through `proposals.py` like everything else. Two
// lifecycles is two sources of truth about whether something has been checked.
//
// The mapping is kept where it belongs, on the record: "recommended" is
// `status: 'verified'` with at least one `outcomes` entry that succeeded, and "rejected"
// is `status: 'superseded'` with `whyNot` filled in. Both stay searchable, which is the
// point - a capability that has been ruled out must answer the query that would otherwise
// make somebody reconsider it.

/** The vault's lifecycle, unchanged. Only `reviewed` and `verified` are trusted. */
export type Lifecycle = 'inbox' | 'draft' | 'reviewed' | 'verified' | 'superseded' | 'archived'

/** The vault's disclosure classes, unchanged. `restricted` is never indexed at all. */
export type Sensitivity = 'public' | 'internal' | 'private' | 'restricted'

export const TRUSTED: readonly Lifecycle[] = ['reviewed', 'verified']

/** How much this record is worth acting on, independent of how recent it is. */
export type Confidence = 'low' | 'medium' | 'high'

export type Cost = 'free' | 'freemium' | 'paid' | 'unknown'

/** What actually happened when this was used, which is the only ranking input that counts. */
export interface Outcome {
  /** Project slug. Never a client name and never a path. */
  project: string
  /** ISO date. */
  at: string
  result: 'shipped' | 'reverted' | 'rejected'
  /** One clause. Why it went that way. */
  note: string
}

export interface Capability {
  id: string
  name: string
  /** One of `CATEGORIES`. Free text here would make the per-category cap unenforceable. */
  category: string
  /** <=200 chars. Rendered as a quoted attribute, never as instruction - see T5. */
  description: string
  /** Where the claim came from: the official docs, the repository, or a controlled test. */
  source: string
  licence: string
  cost: Cost
  /** Frameworks/runtimes it works with, lowercase ids: react, vue, svelte, next, node. */
  compatibility: string[]
  useCases: string[]
  limitations: string[]
  /** One clause about bundle size, runtime cost or build time. */
  performance: string
  /** One clause. `none` is a real answer and is worth saying out loud. */
  accessibility: string
  /** One clause. Auth, data handling, third-party network calls, supply-chain surface. */
  security: string
  status: Lifecycle
  confidence: Confidence
  /** ISO date a human last checked this against reality. Drives staleness. */
  lastVerified: string
  /** Project slugs it has actually been used in. */
  testedProjects: string[]
  outcomes: Outcome[]
  /** Packages that make this redundant. Checked against the project's own package.json. */
  overlaps: string[]
  sensitivity: Sensitivity
  /** Only on `superseded`: why it was ruled out, so nobody reconsiders it for free. */
  whyNot?: string
  supersededBy?: string
}

/**
 * The closed category list.
 *
 * Closed on purpose: the per-category cap is what stops the catalogue becoming a bookmark
 * folder, and a cap cannot be applied to a category anyone can invent.
 */
export const CATEGORIES = [
  'ui-components',
  'animation',
  'svg-2d',
  '3d',
  'forms',
  'data-visualisation',
  'testing',
  'accessibility',
  'styling',
  'state',
  'routing',
  'auth',
  'performance',
  'build',
  'mcp-server'
] as const

export type Category = (typeof CATEGORIES)[number]

/** Entries kept per category. An eleventh must displace one. */
export const PER_CATEGORY_CAP = 10

/** Days after which a record is stale and must say so wherever it is used. */
export const STALE_DAYS = 180

export function isStale(c: Capability, now: number = Date.now()): boolean {
  const t = Date.parse(c.lastVerified)
  if (Number.isNaN(t)) return true
  return now - t > STALE_DAYS * 86_400_000
}

/**
 * Is this record allowed to be shown as something to use?
 *
 * `reviewed`/`verified` only. A fixture ships as `draft` and therefore can never reach a
 * brief through this - which is the whole reason the fixtures are safe to ship: they
 * exercise retrieval without ever being presented as a recommendation.
 */
export function isRecommendable(c: Capability): boolean {
  return TRUSTED.includes(c.status)
}

/** "recommended" in the brief's words: verified AND something shipped with it. */
export function isProven(c: Capability): boolean {
  return c.status === 'verified' && c.outcomes.some((o) => o.result === 'shipped')
}

const CONFIDENCE_WEIGHT: Record<Confidence, number> = { low: 0.6, medium: 1, high: 1.3 }
const STATUS_WEIGHT: Record<Lifecycle, number> = {
  verified: 1.4,
  reviewed: 1.15,
  draft: 0.7,
  inbox: 0.5,
  superseded: 0.2,
  archived: 0.2
}

export interface RankInput {
  /** Lowercase framework/runtime ids the project actually uses. */
  stack: string[]
  /** Lowercase dependency names from the project's package.json. */
  dependencies: string[]
  /** Query terms, already lowercased. */
  terms: string[]
  now?: number
}

/**
 * Score one record against a project and a query.
 *
 * Popularity is deliberately absent. There is no star count, no download count and no
 * field to put one in: the whole failure mode this is designed against is recommending
 * something because it is popular rather than because it fits. What raises a score is a
 * verified outcome, a status a human moved, and compatibility with the stack in front of
 * us. What lowers it is age and cost.
 */
export function score(c: Capability, input: RankInput): number {
  const now = input.now ?? Date.now()

  // Something the project already depends on is not a capability to add. Zero, not a
  // penalty: attaching a library the repo already has is the failure mode to design out.
  const owned = new Set(input.dependencies.map((d) => d.toLowerCase()))
  if (c.overlaps.some((o) => owned.has(o.toLowerCase()))) return 0
  if (owned.has(c.name.toLowerCase())) return 0

  // Incompatible with the stack is also zero rather than a low score. An empty
  // compatibility list means "framework-agnostic" and always fits.
  if (c.compatibility.length && input.stack.length) {
    const stack = new Set(input.stack.map((s) => s.toLowerCase()))
    if (!c.compatibility.some((f) => stack.has(f.toLowerCase()))) return 0
  }

  const haystack = [c.name, c.category, c.description, ...c.useCases]
    .join(' ')
    .toLowerCase()
  let fit = 0
  for (const t of input.terms) if (t.length > 2 && haystack.includes(t)) fit += 1
  if (!fit) return 0

  const age = Math.max(0, (now - Date.parse(c.lastVerified)) / 86_400_000)
  const freshness = Number.isNaN(age) ? 0.5 : Math.max(0.4, 1 - age / (STALE_DAYS * 2))
  const proven = isProven(c) ? 1.5 : c.outcomes.length ? 1.15 : 1
  const costPenalty = c.cost === 'paid' ? 0.8 : 1

  return fit * STATUS_WEIGHT[c.status] * CONFIDENCE_WEIGHT[c.confidence] * freshness * proven * costPenalty
}

/**
 * Pick at most `limit` capabilities.
 *
 * Zero is a normal answer and the common one. Most prompts do not need a library named at
 * them, and a brief that always carries three is a brief nobody reads.
 */
export function select(
  all: Capability[],
  input: RankInput,
  limit = 3
): Array<{ capability: Capability; score: number }> {
  const scored = all
    .filter(isRecommendable)
    .map((capability) => ({ capability, score: score(capability, input) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  // One per category: three animation libraries is a menu, not a recommendation.
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

const REQUIRED: Array<keyof Capability> = [
  'id',
  'name',
  'category',
  'description',
  'source',
  'licence',
  'cost',
  'status',
  'confidence',
  'lastVerified'
]

/**
 * Validate a record read off disk.
 *
 * Fielded data, not free text: `description` is truncated here rather than trusted,
 * because a capability description is untrusted input that ends up near a prompt. A
 * record that fails is dropped with its reason, never repaired into something plausible.
 */
export function parseCapability(raw: unknown): { ok: true; value: Capability } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' }
  const r = raw as Record<string, unknown>
  for (const key of REQUIRED) {
    if (typeof r[key] !== 'string' || !(r[key] as string).trim()) {
      return { ok: false, why: `missing ${key}` }
    }
  }
  if (!(CATEGORIES as readonly string[]).includes(r.category as string)) {
    return { ok: false, why: `unknown category ${String(r.category)}` }
  }
  const status = r.status as Lifecycle
  if (!['inbox', 'draft', 'reviewed', 'verified', 'superseded', 'archived'].includes(status)) {
    return { ok: false, why: `unknown status ${String(status)}` }
  }
  if (!['low', 'medium', 'high'].includes(r.confidence as string)) {
    return { ok: false, why: `unknown confidence ${String(r.confidence)}` }
  }
  if (Number.isNaN(Date.parse(r.lastVerified as string))) {
    return { ok: false, why: 'lastVerified is not a date' }
  }
  const sensitivity = (r.sensitivity as Sensitivity) ?? 'internal'
  if (sensitivity === 'restricted') {
    // The vault refuses these at build time and so does this: a restricted record must be
    // unreachable, not merely filtered later.
    return { ok: false, why: 'restricted records are never loaded' }
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 80)) : []

  return {
    ok: true,
    value: {
      id: (r.id as string).slice(0, 80),
      name: (r.name as string).slice(0, 80),
      category: r.category as string,
      description: (r.description as string).slice(0, 200),
      source: (r.source as string).slice(0, 200),
      licence: (r.licence as string).slice(0, 40),
      cost: (['free', 'freemium', 'paid', 'unknown'].includes(r.cost as string)
        ? r.cost
        : 'unknown') as Cost,
      compatibility: strings(r.compatibility),
      useCases: strings(r.useCases),
      limitations: strings(r.limitations),
      performance: typeof r.performance === 'string' ? r.performance.slice(0, 160) : '',
      accessibility: typeof r.accessibility === 'string' ? r.accessibility.slice(0, 160) : '',
      security: typeof r.security === 'string' ? r.security.slice(0, 160) : '',
      status,
      confidence: r.confidence as Confidence,
      lastVerified: r.lastVerified as string,
      testedProjects: strings(r.testedProjects),
      outcomes: Array.isArray(r.outcomes)
        ? (r.outcomes as Outcome[]).filter(
            (o) => o && typeof o.project === 'string' && typeof o.result === 'string'
          )
        : [],
      overlaps: strings(r.overlaps),
      sensitivity,
      whyNot: typeof r.whyNot === 'string' ? r.whyNot.slice(0, 200) : undefined,
      supersededBy: typeof r.supersededBy === 'string' ? r.supersededBy.slice(0, 80) : undefined
    }
  }
}
