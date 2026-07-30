// A launch nobody asked to see must put nothing on the screen.
//
//   npm run test:quiet            build, then launch a throwaway copy and check it
//   npm run test:quiet -- --keep  skip the build and use whatever is in out/
//
// `npm run try` is run dozens of times a day by an agent working inside the live app, so
// what it does to the screen is the thing developing PaneForge feels most often. On
// Windows a quiet launch is `showInactive()` then `minimize()`: the window has to exist
// on screen once or the taskbar button will not restore it. Doing the same on macOS was
// the bug - `orderFront` then `miniaturize` is a window appearing over your work and
// genie-animating into the Dock, every single launch, which reads as the app grabbing
// the screen even though the keyboard never moved. On darwin the window is now simply
// never shown, and the Dock icon (always there for a running app) is the way in.
//
// Two halves:
//   1. revealPlan() - the decision, per platform, checked without launching anything.
//   2. A real Electron copy, launched the way `npm run try` launches one, checked from
//      its own log for what it did with the window - and then asked to reveal itself, so
//      "never shown" cannot be passed by a window that can never come back.

import { spawn, spawnSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeTestApps, waitTestAppsGone } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const PORT = 9414
const PROFILE = 'quiet-probe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures++
}

// ------------------------------------------------------------------ 1. the decision
//
// profile.ts imports electron, which does not exist outside the app - so the one function
// under test is bundled out of it against a stub `electron` and loaded on its own.
// revealPlan touches none of it; the stub is only there so the module can be evaluated.
// (esbuild's binary is not a JS shim on macOS: buildSync, never `node esbuild`.)
const bundle = join(root, 'node_modules', '.cache', 'quiet-launch-revealplan.mjs')
mkdirSync(dirname(bundle), { recursive: true })
writeFileSync(
  join(dirname(bundle), 'quiet-launch-entry.ts'),
  `export { revealPlan } from ${JSON.stringify(join(root, 'src/main/profile.ts'))}\n`
)
const electronStub = join(dirname(bundle), 'quiet-launch-electron-stub.mjs')
writeFileSync(
  electronStub,
  `export const app = { getPath: () => '', setPath: () => {}, getName: () => '', setAppUserModelId: () => {} }\n` +
    `export default { app }\n`
)
buildSync({
  entryPoints: [join(dirname(bundle), 'quiet-launch-entry.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { electron: electronStub }
})
const { revealPlan } = await import(pathToFileURL(bundle).href)

check('mac: a quiet launch shows nothing', revealPlan('minimized', 'darwin') === 'hidden')
check(
  'windows: a quiet launch still shows-then-minimizes (taskbar restore needs it)',
  revealPlan('minimized', 'win32') === 'minimized'
)
check('linux: same as windows', revealPlan('minimized', 'linux') === 'minimized')
for (const p of ['darwin', 'win32']) {
  check(`${p}: --show puts it on screen without the keyboard`, revealPlan('inactive', p) === 'inactive')
  check(`${p}: a double-clicked app opens normally`, revealPlan('normal', p) === 'active')
}

// ------------------------------------------------------------------ 2. the real thing

/** Where this profile's updater.log lands - the app's own record of what it showed. */
function profileLog() {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(base, `claude-orchestrator-${PROFILE}`, 'updater.log')
}

function freshProfile() {
  const dir = dirname(profileLog())
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover copy still holding a file - the config below is what matters */
  }
  mkdirSync(dir, { recursive: true })
  // The real profile's saved desk is not something a test should reopen.
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ restoreAfterRestart: 'never', grid: false, notifyOnIdle: false }, null, 2)
  )
}

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  } catch {
    return []
  }
}

async function page(match) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const t = (await targets()).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && match(t.url ?? '')
    )
    if (t) return t
    await sleep(300)
  }
  throw new Error('no debuggable window - did the copy start?')
}

async function evaluator(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  await new Promise((res) => ws.addEventListener('open', res, { once: true }))
  return {
    async run(expression) {
      const id = ++seq
      const done = new Promise((res) => pending.set(id, res))
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
      return (await done).result?.result?.value
    },
    close: () => ws.close()
  }
}

if (!keep) {
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
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

closeTestApps(root)
await waitTestAppsGone(root)
freshProfile()

const child = spawn(electron, ['.', '--minimized', `--remote-debugging-port=${PORT}`], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, PANEFORGE_PROFILE: PROFILE }
})
child.unref()

let ev
try {
  const main = await page((u) => /index\.html/.test(u) && !/shelf/.test(u))
  ev = await evaluator(main)
  // The reveal happens on ready-to-show, which is after the renderer exists.
  await sleep(2500)

  const log = existsSync(profileLog()) ? readFileSync(profileLog(), 'utf8') : ''
  if (process.platform === 'darwin') {
    check('mac: the launch says it kept the window off screen', /held off screen/.test(log), log.trim().split('\n').pop() ?? '')
    check('mac: nothing was ever shown', !/window shown/.test(log))
  } else {
    check('windows: the window was shown and minimized', /window shown \(minimized\)/.test(log))
  }
  check('the window is not on screen', (await ev.run('window.api.appVisibleNow()')) === false)

  // ... and it can still be got at. This is the half that stops "never shown" being
  // satisfied by a copy with no way back: the same call the Stash's button makes.
  const shelf = await page((u) => /shelf/.test(u))
  const shelfEv = await evaluator(shelf)
  await shelfEv.run('window.shelf.focusApp()')
  shelfEv.close()
  let visible = false
  for (let i = 0; i < 20 && !visible; i++) {
    await sleep(250)
    visible = (await ev.run('window.api.appVisibleNow()')) === true
  }
  check('asking for the app puts the window on screen', visible)
} finally {
  ev?.close()
  closeTestApps(root)
  await waitTestAppsGone(root)
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
