// The disk half of shared/strayLaunch.ts: find the installed copy and read its version.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { plistVersion, strayLaunch, type StrayVerdict } from '../shared/strayLaunch'
import { headlessMode, profileName } from './profile'

// Only the original Electron identity may receive a stale build's handoff.
// The new PaneForge uses /Applications/PaneForge.app after the rename.
function installedCopy(): { path: string; version: string } | null {
  if (process.platform !== 'darwin') return null
  for (const path of ['/Applications/PaneForge Classic.app', '/Applications/PaneForge.app']) {
    const plist = join(path, 'Contents', 'Info.plist')
    if (!existsSync(plist)) continue
    try {
      const text = readFileSync(plist, 'utf8')
      if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.robert\.paneforge<\/string>/.test(text)) continue
      const version = plistVersion(text)
      if (version) return { path, version }
    } catch { /* inspect the other known location */ }
  }
  return null
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
