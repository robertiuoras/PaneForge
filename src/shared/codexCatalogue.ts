// Codex's OWN model list, turned into the picker's menu, plus the reading of whether
// the CLI on this machine is behind.
//
// The list in `agents.ts` is hand-written and dated: it was measured on 2026-08-11 and
// held two ids. `gpt-6-astra` shipped after that and the app could not offer it at all -
// the only way to reach it was "Other..." and knowing the spelling. Codex already keeps
// the answer on disk: it refreshes `~/.codex/models_cache.json` from OpenAI on its own,
// and `~/.codex/version.json` records the newest release it has heard of. Both are read,
// neither is fetched - this file adds no network of its own and no schedule.
//
// Pure on purpose, exactly like `orCatalogue.ts`: it takes parsed JSON and returns
// choices, so the disk and the caching live in `main/codexModels.ts` and every
// judgement below is testable with no Codex installed. `npm run test:codexmodels`.

import type { ModelChoice } from './agents'

/**
 * The fields of `models_cache.json` this file reads. Everything optional: the payload is
 * somebody else's, written by a CLI that updates itself, so a missing or renamed field
 * must narrow the answer rather than throw.
 */
export interface CodexRawModel {
  slug?: unknown
  display_name?: unknown
  description?: unknown
  /** `list` means Codex itself offers it in its own picker; `hide` means it does not. */
  visibility?: unknown
  /** Codex's own ordering. Lower is newer/better - `gpt-6-astra` is 1. */
  priority?: unknown
}

/** Tolerant reader: `{ models: [...] }`, a bare array, or rubbish. */
export function parseCodexModels(payload: unknown): CodexRawModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { models?: unknown })?.models)
      ? (payload as { models: unknown[] }).models
      : []
  return rows.filter(
    (r): r is CodexRawModel =>
      !!r && typeof r === 'object' && typeof (r as CodexRawModel).slug === 'string' && !!(r as { slug: string }).slug
  )
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The first sentence of Codex's own description, which is written for a person and is
 * already the length of a menu hint. Codex's longer copy (`availability_nux`, the model
 * instructions) is deliberately not read: it is paragraphs, and it is not about choosing.
 */
function hintOf(m: CodexRawModel): string | undefined {
  const d = str(m.description)
  if (!d) return undefined
  const stop = d.indexOf('. ')
  const one = stop === -1 ? d : d.slice(0, stop + 1)
  return one.replace(/\.$/, '') || undefined
}

/**
 * What the picker should offer, newest first.
 *
 * Only `visibility: 'list'` rows: Codex hides `gpt-reserve` and `codex-auto-review` from
 * its own menu because neither is a model anybody picks for a pane, and offering them
 * here would be this app disagreeing with the CLI it launches. Ordered by Codex's own
 * `priority`, so a model published tomorrow arrives at the TOP without an edit here.
 */
export function codexChoices(rows: CodexRawModel[]): ModelChoice[] {
  return rows
    .filter((m) => str(m.visibility) === 'list')
    .map((m) => ({
      m,
      // A row with no priority sorts last rather than first: an unranked row is one this
      // reader did not understand, and the top of the menu is the wrong place to guess.
      p: typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER
    }))
    .sort((a, b) => a.p - b.p)
    .map(({ m }) => ({
      value: m.slug as string,
      label: str(m.display_name) || (m.slug as string),
      hint: hintOf(m),
      group: 'Codex'
    }))
}

/**
 * Codex's live list, with anything hand-written that it does not mention kept on the end.
 *
 * The live list LEADS, unlike `mergeOrModels`, where the curated shortcuts are the point
 * and the fetched catalogue is the long tail. Here the curated rows are two ids from
 * August and the live list is the CLI's own opinion of what exists today, so putting the
 * old two first would put `gpt-6-astra` under them for ever.
 */
export function mergeCodexModels(curated: ModelChoice[], live: ModelChoice[]): ModelChoice[] {
  if (!live.length) return curated
  const have = new Set(live.map((m) => (typeof m === 'string' ? m : m.value)))
  const rest = curated
    .map((m) => (typeof m === 'string' ? { value: m, label: m } : m))
    .filter((m) => !have.has(m.value))
    .map((m) => ({ ...m, group: 'Older' }))
  return [...live, ...rest]
}

/**
 * Compare two release strings the way a person reads them: 0.153.4 is newer than 0.153.1,
 * and 0.154.0 is newer than 0.153.99. Returns 1, -1 or 0.
 *
 * Deliberately not semver-complete - there is no prerelease ordering here, because the
 * only thing built on this is "offer an Update button", and the worst a wrong answer can
 * do is offer a button whose command is a no-op. Anything unreadable answers 0, which
 * offers nothing.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    (v.trim().match(/\d+/g) ?? []).slice(0, 4).map((n) => Number(n))
  const x = parts(a)
  const y = parts(b)
  if (!x.length || !y.length) return 0
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * The version string out of `codex --version` ("codex-cli 0.153.1"), or '' when the line
 * is not one. Read off the FIRST number group so a future banner line, a warning printed
 * above it or a differently-named binary all still answer.
 */
export function versionOf(output: string): string {
  const m = /(\d+\.\d+(?:\.\d+)*)/.exec(output ?? '')
  return m ? m[1] : ''
}

/** What `~/.codex/version.json` says the newest release is, or '' when it does not say. */
export function latestFromVersionFile(payload: unknown): string {
  const v = (payload as { latest_version?: unknown })?.latest_version
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Is the installed CLI behind?
 *
 * `false` for every uncertainty - no reading, an unreadable reading, or the two being
 * equal. A person is told their tools are stale only when something actually said so.
 */
export function isOutdated(installed: string, latest: string): boolean {
  if (!installed || !latest) return false
  return compareVersions(installed, latest) < 0
}
