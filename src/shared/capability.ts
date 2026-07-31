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

/**
 * Evidence from one controlled run in the sandbox. The only thing that moves a record to
 * `Tested`, and with `pass: true` the only thing that lets a human move it to `Verified`.
 *
 * Recorded, never authored by the thing being tested: every field here comes from an exit
 * code, a byte count or a timer in `scripts/capability-sandbox.mjs`.
 */
export interface CapabilityTest {
  /** ISO date the sandbox ran. */
  at: string
  /** The fixture it ran in. Never a real project - see the sandbox script's header. */
  fixture: string
  /** Did install + build + the fixture's own check all exit zero. */
  pass: boolean
  /** Bytes added to the fixture's production bundle, measured. -1 when not measured. */
  bundleBytes: number
  /** Milliseconds for install + build. Developer experience, measured not guessed. */
  ms: number
  /** One clause. What went wrong, or what was notable. */
  note: string
}

/**
 * How fast the truth about this kind of thing goes out of date.
 *
 * This is the whole of freshness management: a review interval attached to the record
 * rather than a global sweep, because "check everything weekly" is how a research agent
 * spends its budget re-reading a W3C recommendation that has not moved since 2018.
 */
export type Volatility = 'fast' | 'medium' | 'slow' | 'inert'

/** Days between reviews, per volatility class. */
export const REVIEW_DAYS: Record<Volatility, number> = {
  fast: 30,
  medium: 90,
  slow: 365,
  // Rejected and deprecated records are not reviewed on a clock at all. They are
  // revisited when evidence arrives - a new major version, a maintainer returning - which
  // is an event, not a date. A number here would be a research run whose conclusion is
  // known before it starts.
  inert: 3650
}

/**
 * The lifecycle the brief asks for, DERIVED rather than stored.
 *
 * `Discovered → Evaluated → Tested → Verified → Recommended` is the vocabulary a person
 * reads; `inbox draft reviewed verified superseded archived` is the vocabulary the vault
 * index ranks on and `proposals.py` promotes through. Storing both would be two sources of
 * truth about whether something has been checked - the exact failure the header of this
 * file exists to prevent - so one is computed from the other plus the evidence on the
 * record. There is no field anyone can set to "Verified" without a `tests` entry.
 */
export type Stage =
  | 'discovered'
  | 'evaluated'
  | 'tested'
  | 'verified'
  | 'recommended'
  | 'rejected'
  | 'deprecated'
  | 'superseded'
  | 'needs-review'

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

  // ---- Phase 2. All optional, all defaulted by `parseCapability` ----------
  //
  // Optional on purpose: a Phase 1 record on disk is still a valid record, and a research
  // run that could only write a complete one would write nothing. What is missing reads as
  // "not checked", which is the honest answer and is what lowers confidence.

  /** Free-text tags for retrieval. The closed `category` is what caps are applied to. */
  tags?: string[]
  /** Where it was FOUND - a Reddit thread, a showcase, an awards site. Never the evidence. */
  discoveredVia?: string
  /** Repository URL. The thing a licence and a commit date are actually read from. */
  repo?: string
  /** OS/runtime requirements: `node>=18`, `windows`, `wasm`. Empty means none noticed. */
  platforms?: string[]
  /** Visual register it produces: `minimal`, `brutalist`, `playful`. Design retrieval. */
  visualStyles?: string[]
  /** Project kinds it suits: `landing`, `dashboard`, `docs`, `admin`. */
  projectTypes?: string[]
  /** One clause with a DATE in it: "last commit 2026-06, 4 maintainers". */
  maintenance?: string
  /** ISO date of the newest release seen. Drives "a new major appeared" refreshes. */
  lastRelease?: string
  /**
   * Stars, downloads, "everyone uses it".
   *
   * Recorded because a research note that omits it looks incomplete, and deliberately
   * absent from `score()` - see that function's comment. It is context for a human, never
   * an input to ranking.
   */
  popularity?: string
  /** One clause. Touch targets, viewport behaviour, whether it is usable on a phone. */
  mobile?: string
  /** One clause. What leaves the machine, and to whom. Separate from `security`. */
  privacy?: string
  /** What installing it actually costs: peer deps, a build step, a native module. */
  install?: string
  /** How hard it is to use well, honestly. */
  complexity?: 'trivial' | 'moderate' | 'involved' | 'unknown'
  /** Other capability ids that do the same job. Not `overlaps`, which is about the repo. */
  alternatives?: string[]
  /** How fast this goes stale. Decides `nextReview`. */
  volatility?: Volatility
  /** ISO date the next review is due. Derived from `lastVerified` + `REVIEW_DAYS`. */
  nextReview?: string
  /** Sandbox evidence. Non-empty is what `Tested` means. */
  tests?: CapabilityTest[]
  /** Set when a `superseded` record was ruled out rather than replaced. */
  ruling?: 'rejected' | 'deprecated' | 'superseded'
  /** A human asked for another look, regardless of the clock. */
  needsReview?: boolean
  /**
   * The research run that produced this record, and the date each claim was checked.
   *
   * Provenance is not decoration: a record with no `checkedAt` cannot be told apart from
   * one checked today, and that is how a two-year-old benchmark gets quoted as current.
   */
  provenance?: { run?: string; checkedAt?: string; sources?: string[] }
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

