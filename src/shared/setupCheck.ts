// The Welcome screen's "Get set up" checklist: pure decision logic, no I/O. Facts about
// the machine are gathered in `main/setupCheck.ts` (which stats disk and shells out to
// `which`); this file only turns them into rows a first-time user can read and act on.
//
// Every row disappears the moment its fact is true, so a person who already has
// PaneForge working the way Robert does never sees this card at all.

export interface SetupFacts {
  /** `process.platform`, so a Windows-only row (Git) never shows on Mac/Linux. */
  platform: string
  /** `claude` resolves to a real file on PATH. */
  claudeInstalled: boolean
  /** `git` resolves to a real file on PATH - only checked/shown on Windows. */
  gitInstalled: boolean
  /** `~/.claude.json` has an `oauthAccount`, or `ANTHROPIC_API_KEY` is set. */
  signedIn: boolean
  /** `codex` resolves to a real file on PATH. */
  codexInstalled: boolean
  /** Codex's `auth.json` holds a ChatGPT sign-in or an API key. */
  codexSignedIn: boolean
}

export type SetupRowId = 'git' | 'claude' | 'signin' | 'codex' | 'codex-signin'

export interface SetupRow {
  id: SetupRowId
  /** Plain English, read by someone who has never used a terminal. */
  text: string
  button: string
  /**
   * Codex is a second choice, not something missing: somebody who only ever uses Claude
   * must not carry an "Install Codex" row forever. The Welcome checklist leaves these
   * out; only the first-run card (`FirstRunCard.tsx`) reads them.
   */
  optional?: boolean
}

/**
 * On Windows the Git row comes FIRST: Claude Code's own install advice is to have Git
 * for Windows in place first so the CLI gets a Bash tool from the start, so a person
 * working straight down the list installs things in the order that avoids a re-run.
 */
export function setupRows(facts: SetupFacts): SetupRow[] {
  const rows: SetupRow[] = []
  if (facts.platform === 'win32' && !facts.gitInstalled) {
    rows.push({ id: 'git', text: 'Install Git - recommended, so Claude Code can run commands the usual way on Windows', button: 'Install' })
  }
  if (!facts.claudeInstalled) {
    rows.push({ id: 'claude', text: 'Install Claude Code', button: 'Install' })
  }
  if (!facts.signedIn) {
    rows.push({ id: 'signin', text: 'Sign in to Claude', button: 'Sign in' })
  }
  if (!facts.codexInstalled) {
    rows.push({ id: 'codex', text: 'Install Codex', button: 'Install', optional: true })
  } else if (!facts.codexSignedIn) {
    rows.push({ id: 'codex-signin', text: 'Sign in to Codex', button: 'Sign in', optional: true })
  }
  return rows
}
