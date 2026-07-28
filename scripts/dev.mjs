// `npm run dev` - electron-vite with hot reload, opened the way `npm run try` opens.
//
//   npm run dev              build + watch, window minimized and silent
//   npm run dev -- --show    same, with the window on screen (still takes no focus)
//
// Why this wrapper exists: `electron-vite dev` on its own launched with no profile and
// no start mode. That resolved to the `dev` profile - shared by every checkout, so two
// lanes fought over one single-instance lock - and to start mode `inactive`, which
// paints a full window over whatever you are reading. Neither is what an agent running
// a build check in the live app wants, and this is developed from a session inside that
// app. Same defaults as `npm run try`: own profile, out of sight, no focus taken.
//
// The profile is derived from the folder, so `PaneForge-a` is `dev-a` and never lands
// on the copy `PaneForge-b` is running. Anything already in the environment wins, so
// PANEFORGE_PROFILE=x npm run dev still works.

import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const show = args.includes('--show')

function defaultProfile() {
  const suffix = basename(root).replace(/^(claude-orchestrator|paneforge)-?/i, '')
  return suffix ? `dev-${suffix}` : 'dev'
}

const env = {
  ...process.env,
  PANEFORGE_PROFILE: process.env.PANEFORGE_PROFILE || defaultProfile(),
  PANEFORGE_START: process.env.PANEFORGE_START || (show ? 'inactive' : 'minimized')
}

console.log(
  `== electron-vite dev, profile "${env.PANEFORGE_PROFILE}", start "${env.PANEFORGE_START}"` +
    (show ? '' : ' (click it in the taskbar, or --show to open it)')
)

const child = spawn('npx', ['electron-vite', 'dev', ...args.filter((a) => a !== '--show')], {
  cwd: root,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})
child.on('exit', (code) => process.exit(code ?? 0))
