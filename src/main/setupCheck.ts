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

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * `.claude.json`'s text, from where the CLI itself keeps it: `CLAUDE_CONFIG_DIR` when that
 * is set - and then ONLY there, because a home-folder file the CLI is not reading is not
 * the account it will use - the home folder otherwise.
 */
function claudeJson(): string {
  return readText(join(process.env.CLAUDE_CONFIG_DIR?.trim() || homedir(), '.claude.json'))
}

function isSignedIn(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  return OAUTH_RE.test(claudeJson())
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

/**
 * Which account each assistant is signed in with, so the first-run card can say "Signed in
 * as you@example.com" instead of a bare "Ready". Read off the CLIs' own files on this
 * machine and only ever drawn on this screen - nothing here is sent anywhere.
 *
 * Claude: `oauthAccount.emailAddress` in `.claude.json` (`claudeJson`). The slice stops at
 * the object's first `}`; `emailAddress` is its second key, ahead of the one nested object
 * (`ccOnboardingFlags`). Codex: the `email` claim inside the ChatGPT sign-in's `id_token`,
 * a JWT decoded locally. An API-key sign-in has no email: ''.
 */
export function signedInAccounts(): { claude: string; codex: string } {
  const claudeText = claudeJson()
  const at = claudeText.search(OAUTH_RE)
  const oauth = at < 0 ? '' : claudeText.slice(at, claudeText.indexOf('}', at) + 1 || undefined)
  const claude = /"emailAddress"\s*:\s*"([^"]+)"/.exec(oauth)?.[1] ?? ''

  let codex = ''
  try {
    const dir = process.env.CODEX_HOME || join(homedir(), '.codex')
    const auth = JSON.parse(readText(join(dir, 'auth.json')) || '{}') as { tokens?: { id_token?: unknown } }
    const jwt = typeof auth.tokens?.id_token === 'string' ? auth.tokens.id_token : ''
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as { email?: unknown }
    if (typeof claims.email === 'string') codex = claims.email
  } catch {
    /* unreadable or not a ChatGPT sign-in - the card says "Ready" without a name */
  }
  return { claude, codex }
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
