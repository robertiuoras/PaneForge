// One command to go from a fresh clone to a working desktop app:
//   npm run setup
// Installs deps if needed, builds the packaged exe, then points the Desktop, Start Menu
// and taskbar shortcuts at it. Safe to re-run after any source change.
//
// Each run builds into its own `dist/b<stamp>` folder and repoints the shortcuts, rather
// than overwriting one fixed folder. That is what lets PaneForge be developed from a
// Claude session running inside PaneForge: electron-builder cannot touch the exe of a
// running app, and killing the app would kill the session doing the work. The running
// instance keeps its old files; the next launch picks up the new build.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_ID = 'com.robert.paneforge'
const stamp = Date.now().toString(36)
const outDir = join('dist', `b${stamp}`)
const exe = join(root, outDir, 'win-unpacked', 'PaneForge.exe')

function step(label) {
  process.stdout.write(`\n== ${label}\n`)
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`\nFAILED: ${cmd} ${args.join(' ')}`)
    process.exit(r.status ?? 1)
  }
}

if (!existsSync(join(root, 'node_modules'))) {
  step('Installing dependencies (first run only)')
  run('npm', ['install'])
} else {
  step('Dependencies present, skipping npm install')
}

step(`Building the app into ${outDir}`)
run('npm', ['run', 'build'])
run('npx', [
  'electron-builder',
  process.platform === 'darwin' ? '--mac' : '--win',
  '--dir',
  `-c.directories.output=${outDir}`
])

if (process.platform === 'darwin') {
  step('Done')
  console.log(`Built: ${join(root, outDir, 'mac-arm64', 'PaneForge.app')}
Drag it into /Applications. On first launch macOS will say it cannot check the app:
right-click it and choose Open once, and that never comes back.`)
  process.exit(0)
}

if (!existsSync(exe)) {
  console.error(`\nBuild finished but ${exe} is missing. Nothing to link.`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  step('Done')
  console.log(`Built: ${exe}\n(Shortcut creation is Windows-only.)`)
  process.exit(0)
}

step('Pointing shortcuts at the new build')
const startMenu = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
mkdirSync(startMenu, { recursive: true })
// The taskbar pin is a real .lnk too, so retargeting it keeps the pin working instead of
// leaving it aimed at a build that is about to be pruned.
const pinned = join(
  homedir(),
  'AppData',
  'Roaming',
  'Microsoft',
  'Internet Explorer',
  'Quick Launch',
  'User Pinned',
  'TaskBar',
  'PaneForge.lnk'
)
const targets = [join(homedir(), 'Desktop', 'PaneForge.lnk'), join(startMenu, 'PaneForge.lnk')]
const all = [...targets, ...(existsSync(pinned) ? [pinned] : [])]

// WScript.Shell is the only dependency-free way to write a .lnk on Windows.
const ps = all
  .map(
    (lnk) => `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')
$s.TargetPath = '${exe}'
$s.WorkingDirectory = '${dirname(exe)}'
$s.IconLocation = '${exe},0'
$s.Description = 'PaneForge - run and manage Claude Code sessions'
$s.Save()`
  )
  .join('\n')

try {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    stdio: 'inherit'
  })
} catch {
  console.error('Could not write the shortcuts. The exe still works:', exe)
  process.exit(1)
}

// Every shortcut needs the same AppUserModelID the app sets in src/main/index.ts, or
// Windows identifies the pin by exe path and the window by app id, and draws two
// taskbar buttons for one app.
step('Tagging shortcuts with the app id')
const setAumid = join(root, 'scripts', 'set-aumid.ps1')
for (const lnk of all) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setAumid, '-Lnk', lnk, '-Id', APP_ID],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) console.error(`Could not tag ${lnk} - it may open as a second taskbar item.`)
}

// Admin mode pins a scheduled task to one exe path, and every build lands in a new
// dist folder, so the task would keep launching the build that is about to be
// deleted. Re-point it here rather than making the user re-toggle the switch.
const taskExists =
  spawnSync('schtasks', ['/Query', '/TN', 'PaneForge'], { stdio: 'ignore' }).status === 0
if (taskExists) {
  step('Re-pointing the admin launch task at the new build')
  const register = `
$action = New-ScheduledTaskAction -Execute '${exe.replace(/'/g, "''")}' -WorkingDirectory '${dirname(exe).replace(/'/g, "''")}'
$principal = New-ScheduledTaskPrincipal -UserId '${(process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + process.env.USERNAME}' -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'PaneForge' -Action $action -Principal $principal -Settings $settings -Force | Out-Null`
  const encoded = Buffer.from(register, 'utf16le').toString('base64')
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}'); exit $p.ExitCode`
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) {
    console.error('Could not update the task. Toggle admin mode off and on in Settings to fix it.')
  }
  // Shortcuts must keep pointing at the hidden launcher, not the exe, or the next
  // launch would be a normal-rights one.
  const vbs = join(process.env.LOCALAPPDATA ?? '', 'PaneForge', 'launch-admin.vbs')
  if (existsSync(vbs)) {
    const relink = all
      .map(
        (lnk) => `
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"${vbs}"'
$s.IconLocation = '${exe},0'
$s.Save()`
      )
      .join('\n')
    spawnSync('powershell', ['-NoProfile', '-Command', relink], { stdio: 'inherit' })
  }
}

step('Pruning old builds')
const dist = join(root, 'dist')
for (const name of readdirSync(dist, { withFileTypes: true })) {
  if (!name.isDirectory() || name.name === `b${stamp}`) continue
  try {
    rmSync(join(dist, name.name), { recursive: true, force: true })
    console.log(`removed ${name.name}`)
  } catch {
    // The build a running instance was started from stays locked. Harmless: the next
    // run prunes it once that instance has been closed.
    console.log(`kept ${name.name} (in use)`)
  }
}

const running = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process PaneForge -ErrorAction SilentlyContinue).Count'], {
  encoding: 'utf8'
})
const isRunning = Number((running.stdout ?? '0').trim()) > 0

step('Done')
console.log(`PaneForge is installed.
  exe        ${exe}
  shortcuts  ${all.join('\n             ')}
${
  isRunning
    ? '\nAn older PaneForge is still running and keeps its own files. Close it and open it\nagain (taskbar, Desktop or Start Menu) to get this build.'
    : '\nOpen it from the taskbar, Desktop or Start Menu. Press F1 inside the app for shortcuts.'
}`)
