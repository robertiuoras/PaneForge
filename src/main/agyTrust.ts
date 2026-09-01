// The disk half of shared/agyTrust.ts: the one file Antigravity keeps its answer in.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TRUST_KEY, withTrusted } from '../shared/agyTrust'

export function agySettingsFile(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
}

/**
 * Say this folder is trusted, so the pane does not open on a question.
 *
 * Every failure is silent and leaves the file as it was. A settings file that is missing,
 * unreadable, or not an object means the CLI is not installed here or keeps its answer
 * somewhere this build does not know about - and in both cases the honest outcome is the
 * prompt the person can answer, never a settings file this app invented.
 *
 * Written through a temp file and renamed: the CLI reads this on its own launch, and a
 * half-written file would take out every trusted folder on the desk rather than one.
 */
export function trustAgyWorkspace(cwd: string, file = agySettingsFile()): boolean {
  try {
    if (!existsSync(file)) return false
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const next = withTrusted(raw[TRUST_KEY], cwd)
    if (!next) return false
    raw[TRUST_KEY] = next
    const tmp = `${file}.pf-${process.pid}`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
