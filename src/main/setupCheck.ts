// Facts for the Welcome screen's setup checklist. Pure decision logic lives in
// `shared/setupCheck.ts`; this file is the only part that touches disk or PATH.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { which } from './which'
import { setupRows, type SetupFacts, type SetupRow } from '../shared/setupCheck'

// `~/.claude.json` is written by the CLI itself and has been seen with case-duplicate
// keys (`"oauthAccount"` and `"OauthAccount"` in the same object from two writers), so
// `JSON.parse` + a property read is not reliable - a regex over the raw text is.
const OAUTH_RE = /"oauthAccount"\s*:\s*\{/

function isSignedIn(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) return false
  try {
    return OAUTH_RE.test(readFileSync(join(home, '.claude.json'), 'utf8'))
  } catch {
    return false
  }
}

export function gatherSetupFacts(): SetupFacts {
  return {
    platform: process.platform,
    claudeInstalled: which('claude') !== 'claude',
    gitInstalled: which('git') !== 'git',
    signedIn: isSignedIn()
  }
}

export function checkSetup(): SetupRow[] {
  return setupRows(gatherSetupFacts())
}
