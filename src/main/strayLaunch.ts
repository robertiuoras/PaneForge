// The disk half of shared/strayLaunch.ts: find the installed copy and read its version.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { plistVersion, strayLaunch, type StrayVerdict } from '../shared/strayLaunch'
import { headlessMode, profileName } from './profile'

const MAC_INSTALLED = '/Applications/PaneForge.app'

function installedCopy(): { path: string; version: string } | null {
  if (process.platform !== 'darwin') return null
  const plist = join(MAC_INSTALLED, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const version = plistVersion(readFileSync(plist, 'utf8'))
    return version ? { path: MAC_INSTALLED, version } : null
  } catch {
    return null
  }
}

/**
 * Decide, and when the answer is `go`, release the caller's single-instance lock and
 * open the installed copy. The caller quits.
 * Returns the verdict and the installed path so the quit line can name both.
 */
export function handOffToInstalled(): { verdict: StrayVerdict; installed: string } {
  const installed = installedCopy()
  const verdict = strayLaunch({
    execPath: process.execPath,
    version: app.getVersion(),
    profile: profileName(),
    headless: headlessMode(),
    packaged: app.isPackaged,
    installed
  })
  if (verdict === 'go' && installed) {
    // `open -a` goes through LaunchServices, so the copy comes up as a normal launch of
    // its own bundle, single-instance lock and all. Release ours first: otherwise a
    // normal build-folder handoff is delivered back here as a second-instance event.
    try {
      app.releaseSingleInstanceLock()
      spawn('open', ['-a', installed.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch {
      return { verdict: 'no installed copy', installed: '' }
    }
  }
  return { verdict, installed: installed?.path ?? '' }
}
