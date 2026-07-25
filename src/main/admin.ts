// Running PaneForge elevated without a UAC prompt every launch.
//
// Windows has no way for an app to elevate itself silently - that is the whole
// point of UAC. The one sanctioned escape hatch is Task Scheduler: a task marked
// "run with highest privileges" starts elevated, and `schtasks /run` on it needs
// no consent because the *task* was consented to once, when it was registered.
//
// So enabling admin mode costs exactly one UAC prompt, ever:
//   1. elevate a PowerShell one-liner that registers the task (the single prompt)
//   2. write a tiny hidden launcher that does `schtasks /run /tn PaneForge`
//   3. repoint the Desktop / Start Menu / taskbar shortcuts at that launcher
//
// Trade-offs worth knowing, surfaced in the Settings copy:
//   - everything PaneForge spawns (every agent pane) is elevated too
//   - drag and drop from Explorer into an elevated window is blocked by Windows
//   - anyone who can write to the exe path can now get admin without a prompt,
//     so the task is re-registered on every build to keep it pinned to a path
//     under the user's own profile

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AdminStatus } from '../shared/types'

const TASK_NAME = 'PaneForge'

/** Stable home for the launcher: shortcuts must survive a rebuild into a new dist folder. */
function launcherDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'PaneForge')
}

function launcherPath(): string {
  return join(launcherDir(), 'launch-admin.vbs')
}

function ps(script: string, elevated = false): { ok: boolean; out: string } {
  const args = elevated
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        // -Wait so the caller can report the real result instead of "probably worked".
        `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encode(script)}'); exit $p.ExitCode`
      ]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]
  const r = spawnSync('powershell', args, { encoding: 'utf8', windowsHide: true })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

let elevatedCache: boolean | null = null

export function isElevated(): boolean {
  if (elevatedCache !== null) return elevatedCache
  if (process.platform !== 'win32') {
    elevatedCache = typeof process.getuid === 'function' && process.getuid() === 0
    return elevatedCache
  }
  // `fltmc` is a stock Windows tool that refuses to run without elevation, which
  // makes its exit code the cheapest admin probe that needs no extra dependency.
  try {
    elevatedCache = spawnSync('fltmc', [], { windowsHide: true }).status === 0
  } catch {
    elevatedCache = false
  }
  return elevatedCache
}

/** Exe the registered task points at, '' when there is no task. */
function taskTarget(): string {
  if (process.platform !== 'win32') return ''
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (r.status !== 0) return ''
  const m = /<Command>([^<]+)<\/Command>/i.exec(r.stdout ?? '')
  return m ? m[1].trim().replace(/^"|"$/g, '') : ''
}

export function adminStatus(): AdminStatus {
  const target = taskTarget()
  return {
    supported: process.platform === 'win32',
    elevated: isElevated(),
    taskInstalled: Boolean(target),
    taskTarget: target,
    exePath: app.getPath('exe')
  }
}

/**
 * Register the task, write the launcher, repoint the shortcuts. Safe to re-run:
 * every build calls this so the task never points at a pruned dist folder.
 */
export function enableAdminMode(): { ok: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'No-prompt elevation is a Windows-only trick.' }
  }
  const exe = app.getPath('exe')
  if (exe.toLowerCase().endsWith('electron.exe')) {
    return { ok: false, message: 'Run the packaged app (npm run setup) before enabling admin mode.' }
  }

  const register = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '${q(exe)}' -WorkingDirectory '${q(dirname(exe))}'
$principal = New-ScheduledTaskPrincipal -UserId '${q(currentUser())}' -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Principal $principal -Settings $settings -Description 'Starts PaneForge elevated without a UAC prompt.' -Force | Out-Null
`.trim()

  // Registering a Highest-privilege task is itself an admin operation. When the app
  // is already elevated (the second run onwards) this costs no prompt at all.
  const r = ps(register, !isElevated())
  if (!r.ok) {
    return {
      ok: false,
      message: r.out.includes('canceled') || r.out.includes('cancelled')
        ? 'UAC prompt was declined, so nothing changed.'
        : `Could not register the task: ${firstLine(r.out) || 'unknown error'}`
    }
  }

  try {
    mkdirSync(launcherDir(), { recursive: true })
    // 0 = hidden window, False = do not wait: no console flash, no orphan wscript.
    writeFileSync(
      launcherPath(),
      `' Written by PaneForge. Starts the elevated scheduled task with no console flash.\r\n` +
        `CreateObject("WScript.Shell").Run "schtasks /run /tn ${TASK_NAME}", 0, False\r\n`,
      'utf8'
    )
  } catch (e) {
    return { ok: false, message: `Task registered but the launcher could not be written: ${String(e)}` }
  }

  const moved = pointShortcuts('wscript.exe', `"${launcherPath()}"`, exe)
  return {
    ok: true,
    message: `Admin mode on. ${moved} shortcut(s) now start PaneForge elevated with no prompt.`
  }
}

export function disableAdminMode(): { ok: boolean; message: string } {
  if (process.platform !== 'win32') return { ok: false, message: 'Nothing to disable on this platform.' }
  const exe = app.getPath('exe')
  const del = `schtasks /Delete /TN ${TASK_NAME} /F | Out-Null`
  const r = ps(del, !isElevated())
  pointShortcuts(exe, '', exe)
  return r.ok
    ? { ok: true, message: 'Admin mode off. Shortcuts start PaneForge normally again.' }
    : { ok: false, message: `Shortcuts reset, but the task could not be removed: ${firstLine(r.out)}` }
}

/** Start the elevated task and quit this instance - used by the "restart as admin" button. */
export function relaunchViaTask(): boolean {
  if (process.platform !== 'win32' || !taskTarget()) return false
  const r = spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], { windowsHide: true })
  return r.status === 0
}

/** Every .lnk that should point at the same thing: Desktop, Start Menu, taskbar pin. */
export function shortcutPaths(): string[] {
  const home = homedir()
  const startMenu = join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const pinned = join(
    home,
    'AppData',
    'Roaming',
    'Microsoft',
    'Internet Explorer',
    'Quick Launch',
    'User Pinned',
    'TaskBar',
    'PaneForge.lnk'
  )
  return [join(home, 'Desktop', 'PaneForge.lnk'), join(startMenu, 'PaneForge.lnk'), pinned].filter(existsSync)
}

/** Retarget the shortcuts; the icon stays the exe so the launcher stays invisible. */
function pointShortcuts(target: string, args: string, iconExe: string): number {
  const lnks = shortcutPaths()
  if (!lnks.length) return 0
  const script = lnks
    .map(
      (lnk) => `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}')
$s.TargetPath = '${q(target)}'
$s.Arguments = '${q(args)}'
$s.WorkingDirectory = '${q(dirname(iconExe))}'
$s.IconLocation = '${q(iconExe)},0'
$s.Save()`
    )
    .join('\n')
  return ps(script).ok ? lnks.length : 0
}

function currentUser(): string {
  const domain = process.env.USERDOMAIN
  const user = process.env.USERNAME ?? ''
  return domain ? `${domain}\\${user}` : user
}

/** PowerShell single-quoted string escaping. */
function q(s: string): string {
  return s.replace(/'/g, "''")
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim()) ?? ''
}
