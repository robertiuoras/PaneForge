// `npm run dev` - electron-vite with hot reload, opened the way `npm run try` opens.
//
//   npm run dev              build + watch, window minimized and silent
//   npm run dev -- --show    same, with the window on screen (still takes no focus)
//
// Why this wrapper exists: `electron-vite dev` on its own launched with no profile and
// no start mode - and start mode `inactive` paints a full window over whatever you are
// reading. That is not what an agent running a build check in the live app wants, and
// this is developed from a session inside that app. Same defaults as `npm run try`: the
// dev profile, out of sight, no focus taken.
//
// The profile is `dev` for every checkout - one dev window per machine (see
// dev-profile.mjs), so a launch from a lane replaces the window rather than opening a
// second one. Anything already in the environment wins, so PANEFORGE_PROFILE=x npm run
// dev still works for a throwaway second copy.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devProfile } from './dev-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const show = args.includes('--show')

const env = {
  ...process.env,
  PANEFORGE_PROFILE: process.env.PANEFORGE_PROFILE || devProfile(root),
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
