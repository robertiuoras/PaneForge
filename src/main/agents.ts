// Resolves the agent catalogue against this machine: which binaries actually exist,
// and where. The renderer uses the result to grey out CLIs that are not installed
// instead of letting you launch a pane that dies in a second.

import { getConfig } from './config'
import { orCatalogue, orStale, refreshOrModels } from './orModels'
import { which } from './which'
import {
  allAgents,
  findAgent,
  keyProviderFor,
  modelValue,
  OPENROUTER_KEY_VAR,
  type AgentInfo,
  type AgentSpec
} from '../shared/agents'
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
  const live = orChoices(orCatalogue(), { prefix, have: curated.map(modelValue) })
  if (!live.length) return spec
  return { ...spec, models: mergeOrModels(curated, live) }
}

export function listAgents(force = false): AgentInfo[] {
  // Never awaited. The catalogue below is read from memory, so a list that arrives
  // after this call simply reaches the next dialog open - nothing here waits on a
  // network that may not be there.
  if (orStale()) void refreshOrModels(invalidateAgents)
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.list
  const list = allAgents(getConfig().customAgents).map((spec) => {
    const path = which(spec.bin)
    // which() returns the input unchanged when it finds nothing.
    const available = path !== spec.bin
    return { ...withLiveModels(spec), available, path: available ? path : '' }
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
