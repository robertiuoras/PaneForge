/**
 * Putting the Desktop shortcut back, and keeping the login entry honest.
 *
 * The decision is `shared/winShortcut.ts`; this is the disk half. Both run once per
 * launch, both are silent when there is nothing to do, and neither may ever block the
 * main process - a PowerShell start is ~200ms and the window must not wait for it.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { desktopShortcutVerdict } from '../shared/winShortcut'

export function desktopShortcutPath(): string {
  // `app.getPath('desktop')` rather than `~/Desktop`: a machine with OneDrive's folder
  // backup on has its real Desktop under the OneDrive root, and writing to the other one
  // puts the shortcut somewhere nobody is looking.
  return join(app.getPath('desktop'), 'PaneForge.lnk')
}

/**
 * Create the Desktop shortcut if it is missing. Returns the line for `updater.log`.
 *
 * Fire and forget: the answer arrives in the log, because there is nothing the app would
 * do differently either way.
 */
export function ensureDesktopShortcut(wanted: boolean, onDone?: (line: string) => void): void {
  const lnk = desktopShortcutPath()
  const v = desktopShortcutVerdict({
    platform: process.platform,
    packaged: app.isPackaged,
    exePath: process.execPath,
    linkExists: existsSync(lnk),
    wanted
  })
  if (!v.make) return onDone?.(`shortcut ${v.reason}`)
  const exe = process.execPath
  const q = (s: string): string => s.replace(/'/g, "''")
  const script = `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}')
$s.TargetPath = '${q(exe)}'
$s.WorkingDirectory = '${q(join(exe, '..'))}'
$s.IconLocation = '${q(exe)},0'
$s.Description = 'PaneForge'
$s.Save()`
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: 20_000 },
    (err) => {
      const ok = !err && existsSync(lnk)
      onDone?.(ok ? `shortcut recreated at ${lnk}` : `shortcut could not be recreated: ${err?.message ?? 'not written'}`)
    }
  )
}

/**
 * Re-apply the login entry from config on every launch.
 *
 * `setLoginItemSettings` was only ever called when the SETTING changed, so the registry
 * value was written once and never checked again - and the Run entry is exactly the kind
 * of thing an installer, a cleanup tool or a Windows reset drops. "It does not reopen
 * after a restart" is what that looks like, with the switch still reading On.
 */
export function syncLaunchAtLogin(wanted: boolean, onDone?: (line: string) => void): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  if (!app.isPackaged) return onDone?.('login entry skipped - running from source')
  try {
    const now = app.getLoginItemSettings()
    if (now.openAtLogin === wanted) return onDone?.(`login entry ${wanted ? 'on' : 'off'}`)
    app.setLoginItemSettings({ openAtLogin: wanted, args: [] })
    onDone?.(`login entry re-applied: ${wanted ? 'on' : 'off'} (was ${now.openAtLogin ? 'on' : 'off'})`)
  } catch (e) {
    onDone?.(`login entry could not be read: ${(e as Error)?.message ?? e}`)
  }
}
