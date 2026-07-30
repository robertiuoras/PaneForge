// The registry: which providers exist for this request, asked in parallel, merged once.
//
// Nothing above this line knows what a vault is. `retrieve()` takes a query and returns a
// budgeted, deduplicated, cited package - or an empty one, which is a normal answer and
// the common one.

import type { KnowledgeProvider, KnowledgeQuery, KnowledgeResult } from '../../shared/knowledge'
import { mergeNotes } from '../../shared/knowledge'
import type { CatalogueContext } from './catalogue'
import { catalogueProvider } from './catalogue'
import { markdownProvider } from './markdown'
import { vaultIndexProvider } from './vaultIndex'

export interface KnowledgeSettings {
  /** Obsidian vault root. Empty disables the Markdown provider. */
  vaultPath: string
  /** Absolute path to `vaultindex.py`. Empty disables the indexed provider. */
  indexScript: string
  /** Off means the capability catalogue is not consulted at all. */
  capabilities: boolean
}

export function providersFor(
  settings: KnowledgeSettings,
  context: CatalogueContext
): KnowledgeProvider[] {
  const list: KnowledgeProvider[] = []
  // Indexed first. When both are configured the indexed one wins on ranking, and the
  // Markdown reader is left in as the answer for whatever the index has not been rebuilt
  // to include yet - `mergeNotes` deduplicates whatever they both find.
  if (settings.indexScript) list.push(vaultIndexProvider({ scriptPath: settings.indexScript }))
  if (settings.vaultPath) list.push(markdownProvider({ vaultPath: settings.vaultPath }))
  if (settings.capabilities) list.push(catalogueProvider(context))
  return list
}

/**
 * Ask every available provider, merge, budget.
 *
 * A provider that throws or hangs contributes a line to `problems` and nothing else. The
 * improvement is worth running without knowledge; it is not worth failing over knowledge.
 */
export async function retrieve(
  providers: KnowledgeProvider[],
  query: KnowledgeQuery
): Promise<KnowledgeResult> {
  const problems: string[] = []
  const lists = await Promise.all(
    providers.map(async (p) => {
      try {
        if (!(await p.available())) return []
        return await p.search(query)
      } catch (e) {
        problems.push(`${p.name}: ${(e as Error).message ?? String(e)}`)
        return []
      }
    })
  )

  const { notes, chars } = mergeNotes(lists, query)
  return { notes, problems, chars, empty: notes.length === 0 }
}

export type { CatalogueContext }
export { catalogueProvider, markdownProvider, vaultIndexProvider }
export { defaultVaultCandidates, firstExistingVault } from './markdown'
export { ensureCapabilityDir, invalidateCapabilities, loadCapabilities } from './catalogue'
