// Open the working copy as a SECOND PaneForge, beside the one you are sitting in:
//   npm run try            build, then launch it as the `dev` profile, minimized
//   npm run try -- --keep  skip the build and just launch what is already in out/
//   npm run try -- --show  put the window on screen (still without taking focus)
//
// Minimized is the DEFAULT, not an option. This is normally run by an agent working in
// the live app: a test window that paints itself over what you are reading interrupts you
// even when it politely leaves the keyboard alone, and most launches are only there for a
// build check or a probe. It is on the taskbar the whole time - click it when you want it.
//
// The window never takes focus either way.
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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
// --minimized/-m still accepted, and now redundant: --show is the way to see the window.
const minimized = !args.includes('--show')
const close = args.includes('--close')

// `npm run try -- --close` shuts the test copy without touching the live app. Lane
// release calls the same thing, so this is only for closing one by hand mid-session.
if (close) {
  closeTestApps(root)
  console.log('Test copy closed. Your live app is untouched.')
  process.exit(0)
}

// Each checkout gets its own profile, so two agents working in two worktrees never
// land on the same one. They would not crash - the second launch would just raise the
// first window and exit on the single-instance lock - but it looks exactly like "my
// change did not apply", which is a bad hour. `claude-orchestrator-twin` -> `dev-twin`.
// Both names of the checkout are stripped: the repo is PaneForge, and the folder is
// renamed to match by scripts/rename-repo.mjs - which waits for a moment when no chat is
// sitting in any of the four directories, because Windows will not rename a folder that
// a running process has as its working directory.
function defaultProfile() {
  const suffix = basename(root).replace(/^(claude-orchestrator|paneforge)-?/i, '')
  return suffix ? `dev-${suffix}` : 'dev'
}
const profile = (args.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? defaultProfile()).trim()

// Anything this script does not use is Electron's. The one that matters is
// --remote-debugging-port=<n>: with it, a change to how a pane handles the mouse or lays
// itself out can be checked against the real window instead of a screenshot of it.
const passThrough = args.filter(
  (a) => !['--keep', '--minimized', '-m', '--show', '--close'].includes(a) && !a.startsWith('--profile=')
)

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
// A copy left over from an earlier run holds this profile's single-instance lock, so the
// new launch would raise the OLD window - running OLD code - and exit. That reads as "my
// change did not apply". Close it first; only this checkout's Electron is matched.
closeTestApps(root)
// Detached: the test app must outlive this command, and the agent pane that ran it
// must not sit there attached to its output waiting for it to exit.
//
// No windowsHide here, however tempting it looks. It puts SW_HIDE in the child's
// STARTUPINFO, and Windows applies that to the process's FIRST ShowWindow call - so
// the app starts, loads, calls win.show(), and stays invisible forever. Verified:
// the window existed with the right title and IsWindowVisible was false. electron.exe
// is a GUI-subsystem binary, so there is no console to hide anyway.
spawn(electron, ['.', ...(minimized ? ['--minimized'] : []), ...passThrough], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, PANEFORGE_PROFILE: profile }
}).unref()

console.log(`A second PaneForge is opening, marked "${profile}" next to the version number.
${
  minimized
    ? 'It stays minimized and silent - click it in the taskbar when you want it (--show opens it).'
    : 'It will not take focus: keep typing where you are, it just appears behind.'
}
Your live app is untouched: separate settings, separate workspaces, separate panes.
Close the test window when you are done - nothing to clean up.`)
