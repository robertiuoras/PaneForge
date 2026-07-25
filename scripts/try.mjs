// Open the working copy as a SECOND PaneForge, beside the one you are sitting in:
//   npm run try            build, then launch it as the `dev` profile
//   npm run try -- --keep  skip the build and just launch what is already in out/
//
// Why this exists: PaneForge is developed from a Claude session running inside
// PaneForge. Testing a change used to mean closing the app that hosts the agent doing
// the work. This starts a separate copy instead - its own profile folder, its own
// single-instance lock, its own taskbar button - so the live app never stops.
//
// It runs the Electron binary out of node_modules rather than a packaged exe on
// purpose. Windows Smart App Control is on for this machine and hard-blocks freshly
// built unsigned PaneForge.exe files; node_modules/electron is already trusted, so
// this path always works. It also skips electron-builder entirely, so it starts in
// seconds instead of a minute.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const profile = (args.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? 'dev').trim()

const electron = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
)
if (!existsSync(electron)) {
  console.error('No Electron in node_modules. Run `npm install` first.')
  process.exit(1)
}

if (!keep) {
  console.log('== Building')
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log(`== Launching the ${profile} copy`)
// Detached: the test app must outlive this command, and the agent pane that ran it
// must not sit there attached to its output waiting for it to exit.
//
// No windowsHide here, however tempting it looks. It puts SW_HIDE in the child's
// STARTUPINFO, and Windows applies that to the process's FIRST ShowWindow call - so
// the app starts, loads, calls win.show(), and stays invisible forever. Verified:
// the window existed with the right title and IsWindowVisible was false. electron.exe
// is a GUI-subsystem binary, so there is no console to hide anyway.
spawn(electron, ['.'], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, PANEFORGE_PROFILE: profile }
}).unref()

console.log(`A second PaneForge is opening, marked "${profile}" next to the version number.
Your live app is untouched: separate settings, separate workspaces, separate panes.
Close the test window when you are done - nothing to clean up.`)
