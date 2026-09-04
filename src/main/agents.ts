// Resolves the agent catalogue against this machine: which binaries actually exist,
// and where. The renderer uses the result to grey out CLIs that are not installed
// instead of letting you launch a pane that dies in a second.

import { codexCatalogue, codexInstalledVersion, codexLatest } from './codexModels'
import { getConfig } from './config'
import { orCatalogue, orStale, refreshOrModels } from './orModels'
import { which } from './which'
import {
  allAgents,
  findAgent,
  keyProviderFor,
  OPENROUTER_KEY_VAR,
  siblingModels,
  type AgentInfo,
  type AgentSpec
} from '../shared/agents'
import { codexChoices, isOutdated, mergeCodexModels } from '../shared/codexCatalogue'
import { mergeOrModels, orChoices } from '../shared/orCatalogue'

/** PATH scans are cheap but not free, and this is called on every dialog open. */
const TTL_MS = 20_000
let cache: { at: number; list: AgentInfo[] } | null = null

/**
 * How this agent addresses an OpenRouter model, or null when it does not.
 *
 * Read off the spec's own `env` rather than off a list of ids: an agent that
 * AUTHENTICATES with the OpenRouter key names the model bare (`z-ai/glm-5.2`), and one
 * that merely passes the key to a provider of its own reaches it through a prefix
 * (`openrouter/z-ai/glm-5.2`). So an agent added to the catalogue is covered here
 * without an edit, which is the same law the key fields in Settings are drawn under.
 */
function orPrefix(spec: AgentSpec): string | null {
  if (keyProviderFor(spec) === 'openrouter') return ''
  return Object.values(spec.env ?? {}).includes(OPENROUTER_KEY_VAR) ? 'openrouter/' : null
}

/** The hand-written shortcuts, plus whatever OpenRouter has published since. */
function withLiveModels(spec: AgentSpec): AgentSpec {
  const prefix = orPrefix(spec)
  if (prefix === null) return spec
  const curated = spec.models ?? []
  // No `have` filter: `mergeOrModels` dedupes, and it can only refresh a curated row's
  // price if the live row for that id actually reaches it.
  const live = orChoices(orCatalogue(), { prefix })
  if (!live.length) return spec
  return { ...spec, models: mergeOrModels(curated, live) }
}

/**
 * Codex's hand-written shortcuts, replaced by the list Codex itself keeps on disk.
 *
 * No fetch and no key: the CLI refreshes `~/.codex/models_cache.json` on its own, so the
 * app only has to look. An empty answer is a FAILED answer - Codex never ran here, or the
 * file is mid-write - and leaves the built-in list exactly as it was.
 */
function withCodexModels(spec: AgentSpec): AgentSpec {
  if (spec.id !== 'codex') return spec
  const live = codexChoices(codexCatalogue())
  if (!live.length) return spec
  return { ...spec, models: mergeCodexModels(spec.models ?? [], live) }
}

export function listAgents(force = false): AgentInfo[] {
  // Never awaited. The catalogue below is read from memory, so a list that arrives
  // after this call simply reaches the next dialog open - nothing here waits on a
  // network that may not be there.
  if (orStale()) void refreshOrModels(invalidateAgents)
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.list
  const cfg = getConfig()
  const keys = cfg.providerKeys ?? {}
  const hasKey = (provider: string): boolean => Boolean(keys[provider]?.trim())
  // Enriched FIRST, so a sibling's list carries the live OpenRouter catalogue too: a
  // key pasted today must reach the models published this week, not only the eight
  // hand-written shortcuts.
  const specs = allAgents(cfg.customAgents).map(withLiveModels).map(withCodexModels)
  const list = specs.map((spec) => {
    const path = which(spec.bin)
    // which() returns the input unchanged when it finds nothing.
    const available = path !== spec.bin
    const siblings = siblingModels(spec, specs, hasKey)
    const models = siblings.length ? [...(spec.models ?? []), ...siblings] : spec.models
    // Only Codex publishes both halves of this reading, so only Codex carries it. The
    // ask is a spawn and never awaited: the first list says nothing, the answer lands a
    // moment later and `invalidateAgents` brings the next dialog open the number.
    const version = available && spec.id === 'codex' ? codexInstalledVersion(spec.bin, invalidateAgents) : ''
    const latest = version ? codexLatest() : ''
    return {
      ...spec,
      models,
      available,
      path: available ? path : '',
      ...(version ? { version } : {}),
      ...(version && latest ? { latest, outdated: isOutdated(version, latest) } : {})
    }
  })
  cache = { at: Date.now(), list }
  return list
}

/** Drops the cache so a newly installed CLI (or an edited custom agent) shows up. */
export function invalidateAgents(): void {
  cache = null
}

/** The spec to launch for an id, falling back to the first known agent. */
export function specFor(id: string | undefined): AgentSpec {
  return findAgent(allAgents(getConfig().customAgents), id)
}
