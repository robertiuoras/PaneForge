// Turn a mission typed into the goal dialog into the `Ask` the router prices.
//
// D5.2 of `docs/agentic-dispatch.md`: `goal:add` derives a plan from `route()` instead of
// taking the hardcoded agent. The router itself is pure (`shared/dispatch.ts`); this file
// is the half that has to look at the world - which files the ask names that actually
// exist, whether the repo can check itself, and whether this exact ask has been dispatched
// before and how that went. Kept out of `index.ts` so `test:dispatch` can drive it against
// a real temp repo without a window.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Ask, Tier } from '../shared/dispatch'
import { findPathTokens } from '../shared/pathToken'
import { gateCommands } from './agentGate'

/**
 * The paths the ask names.
 *
 * A token with a separator is a claim about a place, so it must exist under the repo to
 * count - "fix src/foo/bar.ts" naming a file that is not there means the work has NOT
 * been located, whatever it looks like. A bare `name.ext` is kept without a check: people
 * name files without their folders far more often than they invent them, and demanding a
 * search here would put a filesystem walk in every keystroke of the goal dialog.
 */
export function askFiles(cwd: string, text: string): string[] {
  const out = new Set<string>()
  for (const t of findPathTokens(text)) {
    const token = t.text.replace(/\\/g, '/')
    if (token.includes('/')) {
      if (existsSync(join(cwd, token))) out.add(token)
    } else {
      out.add(token)
    }
  }
  return [...out]
}

/** What the last dispatched attempt at this exact mission looked like, if any. */
export interface PriorDispatch {
  tier?: Tier
  failed: boolean
}

/** Everything `route()` wants to know, read from the repo and the queue's own history. */
export function buildAsk(
  cwd: string,
  mission: string,
  prior: PriorDispatch | null,
  freeFirst = false
): Ask {
  const gate = gateCommands(cwd)
  return {
    text: mission,
    files: askFiles(cwd, mission),
    repo: {
      hasTypecheck: Boolean(gate.typecheck),
      hasTests: Boolean(gate.suite)
    },
    history: prior
      ? { sameAskBefore: true, lastAttemptFailed: prior.failed, lastTier: prior.tier }
      : {},
    freeFirst
  }
}
