// What a research run is allowed to cost, what it is allowed to believe, and what it is
// allowed to return.
//
// Two callers share this file and that is the point. The scheduled agent in taskdriver
// produces findings on a timer; the pane's "Research this request" button produces them on
// demand. One validator for both means a hostile README cannot get in through whichever
// path had the weaker check - there is only one check.
//
// ## The boundary this file draws
//
// Everything a research run reads is untrusted: documentation, repositories, issues,
// comments, README files, Reddit posts, MCP server descriptions. None of it is an
// instruction. `parseFinding` is the gate, and it REJECTS rather than repairs - a finding
// that carries an imperative aimed at an agent is dropped with its reason recorded, not
// sanitised into something plausible. Repairing it would mean deciding which half of a
// poisoned note was the honest half, which is not a decision code can make.
//
// The second half of the boundary is not in this file at all and cannot be: research runs
// with no repository, no credentials and no install rights. See `RESEARCH-POLICY.md`.

import type { Capability, Volatility } from './capability'
import { needsReview } from './capability'

/**
 * How a run ended. Five terminal states plus the two that are not failures.
 *
 * `completed` and `no-finding` are both successes: a run that read four primary sources
 * and concluded that nothing met the bar did its job, and recording that as a failure is
 * how a pipeline learns to lower its bar to look busy.
 */
export type ResearchOutcome =
  | 'completed'
  | 'no-finding'
  | 'skipped'
  | 'deferred'
  | 'failed'
  | 'needs-human'

/** Outcomes that mean the run finished and nothing is owed. */
export const TERMINAL: readonly ResearchOutcome[] = [
  'completed',
  'no-finding',
  'skipped',
  'failed',
  'needs-human'
]

/** Outcomes a person has to see. The rest are noise on a dashboard. */
export const NOTIFY: readonly ResearchOutcome[] = ['failed', 'needs-human']

/**
 * Did the run open nothing and return nothing?
 *
 * `no-finding` is a CONCLUSION: sources were read and none of them cleared the bar. A run
 * that opened zero sources and returned zero findings concluded nothing - it returned
 * early, because a tool was refused, an answer was truncated, or the model answered from
 * memory in twenty seconds. Both shapes serialise to the same near-empty JSON, so without
 * this check the broken one is filed as a success and the question is never asked again.
 *
 * The measured case is run `2026-08-15-current-frontend-framework-capabilities`, which
 * came back in 26s with `tokens: 0`, `sources: []`, `findings: []` and was recorded `done`.
 * A failure must be loud and must not share a shape with a good outcome.
 */
export function openedNothing(
  sources: readonly { opened?: boolean }[] | undefined,
  findingCount: number
): boolean {
  const opened = (sources ?? []).filter((s) => s?.opened === true).length
  return opened === 0 && findingCount === 0
}

export interface ResearchBudget {
  /** Wall clock. A run that has not concluded by here is `deferred`, not killed silently. */
  ms: number
  /** Primary sources it may open. Discovery pages do not count against this. */
  sources: number
  /** Findings it may return. Three, always - see `MAX_FINDINGS`. */
  findings: number
  /** Model tokens. Enforced by the runner, recorded either way. */
  tokens: number
  /** Attempts after the first. One. A second retry has never found what two did not. */
  retries: number
}

/**
 * Three, and it is a ceiling rather than a target.
 *
 * A run that returns three mediocre findings costs the same as one that returns three good
 * ones and costs far more later, because each one has to be reviewed, tested and reviewed
 * again. `no-finding` is the expected outcome of most runs.
 */
export const MAX_FINDINGS = 3

/** The scheduled agent's budget: bounded so a hung run cannot spend a night. */
export const SCHEDULED_BUDGET: ResearchBudget = {
  ms: 15 * 60_000,
  sources: 12,
  findings: MAX_FINDINGS,
  tokens: 120_000,
  retries: 1
}

/**
 * The pane's budget: a person is watching, so it is a fraction of the scheduled one.
 *
 * Two minutes is the number a person will wait beside a prompt they have already written.
 * Past that they send the draft unimproved, which makes a longer budget worse than none.
 */
export const INTERACTIVE_BUDGET: ResearchBudget = {
  ms: 120_000,
  sources: 5,
  findings: 2,
  tokens: 40_000,
  retries: 0
}

/**
 * Where a claim came from, and whether that is enough to believe it.
 *
 * The split is the whole source policy in one type. A Reddit thread is how you FIND
 * something and can never be why you believe it; the repository's own licence file can.
 * `parseFinding` enforces it: a finding whose only source is lead-class is rejected.
 */
