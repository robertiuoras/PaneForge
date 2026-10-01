// The disk half of shared/codexTrust.ts: Codex's own config.toml.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withCodexTrust } from '../shared/codexTrust'

/** Codex's config file, honouring the CODEX_HOME override it reads itself. */
export function codexConfigFile(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'config.toml')
}

/**
 * Mark this folder trusted before Codex starts in it, so the pane does not open on a
 * question. Creates the file when Codex has never run on this machine.
 *
 * Every failure is silent and leaves the file as it was: the worst outcome is the
 * prompt the person can still answer. Written through a temp file and renamed, because
 * Codex reads this file on every launch and a torn write would lose every setting in it.
 */
export function trustCodexFolder(
  cwd: string,
  file = codexConfigFile(),
  win = process.platform === 'win32'
): boolean {
  try {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : null
    const next = withCodexTrust(text, cwd, win)
    if (next === null) return false
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.pf-${process.pid}`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
