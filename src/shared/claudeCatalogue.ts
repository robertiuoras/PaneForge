// Claude's model list, read off the installed CLI rather than typed into this app.
//
// The CLI binary carries every model id it knows how to launch as a plain string, so a
// new model (Opus 5.5 arrived 2026-09-23 while the picker still topped out at Opus 5)
// reaches the picker the moment the CLI updates itself - no PaneForge release needed.
// Pure judgements only; `main/claudeModels.ts` does the reading. `npm run test:claudemodels`.

import type { ModelChoice } from './agents'

const FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'] as const
type Family = (typeof FAMILIES)[number]

/** `claude-opus-5-5` -> family opus, version [5, 5]. Dated snapshots and odd ids -> null. */
export function parseClaudeId(id: string): { family: Family; version: number[] } | null {
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d)(?:-(\d))?$/.exec(id)
  if (!m) return null
  return { family: m[1] as Family, version: m[3] === undefined ? [Number(m[2])] : [Number(m[2]), Number(m[3])] }
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Every launchable id named in a chunk of the CLI's bytes. */
export function claudeIdsIn(text: string): string[] {
  const out = new Set<string>()
  // The lookahead refuses the prefix of a dated snapshot (`claude-opus-4-1-20250805`)
  // and of a longer run of digits (`claude-haiku-3-55`).
  for (const m of text.matchAll(/claude-(?:fable|opus|sonnet|haiku)-\d(?:-\d)?(?![\d-])/g)) {
    if (parseClaudeId(m[0])) out.add(m[0])
  }
  return [...out]
}

const label = (family: Family, version: number[]): string =>
  `${family[0].toUpperCase()}${family.slice(1)} ${version.join('.')}`

/**
 * The hand-written list, with every id the CLI knows that is NEWER than anything the
 * list already offers for that family added at the top, newest first.
 *
 * Only newer: the binary also names every retired generation (Opus 4.0, Sonnet 3.7),
 * and a picker that grew those back would be worse than the one written by hand. They
 * stay reachable through "Other...". A family the list does not carry at all is new
 * too. `claude-fable-5` beside `claude-fable-5-1` is the same model the CLI trims to a
 * prefix, so a bare major is dropped whenever a minor of it is known.
 */
export function mergeClaudeModels(curated: ModelChoice[], live: string[]): ModelChoice[] {
  const valueOf = (c: ModelChoice): string => (typeof c === 'string' ? c : c.value)
  const have = new Set(curated.map(valueOf))
  const newest = new Map<Family, number[]>()
  for (const c of curated) {
    const p = parseClaudeId(valueOf(c))
    if (p && compare(p.version, newest.get(p.family) ?? [-1]) > 0) newest.set(p.family, p.version)
  }
  const parsed = live.map((id) => ({ id, p: parseClaudeId(id) })).filter((x) => x.p && !have.has(x.id))
  const fresh = parsed
    .filter(({ p }) => compare(p!.version, newest.get(p!.family) ?? [-1]) > 0)
    .filter(({ id, p }) => !(p!.version.length === 1 && live.some((o) => o.startsWith(id + '-'))))
    .sort((a, b) => FAMILIES.indexOf(a.p!.family) - FAMILIES.indexOf(b.p!.family) || compare(b.p!.version, a.p!.version))
    .map(({ id, p }) => ({ value: id, label: label(p!.family, p!.version), hint: 'new, from your Claude CLI' }))
  if (!fresh.length) return curated
  return [...fresh, ...curated]
}
