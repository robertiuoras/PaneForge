import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot } from './config'
import { which } from './which'
import type { IncludedAccounts } from '../shared/types'

function run(args: string[]): Promise<string> {
  const script = join(projectsRoot(), 'claude-memory', 'claude-config', 'ai-accounts.mjs')
  if (!existsSync(script)) return Promise.reject(new Error('The included-account manager is not installed on this computer.'))
  return new Promise((resolve, reject) => {
    execFile(which('node'), [script, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      // Never relay subprocess errors: a credential helper may include private data.
      if (error) reject(new Error('The account manager could not finish. Check that the computer is online and the saved login is available.'))
      else resolve(stdout)
    })
  })
}

export async function includedAccounts(target: 'local' | 'pc', change?: { provider: 'claude' | 'codex'; email: string }): Promise<IncludedAccounts> {
  if (target !== 'local' && target !== 'pc') throw new Error('Unknown computer')
  if (target === 'pc' && process.platform !== 'darwin') throw new Error('Use this computer on the PC')
  const suffix = target === 'pc' ? ['--on', 'pc'] : []
  const read = async (): Promise<IncludedAccounts> => {
    let raw: Record<string, any>
    try {
      raw = JSON.parse(await run(['status', '--json', ...suffix]))
      if (!raw || typeof raw !== 'object') throw new Error()
    } catch {
      throw new Error('Account status is unavailable')
    }
    const result: IncludedAccounts = { claude: { live: null, saved: [] }, codex: { live: null, saved: [] } }
    for (const provider of ['claude', 'codex'] as const) {
      const entry = raw[provider]
      if (!entry || !Array.isArray(entry.saved)) throw new Error('Account status is unavailable')
      result[provider] = {
        live: typeof entry.live === 'string' ? entry.live : null,
        saved: entry.saved.filter((p: unknown) => p && typeof (p as { email?: unknown }).email === 'string').map((p: { email: string; plan?: unknown }) => ({
          email: p.email, plan: typeof p.plan === 'string' ? p.plan : null
        }))
      }
    }
    return result
  }
  const before = await read()
  if (!change) return before
  if (!['claude', 'codex'].includes(change.provider) || typeof change.email !== 'string' || !/^[A-Za-z0-9._+@-]{3,254}$/.test(change.email)) throw new Error('Invalid saved account')
  if (!before[change.provider].saved.some((p) => p.email === change.email)) throw new Error('That saved account is no longer available')
  await run(['use', change.provider, change.email, ...suffix])
  const after = await read()
  if (after[change.provider].live !== change.email) throw new Error('The selected login was not confirmed')
  return after
}
