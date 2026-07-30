// The knowledge interface, and nothing about where knowledge is kept.
//
// This file is deliberately free of Obsidian, of Markdown, of file paths and of Python.
// A provider implements `search`; the pipeline asks. That is the whole coupling, and it
// is what lets the same feature run against a vault, against a bundled fixture set, or
// against nothing at all without any of the callers changing.
//
// The vocabulary is the vault's, on purpose - see the header of `capability.ts` for why a
// second lifecycle would be a second source of truth about whether anything was checked.

import type { Lifecycle, Sensitivity } from './capability'

export type { Lifecycle, Sensitivity }

/** What a provider is asked. Every field is optional except the task itself. */
export interface KnowledgeQuery {
  /** The task in a sentence. What the user is trying to do, not their draft verbatim. */
  task: string
  /** Project slug. Required to reach anything `private`; never crosses to another project. */
  project?: string
  /** Narrow to one capability category, when the classifier is confident. */
  category?: string
  /** Extra terms, already lowercased. */
  keywords?: string[]
  /** Highest disclosure class allowed out. Never `restricted` - that is not a choice. */
  sensitivityMax?: Exclude<Sensitivity, 'restricted'>
  /**
   * Bring back `draft` and `inbox` too, labelled unverified.
   *
   * The same escape hatch `vaultindex.py --include-untrusted` has, and it means the same
   * thing: what comes back has not been checked and must not be presented as though it
   * had. Tests and the demonstration use it; the product default does not.
   */
  includeUntrusted?: boolean
  /** Hard ceiling on characters returned across all notes. Providers must respect it. */
  budgetChars?: number
  limit?: number
}

/** One retrieved thing, compact, with enough provenance to cite it. */
export interface KnowledgeNote {
  /** Stable id within the provider. */
  id: string
  title: string
  /** Provider name - `vault-index`, `markdown`, `catalogue`. Shown in the sheet. */
  provider: string
  /** Where it came from, human-readable. A vault path, a URL, a catalogue id. */
  source: string
  status: Lifecycle
  sensitivity: Sensitivity
  /** ISO date the claim was last confirmed. */
  updated: string
  /** Past its review window. Usable, but it has to say so. */
  stale: boolean
  /** The compact text. Already truncated by the provider to fit the budget. */
  text: string
  score: number
  /** Only `reviewed`/`verified` may be presented as something to act on. */
  trusted: boolean
}

export interface KnowledgeResult {
  notes: KnowledgeNote[]
  /** Providers that were asked and failed, with the reason. Never thrown. */
  problems: string[]
  chars: number
  /** True when every provider answered and simply had nothing. Not an error. */
  empty: boolean
}

export interface KnowledgeProvider {
  name: string
  /** Cheap check: is this provider configured and usable right now? */
  available(): Promise<boolean> | boolean
  search(query: KnowledgeQuery): Promise<KnowledgeNote[]>
}

export const TRUSTED_STATUS: readonly Lifecycle[] = ['reviewed', 'verified']

/** Statuses that are never returned, whatever is asked. */
export const NEVER: readonly Lifecycle[] = ['archived']

const SENSITIVITY_ORDER: Sensitivity[] = ['public', 'internal', 'private', 'restricted']

export function sensitivityAllowed(
  note: Sensitivity,
  max: Exclude<Sensitivity, 'restricted'>
): boolean {
  // `restricted` is unreachable by construction, not by comparison: it is refused when a
  // record is loaded, so this only ever sees it if something upstream was wrong.
  if (note === 'restricted') return false
  return SENSITIVITY_ORDER.indexOf(note) <= SENSITIVITY_ORDER.indexOf(max)
}

/**
 * Apply the policy every provider shares, so no provider can forget half of it.
 *
 * Providers filter what they can at their own source (the vault index refuses restricted
 * notes at build time, which is stronger than anything here). This is the second gate,
 * and it exists because a query-time filter spread across three implementations is three
 * chances to leave one out.
 */
export function applyPolicy(notes: KnowledgeNote[], q: KnowledgeQuery): KnowledgeNote[] {
  const max = q.sensitivityMax ?? 'internal'
  return notes.filter((n) => {
    if (NEVER.includes(n.status)) return false
    if (!sensitivityAllowed(n.sensitivity, max)) return false
    if (!q.includeUntrusted && !TRUSTED_STATUS.includes(n.status)) return false
    // A private note is invisible without a project, and invisible from another project.
    if (n.sensitivity === 'private' && !q.project) return false
    return true
  })
}

/**
 * Merge providers' answers into one budgeted, deduplicated package.
 *
 * Deduplication is by normalised text, not by id: the same fact reaching the prompt twice
 * from two providers costs the budget twice and reads as corroboration when it is one
 * source counted twice.
 */
export function mergeNotes(
  lists: KnowledgeNote[][],
  q: KnowledgeQuery
): { notes: KnowledgeNote[]; chars: number } {
  const budget = q.budgetChars ?? 2400
  const limit = q.limit ?? 6
  const all = lists.flat().sort((a, b) => b.score - a.score)

  const seen = new Set<string>()
  const out: KnowledgeNote[] = []
  let chars = 0
  for (const n of all) {
    const key = n.text.replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase()
    if (!key || seen.has(key)) continue
    if (chars + n.text.length > budget) {
      // Truncate rather than drop when there is meaningful room left: a half note with
      // its provenance beats a silently missing one.
      const room = budget - chars
      if (room < 200) break
      n.text = n.text.slice(0, room - 1) + '…'
    }
    seen.add(key)
    out.push(n)
    chars += n.text.length
    if (out.length >= limit) break
  }
  return { notes: out, chars }
}
