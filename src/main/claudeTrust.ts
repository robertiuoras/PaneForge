// "Do you trust the files in this folder?" - answered from what you already trusted.
//
// Claude Code keys trust, allowed tools and MCP servers on the pane's `cwd` inside
// `.claude.json`. Open a pane one folder deeper than the repo you have worked in all
// week and it is a brand new key: the CLI opens on the trust prompt with every
// permission forgotten, and the agent sits there until a human presses a key. In a
// session an agent started, nobody is watching, so the pane looks hung.
//
// Lanes already got this treatment (see lanes.ts seedClaudeProjectSettings, which
// copies a repo's settings onto its lane checkout). This is the same idea for every
// other pane: find the nearest ANCESTOR folder that is already trusted and copy its
// entry down. Nothing is granted that was not granted on a folder above it - opening
// `<repo>/backend` inherits from `<repo>`, and a folder with no trusted ancestor still
// gets the prompt.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Claude Code's config folder, honouring the override it reads itself. */
function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override || join(homedir(), '.claude')
}

/**
 * Everything that makes a folder feel already-known. Deliberately not the whole
 * entry: prompt history and per-folder counters belong to the folder they were
 * recorded in.
 */
const KEEP = [
  'allowedTools',
  'mcpContextUris',
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'projectOnboardingSeenCount',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown'
]

/**
 * Both slash forms, because Claude Code keys on its own `cwd` string and that arrives
 * as `C:\repo` or `C:/repo` depending on how it was launched.
 */
function forms(p: string): string[] {
  const abs = resolve(p)
  return [abs, abs.replace(/\\/g, '/')]
}

function configPath(): string | undefined {
  return [join(claudeHome(), '.claude.json'), join(homedir(), '.claude.json')].find((p) =>
    existsSync(p)
  )
}

/**
 * Give `cwd` the trust its nearest trusted ancestor already has. No-ops when the
 * folder is known, when no ancestor is trusted, or when the file cannot be read -
 * every one of those leaves the CLI to ask, which is the behaviour without this.
 */
export function ensureTrusted(cwd: string): void {
  const path = configPath()
  if (!path) return
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      projects?: Record<string, Record<string, unknown>>
    }
    if (!data.projects) return
    // Already known - never overwrite a folder's own settings.
    if (forms(cwd).some((k) => data.projects![k])) return

    // Walk up until a trusted ancestor turns up or the drive root runs out.
    let dir = dirname(resolve(cwd))
    let from: Record<string, unknown> | undefined
    for (let guard = 0; guard < 40; guard++) {
      from = forms(dir)
        .map((k) => data.projects![k])
        .find((e) => e && e['hasTrustDialogAccepted'] === true)
      if (from) break
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
    if (!from) return

    const entry: Record<string, unknown> = {}
    for (const k of KEEP) if (k in from) entry[k] = from[k]
    for (const k of forms(cwd)) data.projects[k] = { ...entry }

    // Write-then-rename: this file is Claude Code's own, and a torn write would cost
    // the user every setting in it.
    const tmp = `${path}.paneforge.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    /* unreadable, or a live session is writing it - the pane still starts */
  }
}
