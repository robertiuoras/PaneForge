// A macOS app launched through Finder or `open` starts with only the system PATH.
// PaneForge still has to find CLIs users already installed into their normal user bins.

import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'node_modules', '.pf-test')
mkdirSync(out, { recursive: true })
const built = join(out, 'which-gui-path.mjs')
buildSync({ entryPoints: [join(root, 'src/main/which.ts')], outfile: built, bundle: true, format: 'esm', platform: 'node' })
const { which } = await import(`${pathToFileURL(built).href}?${Date.now()}`)

let failed = 0
const check = (condition, label) => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failed++
    console.log(`  FAIL ${label}`)
  }
}

const originalPath = process.env.PATH
process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

// These are the two actual CLI locations on this Mac. Their existence keeps this a
// real GUI-launch regression check, not a mocked path parser test.
if (process.platform === 'darwin' && existsSync(join(process.env.HOME, '.local/bin/claude'))) {
  check(which('claude') === join(process.env.HOME, '.local/bin/claude'), 'finds Claude from a minimal GUI PATH')
}
if (process.platform === 'darwin' && existsSync('/opt/homebrew/bin/codex')) {
  check(which('codex') === '/opt/homebrew/bin/codex', 'finds Homebrew Codex from a minimal GUI PATH')
}

process.env.PATH = originalPath
rmSync(out, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nGUI path resolution passes')
process.exit(failed ? 1 : 0)