export type SourceClass =
  | 'official-docs'
  | 'repository'
  | 'licence'
  | 'changelog'
  | 'security-advisory'
  | 'standard'
  | 'controlled-test'
  | 'article'
  | 'community'
  | 'showcase'
  | 'competitor'

/** Classes that may be cited as evidence for a claim. */
export const EVIDENCE_CLASSES: readonly SourceClass[] = [
  'official-docs',
  'repository',
  'licence',
  'changelog',
  'security-advisory',
  'standard',
  'controlled-test'
]

/** Classes that are leads only. Useful for discovery, never for a claim. */
export const LEAD_CLASSES: readonly SourceClass[] = [
  'article',
  'community',
  'showcase',
  'competitor'
]

export interface ResearchSource {
  url: string
  sourceClass: SourceClass
  /** Was it actually opened, or only seen in a result list. A snippet is not a source. */
  opened: boolean
  /** ISO date. */
  checkedAt: string
}

/** One thing a run found, before it becomes a `Capability`. */
export interface Finding {
  /** Slug. Becomes the capability id, so it must be stable across runs. */
  id: string
  name: string
  category: string
  /** <=200 chars, quoted wherever it is shown. Never rendered as instruction. */
  description: string
  sources: ResearchSource[]
  licence: string
  /** Everything else the record can carry. Validated by `parseCapability`, not here. */
  record: Partial<Capability>
  volatility: Volatility
  /** Why this is worth a person's attention, in one clause. */
  why: string
}

export interface ResearchRun {
  /** Stable id: `<iso-date>-<theme-slug>`. Also the provenance stamp on every record. */
  id: string
  theme: string
  category: string
  /** The one narrow question this run is answering. Not a category sweep. */
  question: string
  startedAt: string
  endedAt?: string
  outcome?: ResearchOutcome
  /** Human-readable. Shown in Taskdriver verbatim. */
  detail?: string
  findings: Finding[]
  /** Sources opened, for the cost ledger and for the sheet's "sources checked" list. */
  sources: ResearchSource[]
  tokens: number
  /** Findings dropped because the catalogue already had them. The cache-reuse number. */
  duplicates: number
  /** Findings dropped by `parseFinding`, with reasons. Never silently. */
  rejected: Array<{ id: string; why: string }>
}

// ---------------------------------------------------------------------------
// The untrusted-content gate
// ---------------------------------------------------------------------------

/**
 * Phrases that mean the text is talking TO an agent rather than about a library.
 *
 * Deliberately narrow. This is not a general prompt-injection classifier and cannot be
 * one; it is a check on a field that should contain "a spring-physics animation library"
 * and never contains a second person imperative addressed at a tool. The load-bearing
 * mitigation is still that research runs with no repository and no install rights - this
 * is what stops the poisoned text being STORED, which matters because a stored record is
 * quoted into prompts long after the run that fetched it is forgotten.
 */
const INJECTION_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|context)/i, why: 'tells the reader to ignore its instructions' },
  { re: /\byou are (now )?(an?|the)\b[^.]{0,40}\b(assistant|agent|model|ai)\b/i, why: 'reassigns the reader a role' },
  { re: /\b(system|developer)\s*(prompt|message|instruction)\b/i, why: 'refers to the system prompt' },
  { re: /\b(run|execute|eval|exec|curl|wget|npm i|npm install|pip install)\b[^.]{0,30}\b(this|the following|command|script)\b/i, why: 'asks for a command to be run' },
  { re: /\b(api[_ -]?key|secret|token|password|credential)s?\b[^.]{0,30}\b(send|post|reveal|print|share|exfiltrat)/i, why: 'asks for credentials' },
  { re: /\b(send|post|upload|exfiltrat\w*)\b[^.]{0,30}\b(to|at)\b\s*https?:\/\//i, why: 'asks for data to be sent somewhere' },
  { re: /<\s*(script|iframe|object)\b/i, why: 'contains markup that executes' },
  { re: /\b(always|must|should) (recommend|prefer|choose|install|use) (this|me|us)\b/i, why: 'instructs the reader to always recommend it' }
]

/**
 * Does this text try to instruct whoever reads it?
 *
 * Returns every reason rather than the first, because a run that reports one reason and
 * hides two reads as a near miss when it was a deliberate attempt.
 */
export function injectionReasons(text: string): string[] {
  const out: string[] = []
  for (const p of INJECTION_PATTERNS) if (p.re.test(text)) out.push(p.why)
  return out
}