/** Has this record got at least one passing sandbox run behind it? */
export function isTested(c: Capability): boolean {
  return Boolean(c.tests?.some((t) => t.pass))
}

/** When the next review falls due. Explicit field wins; otherwise volatility decides. */
export function nextReviewDate(c: Capability): string {
  if (c.nextReview && !Number.isNaN(Date.parse(c.nextReview))) return c.nextReview
  const base = Date.parse(c.lastVerified)
  if (Number.isNaN(base)) return ''
  const days = REVIEW_DAYS[c.volatility ?? 'medium']
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Is this record due another look?
 *
 * Two ways in: a human set `needsReview`, or its own interval elapsed. Deliberately NOT
 * the same question as `isStale` - staleness is a fixed 180 days used to put a STALE flag
 * on anything old that reaches a prompt, whereas this is what the research agent queues.
 * A W3C note that is 200 days old is stale-flagged and still not worth a research run.
 */
export function needsReview(c: Capability, now: number = Date.now()): boolean {
  if (c.needsReview) return true
  if ((c.volatility ?? 'medium') === 'inert') return false
  const due = nextReviewDate(c)
  if (!due) return true
  return Date.parse(due) <= now
}

/**
 * The stage a person is shown, computed from the stored status and the evidence.
 *
 * Order matters: the terminal rulings are decided first, then `needs-review`, then the
 * ladder from the top down. `verified` with no passing test is still `verified` - a human
 * moving the status is evidence too - but nothing reaches `tested` without a sandbox run
 * and nothing reaches `recommended` without something having shipped.
 */
export function stage(c: Capability, now: number = Date.now()): Stage {
  if (c.status === 'superseded' || c.status === 'archived') {
    if (c.ruling === 'deprecated') return 'deprecated'
    if (c.ruling === 'rejected') return 'rejected'
    return c.supersededBy ? 'superseded' : 'rejected'
  }
  if (needsReview(c, now)) return 'needs-review'
  if (isProven(c)) return 'recommended'
  if (c.status === 'verified') return 'verified'
  if (isTested(c)) return 'tested'
  if (c.status === 'reviewed' || c.status === 'draft') return 'evaluated'
  return 'discovered'
}

/** Stages that may be presented as something to act on. The rest must be labelled. */
export const ACTIONABLE_STAGES: readonly Stage[] = ['verified', 'recommended']

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
      supersededBy: typeof r.supersededBy === 'string' ? r.supersededBy.slice(0, 80) : undefined,

      tags: strings(r.tags).slice(0, 12),
      discoveredVia: clause(r.discoveredVia, 200),
      repo: clause(r.repo, 200),
      platforms: strings(r.platforms).slice(0, 8),
      visualStyles: strings(r.visualStyles).slice(0, 8),
      projectTypes: strings(r.projectTypes).slice(0, 8),
      maintenance: clause(r.maintenance, 160),
      lastRelease: Number.isNaN(Date.parse(String(r.lastRelease))) ? undefined : String(r.lastRelease),
      popularity: clause(r.popularity, 120),
      mobile: clause(r.mobile, 160),
      privacy: clause(r.privacy, 160),
      install: clause(r.install, 160),
      complexity: (['trivial', 'moderate', 'involved'] as const).includes(r.complexity as never)
        ? (r.complexity as Capability['complexity'])
        : 'unknown',
      alternatives: strings(r.alternatives).slice(0, 6),
      volatility: (['fast', 'medium', 'slow', 'inert'] as const).includes(r.volatility as never)
        ? (r.volatility as Volatility)
        : 'medium',
      nextReview: Number.isNaN(Date.parse(String(r.nextReview))) ? undefined : String(r.nextReview),
      // Tests are evidence, so a malformed one is dropped rather than defaulted: an entry
      // with no `pass` field must not read as a passing run.
      tests: Array.isArray(r.tests)
        ? (r.tests as CapabilityTest[])
            .filter((t) => t && typeof t.at === 'string' && typeof t.pass === 'boolean')
            .map((t) => ({
              at: t.at,
              fixture: String(t.fixture ?? '').slice(0, 80),
              pass: t.pass,
              bundleBytes: typeof t.bundleBytes === 'number' ? t.bundleBytes : -1,
              ms: typeof t.ms === 'number' ? t.ms : -1,
              note: String(t.note ?? '').slice(0, 160)
            }))
            .slice(0, 10)
        : [],
      ruling: (['rejected', 'deprecated', 'superseded'] as const).includes(r.ruling as never)
        ? (r.ruling as Capability['ruling'])
        : undefined,
      needsReview: r.needsReview === true,
      provenance:
        r.provenance && typeof r.provenance === 'object'
          ? {
              run: clause((r.provenance as Record<string, unknown>).run, 80),
              checkedAt: clause((r.provenance as Record<string, unknown>).checkedAt, 40),
              // Not `strings()`: that caps each entry at 80 characters, which silently
              // truncates a documentation URL into one that 404s when a human clicks it.
              sources: (Array.isArray((r.provenance as Record<string, unknown>).sources)
                ? ((r.provenance as Record<string, unknown>).sources as unknown[])
                : []
              )
                .filter((x): x is string => typeof x === 'string')
                .map((s) => s.slice(0, 300))
                .slice(0, 8)
            }
          : undefined
    }
  }
}

/** A single free-text clause off untrusted input: trimmed, capped, never empty-string. */
function clause(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, max)
  return s || undefined
}
