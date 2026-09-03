// Open the working copy as a SECOND PaneForge, beside the one you are sitting in:
//   npm run try            build, then launch it as the `dev` profile, minimized
//   npm run try -- --keep  skip the build and just launch what is already in out/
//   npm run try -- --pull  fast-forward this checkout to origin first, then build and launch -
//                          the way a change merged from the OTHER machine is tested here
//                          (Robert 2026-09-04: no release until it was tried in a dev window,
//                          on the PC and on the Mac)
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
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devProfile } from './dev-profile.mjs'
import { closeTestApps, waitTestAppsGone } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
// --minimized/-m still accepted, and now redundant: --show is the way to see the window.
const minimized = !args.includes('--show')
const close = args.includes('--close')
const clipboardTest = args.includes('--clipboard-test')
const pull = args.includes('--pull')

// `npm run try -- --close` shuts the test copy without touching the live app. Lane
// release calls the same thing, so this is only for closing one by hand mid-session.
if (close) {
  closeTestApps(root)
  console.log('Test copy closed. Your live app is untouched.')
  process.exit(0)
}

// ONE dev copy per machine, whatever checkout launches it - a second window is a second
// taskbar button and a second set of panes for the same screen, and Robert asked for one
// (2026-08-23). The risk that used to buy the per-checkout profile - a launch raising
// somebody else's window and exiting on the single-instance lock, which reads exactly
// like "my change did not apply" - is paid by closeTestApps above instead: it closes the
// dev copy whatever checkout started it, so a launch always ends with THIS build in the
// one window. Last launcher wins.
// The naming itself is in scripts/dev-profile.mjs, so the probes that have to FIND this
// copy's settings folder cannot drift from the script that launches it. `--profile=x`
// still overrides it for a test that genuinely needs a second, throwaway profile.
const profile = (args.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? devProfile(root)).trim()

// Anything this script does not use is Electron's. The one that matters is
// --remote-debugging-port=<n>: with it, a change to how a pane handles the mouse or lays
// itself out can be checked against the real window instead of a screenshot of it.
const passThrough = args.filter(
  (a) => !['--keep', '--minimized', '-m', '--show', '--close', '--clipboard-test', '--pull'].includes(a) && !a.startsWith('--profile=')
)

// A UI copy test must never replace the user's real clipboard, including non-text
// formats. Make one owner-only fixture and hand it only to this detached test copy.
let clipboardEnv = {}
if (clipboardTest) {
  const dir = mkdtempSync(join(tmpdir(), 'paneforge-clipboard-test-'))
  chmodSync(dir, 0o700)
  const file = join(dir, 'clipboard.txt')
  closeSync(openSync(file, 'wx', 0o600))
  clipboardEnv = { PF_TEST_CLIPBOARD_DIR: dir, PF_TEST_CLIPBOARD_FILE: file }
}

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

// `--keep` skips the build, and a missing build is then indistinguishable from a working
// one: Electron's `loadFile` on an absent index.html lands on `chrome-error://chromewebdata/`
// and paints an EMPTY WINDOW, with `window shown` in the log and no error anywhere. That is
// "the dev copy isn't loading", and it survives every relaunch because `--keep` never looks.
// So the page the launch depends on is checked, and a build that is not there is built
// whatever was asked for - being loud costs a few seconds, being blank costs an hour.
if (pull) {
  // A dirty checkout is never pulled over: the point is to test what MASTER holds, and a
  // half-edited file would make the window show neither that nor the edit.
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (dirty.status !== 0 || dirty.stdout.trim()) {
    console.error('== --pull refused: this checkout has uncommitted changes. Commit them or drop --pull.')
    process.exit(1)
  }
  // origin's trunk by name: a lane worktree's branch has no upstream, and a bare pull there
  // only prints how to set one. Trunk is what a test is FOR.
  const trunk = (spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, encoding: 'utf8' }).stdout || 'origin/master').trim().replace('origin/', '')
  console.log(`== Pulling origin/${trunk} (fast-forward only)`)
  const p = spawnSync('git', ['pull', '--ff-only', 'origin', trunk], { cwd: root, stdio: 'inherit' })
  if (p.status !== 0) {
    console.error('== --pull failed: this branch does not fast-forward onto origin. Merge first.')
    process.exit(p.status ?? 1)
  }
  const head = spawnSync('git', ['log', '-1', '--format=%h %s'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  console.log(`== Testing ${head}`)
}
const page = join(root, 'out', 'renderer', 'index.html')
if (pull || !keep || !existsSync(page)) {
  if (keep) console.log('== out/renderer/index.html is missing - building anyway (--keep would open a blank window)')
  else console.log('== Building')
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
  if (!existsSync(page)) {
    console.error('Build finished but out/renderer/index.html is still missing - refusing to open a blank window.')
    process.exit(1)
  }
}

console.log(`== Launching the ${profile} copy`)
// A copy left over from an earlier run holds this profile's single-instance lock, so the
// new launch would raise the OLD window - running OLD code - and exit. That reads as "my
// change did not apply". Close it first; only this checkout's Electron is matched.
closeTestApps(root)
// And wait for it to be gone rather than only asked to go: the lock outlives the ask by a
// moment, and a launch into that moment exits silently with no window and no message.
if (!(await waitTestAppsGone(root)))
  console.log('(the previous test copy is taking its time closing - launching anyway)')
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
  env: { ...process.env, ...clipboardEnv, PANEFORGE_PROFILE: profile }
}).unref()

const dockOrTaskbar = process.platform === 'darwin' ? 'Dock' : 'taskbar'
console.log(`A second PaneForge is opening, marked "${profile}" next to the version number.
${
  minimized
    ? process.platform === 'darwin'
      ? `No window appears at all - not even for the moment it takes to minimize one. Click its
${dockOrTaskbar} icon when you want it (--show opens it on screen instead).`
      : 'It stays minimized and silent - click it in the taskbar when you want it (--show opens it).'
    : 'It will not take focus: keep typing where you are, it just appears behind.'
}
Your live app is untouched: separate settings, separate workspaces, separate panes.
With a game running it opens no window at all - not even a taskbar button - and appears
once the game closes, because showing one is enough to take a fullscreen game off screen.
Close the test window when you are done - nothing to clean up.`)

// Two copies on screen at once is a comparison, and Robert arranges that comparison the
// same way every time: both on the external monitor, installed app on the left half, this
// copy on the right. `--show` is the only mode where somebody is doing that, and
// `scripts/dev-layout.mjs` refuses on a single screen, so this costs nothing on the road.
// After a beat, because a window that does not exist yet cannot be placed.
if (!minimized) {
  setTimeout(() => {
    const r = spawnSync(process.execPath, [new URL('dev-layout.mjs', import.meta.url).pathname], {
      encoding: 'utf8'
    })
    if (r.stdout) process.stdout.write(r.stdout)
  }, 2500).unref?.()
}
