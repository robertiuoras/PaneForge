// OpenRouter's own model list, turned into the picker's shortcut menu.
//
// The catalogue in `agents.ts` is hand-written and dated: its prices were measured on
// 2026-08-15, and a model published after that day is reachable only by typing its id
// into "Other...". That is the whole gap this closes - `stealth/ox-alpha` went live on
// 2026-08-20 at $0/M and nothing in the app could say so.
//
// Pure on purpose: it takes the parsed JSON and returns choices, so the fetching,
// the caching and the disk all live in `main/orModels.ts` and every judgement below
// is testable with no network. `npm run test:orcatalogue`.

import type { ModelChoice } from './agents'

/** The fields of OpenRouter's `/api/v1/models` rows this file reads. Everything optional: the payload is somebody else's and a missing field must narrow the answer, never throw. */
export interface OrRawModel {
  id?: unknown
  name?: unknown
  created?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  supported_parameters?: unknown
}

/** Tolerant reader for whatever came back: `{ data: [...] }`, a bare array, or rubbish. */
export function parseCatalogue(payload: unknown): OrRawModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : []
  return rows.filter((r): r is OrRawModel => !!r && typeof r === 'object' && typeof (r as OrRawModel).id === 'string')
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : NaN
}

/** Dollars per MILLION input tokens. NaN when the row does not say. */
export function inputPrice(m: OrRawModel): number {
  return num(m.pricing?.prompt) * 1_000_000
}

/**
 * Can an agent CLI actually work in this pane?
 *
 * A model with no tool calling answers the first turn and then cannot read a file,
 * inside a pane that looks perfectly healthy - the failure this repo refuses
 * everywhere else. So the menu offers only models whose own endpoint says `tools`.
 * A row that does not list its parameters at all is DROPPED rather than guessed at:
 * this is a shortcut list, and anything left out is still one "Other..." away.
 */
export function usableInPane(m: OrRawModel): boolean {
  const p = m.supported_parameters
  return Array.isArray(p) && p.includes('tools')
}

export function isFree(m: OrRawModel): boolean {
  const inp = num(m.pricing?.prompt)
  const out = num(m.pricing?.completion)
  return inp === 0 && out === 0
}

/**
 * A model whose provider will not say who it is.
 *
 * OpenRouter's own page for these: "developed and operated by a third-party provider
 * who has chosen to remain anonymous... Prompts and completions are retained by the
 * provider and are not used for training." Retained by somebody unnamed is a fact a
 * person needs at the moment they pick the model, not in a document, so it rides in
 * the hint - the picker is where the decision is made.
 */
export function isStealth(m: OrRawModel): boolean {
  return String(m.id ?? '').startsWith('stealth/')
}

export function contextWords(n: unknown): string {
  const v = num(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M context`.replace('.0M', 'M')
  return `${Math.round(v / 1000)}k context`
}

export function priceWords(m: OrRawModel): string {
  if (isFree(m)) return 'free'
  const p = inputPrice(m)
  if (!Number.isFinite(p)) return ''
  return p >= 1 ? `$${p.toFixed(2)}/M` : `$${p.toFixed(3).replace(/0$/, '')}/M`
}

/** The right-hand line in the menu: what it costs, how much it holds, and who keeps it. */
export function hintFor(m: OrRawModel): string {
  const parts = [priceWords(m), contextWords(m.context_length)].filter(Boolean)
  if (isStealth(m)) parts.push('anonymous provider keeps your prompts')
  return parts.join(' · ')
}

/** OpenRouter names some rows "Z.ai: GLM 5.2"; the vendor is already the id's first half. */
export function labelFor(m: OrRawModel): string {
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : String(m.id)
  return name.replace(/^[^:]{1,24}:\s*/, '').replace(/\s*\(free\)$/i, '')
}

export interface ChoiceOpts {
  /** `openrouter/` for the CLIs that address OpenRouter through their own provider prefix. */
  prefix?: string
  /** ids already in the hand-written list, so the curated label wins and nothing repeats. */
  have?: string[]
  /** how many PAID rows to carry. Free ones are never capped - see below. */
  paidLimit?: number
}

/**
 * The live half of the menu.
 *
 * Free models are all carried and paid ones are capped, because the two answer
 * different questions. "What can I run today at no cost" has a small, complete
 * answer and is the reason anybody opens this list; "which of OpenRouter's several
 * hundred paid models" does not fit a dropdown and never did - those stay a curated
 * shortcut plus the id you type. Within each group, NEWEST first: a list that exists
 * so a model published last Tuesday can be found must put it where it can be seen.
 */
export function orChoices(payload: unknown, opts: ChoiceOpts = {}): ModelChoice[] {
  const prefix = opts.prefix ?? ''
  const have = new Set(opts.have ?? [])
  const paidLimit = opts.paidLimit ?? 25
  const rows = parseCatalogue(payload).filter(usableInPane)
  const byNew = (a: OrRawModel, b: OrRawModel): number => num(b.created) - num(a.created) || String(a.id).localeCompare(String(b.id))
  const choice = (m: OrRawModel, group: string): ModelChoice => ({
    value: prefix + String(m.id),
    label: labelFor(m),
    hint: hintFor(m),
    group
  })
  const free = rows.filter(isFree).sort(byNew).map((m) => choice(m, 'Free on OpenRouter'))
  const paid = rows.filter((m) => !isFree(m)).sort(byNew).slice(0, paidLimit).map((m) => choice(m, 'More on OpenRouter'))
  return [...free, ...paid].filter((c) => !have.has((c as { value: string }).value))
}

/**
 * The hand-written shortcuts, then whatever OpenRouter has published since.
 *
 * The curated rows keep their own labels and their own prices - they were written by
 * somebody who knew why that model is on the list - and they are grouped so the menu
 * still opens on them. Nothing is replaced by the live list; it is only ever added to,
 * which is what makes a stale or unreachable catalogue cost nothing at all.
 */
export function mergeOrModels(curated: ModelChoice[], live: ModelChoice[]): ModelChoice[] {
  const head = curated.map((m) =>
    typeof m === 'string' ? { value: m, label: m, group: 'Suggested' } : { group: 'Suggested', ...m }
  )
  const have = new Set(head.map((m) => m.value))
  return [...head, ...live.filter((m) => !have.has(typeof m === 'string' ? m : m.value))]
}
