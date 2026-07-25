// One command to go from a fresh clone to a working desktop app:
//   npm run setup
// Installs deps if needed, builds the packaged exe, then points a Desktop and Start
// Menu shortcut at it. Safe to re-run after any source change - it rebuilds in place,
// so the existing shortcut keeps working without being recreated.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exe = join(root, 'dist', 'win-unpacked', 'PaneForge.exe')

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

// electron-builder wipes dist/win-unpacked, which fails with "Access is denied" while
// the app is open - so close it first instead of making that the user's problem.
if (process.platform === 'win32') {
  step('Closing PaneForge if it is running')
  spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process PaneForge -ErrorAction SilentlyContinue | Stop-Process -Force"], {
    stdio: 'ignore'
  })
}

step('Building the app')
run('npm', ['run', 'package'])

if (!existsSync(exe)) {
  console.error(`\nBuild finished but ${exe} is missing. Nothing to link.`)
  process.exit(1)
}

if (process.platform !== 'win32') {
  step('Done')
  console.log(`Built: ${exe}\n(Shortcut creation is Windows-only.)`)
  process.exit(0)
}

step('Creating shortcuts')
const startMenu = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
mkdirSync(startMenu, { recursive: true })
const targets = [join(homedir(), 'Desktop', 'PaneForge.lnk'), join(startMenu, 'PaneForge.lnk')]

// WScript.Shell is the only dependency-free way to write a .lnk on Windows.
const ps = targets
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

step('Done')
console.log(`PaneForge is installed.
  exe        ${exe}
  shortcuts  ${targets.join('\n             ')}

Open it from the Desktop or the Start Menu. Press F1 inside the app for shortcuts.`)
