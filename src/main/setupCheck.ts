// Facts for the Welcome screen's setup checklist. Pure decision logic lives in
// `shared/setupCheck.ts`; this file is the only part that touches disk or PATH.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

// Codex writes `auth.json` under `$CODEX_HOME` (default `~/.codex`) on sign-in and
// deletes it on `codex logout`. A ChatGPT sign-in fills `tokens`; an API-key sign-in
// fills `OPENAI_API_KEY` and leaves it `null` otherwise, so a present-but-null key is
// not a sign-in. Same raw-text reading as `.claude.json`, for the same reason.
const CODEX_AUTH_RE = /"(?:access_token|OPENAI_API_KEY)"\s*:\s*"[^"]/

function isCodexSignedIn(): boolean {
  // `homedir()`, not `$HOME`: Codex finds its folder through the OS profile, and on Windows
  // a `HOME` left behind by Git Bash can point somewhere else.
  const dir = process.env.CODEX_HOME || join(homedir(), '.codex')
  try {
    return CODEX_AUTH_RE.test(readFileSync(join(dir, 'auth.json'), 'utf8'))
  } catch {
    return false
  }
}

export function gatherSetupFacts(): SetupFacts {
  return {
    platform: process.platform,
    claudeInstalled: which('claude') !== 'claude',
    gitInstalled: which('git') !== 'git',
    signedIn: isSignedIn(),
    codexInstalled: which('codex') !== 'codex',
    codexSignedIn: isCodexSignedIn()
  }
}

export function checkSetup(): SetupRow[] {
  return setupRows(gatherSetupFacts())
}