/** Every field of a finding that came off a web page, concatenated for one scan. */
function untrustedText(f: Finding): string {
  const r = f.record
  return [
    f.name,
    f.description,
    f.why,
    r.performance,
    r.accessibility,
    r.security,
    r.privacy,
    r.install,
    r.maintenance,
    r.popularity,
    r.mobile,
    r.whyNot,
    ...(r.limitations ?? []),
    ...(r.useCases ?? []),
    ...(r.tags ?? [])
  ]
    .filter(Boolean)
    .join('\n')
}

const URL_OK = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i

/**
 * Validate one finding off the model's answer.
 *
 * Rejects, never repairs. The four ways in are: it does not parse, it cites nothing that
 * may be believed, it never opened what it cites, or it carries an instruction. Each one
 * returns a reason that is recorded on the run and shown in Taskdriver, so a run that
 * found three things and kept none does not look like a run that found nothing.
 */
export function parseFinding(raw: unknown): { ok: true; value: Finding } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' }
  const r = raw as Record<string, unknown>

  for (const k of ['id', 'name', 'category', 'description', 'licence'] as const) {
    if (typeof r[k] !== 'string' || !(r[k] as string).trim()) return { ok: false, why: `missing ${k}` }
  }

  const rawSources = Array.isArray(r.sources) ? r.sources : []
  const sources: ResearchSource[] = []
  for (const s of rawSources) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    // https only, and a hostname that looks like one. A finding sourced from a file:// or
    // an http:// page is a finding sourced from something that was not on the public web.
    if (!URL_OK.test(url)) continue
    const cls = o.sourceClass as SourceClass
    if (!EVIDENCE_CLASSES.includes(cls) && !LEAD_CLASSES.includes(cls)) continue
    sources.push({
      url: url.slice(0, 300),
      sourceClass: cls,
      opened: o.opened === true,
      checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt.slice(0, 40) : ''
    })
  }
  if (!sources.length) return { ok: false, why: 'no usable source' }

  // The rule the whole source policy exists for: a lead is not evidence. A finding whose
  // only citation is a Reddit thread or a showcase page is a rumour with a URL on it.
  const evidence = sources.filter((s) => EVIDENCE_CLASSES.includes(s.sourceClass) && s.opened)
  if (!evidence.length) {
    return { ok: false, why: 'no opened primary source - leads are not evidence' }
  }

  const finding: Finding = {
    id: (r.id as string).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80),
    name: (r.name as string).trim().slice(0, 80),
    category: (r.category as string).trim(),
    description: (r.description as string).trim().slice(0, 200),
    sources,
    licence: (r.licence as string).trim().slice(0, 40),
    record: (r.record && typeof r.record === 'object' ? r.record : {}) as Partial<Capability>,
    volatility: (['fast', 'medium', 'slow', 'inert'] as const).includes(r.volatility as never)
      ? (r.volatility as Volatility)
      : 'medium',
    why: typeof r.why === 'string' ? r.why.trim().slice(0, 200) : ''
  }

  const reasons = injectionReasons(untrustedText(finding))
  if (reasons.length) return { ok: false, why: `hostile content: ${reasons.join('; ')}` }

  return { ok: true, value: finding }
}

/**
 * Is the catalogue's answer good enough that this run should not happen?
 *
 * The cache. A record that matches the question, is trusted, and is not due review is a
 * reason to skip - and skipping is the cheapest possible outcome, so it is checked before
 * anything is opened. `needsReview` is what lets a fast-moving record fall out of the cache
 * on its own schedule rather than on a global timer.
 */
export function coveredBy(
  catalogue: Capability[],
  terms: string[],
  now: number = Date.now()
): Capability | null {
  const wanted = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 2)
  if (!wanted.length) return null
  for (const c of catalogue) {
    if (c.status !== 'reviewed' && c.status !== 'verified') continue
    const hay = [c.name, c.category, c.description, ...(c.tags ?? []), ...c.useCases]
      .join(' ')
      .toLowerCase()
    const hits = wanted.filter((t) => hay.includes(t)).length
    if (hits < Math.max(1, Math.ceil(wanted.length * 0.6))) continue
    // `needsReview`, not `isStale`: staleness only decides whether a record is FLAGGED when
    // it reaches a prompt, whereas this decides whether a research run happens at all, and
    // those two deserve different clocks - see the comment on `needsReview`.
    if (needsReview(c, now)) continue
    return c
  }
  return null
}
