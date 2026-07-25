// Resolves the agent catalogue against this machine: which binaries actually exist,
// and where. The renderer uses the result to grey out CLIs that are not installed
// instead of letting you launch a pane that dies in a second.

import { getConfig } from './config'
import { which } from './which'
import { allAgents, findAgent, type AgentInfo, type AgentSpec } from '../shared/agents'

/** PATH scans are cheap but not free, and this is called on every dialog open. */
const TTL_MS = 20_000
let cache: { at: number; list: AgentInfo[] } | null = null

export function listAgents(force = false): AgentInfo[] {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.list
  const list = allAgents(getConfig().customAgents).map((spec) => {
    const path = which(spec.bin)
    // which() returns the input unchanged when it finds nothing.
    const available = path !== spec.bin
    return { ...spec, available, path: available ? path : '' }
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
