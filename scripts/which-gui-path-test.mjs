// A macOS app launched through Finder or `open` starts with only the system PATH.
// PaneForge still has to find CLIs users already installed into their normal user bins.

import { buildSync } from 'esbuild'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalAppData = process.env.APPDATA
const fixtureHome = join(out, 'gui-path-home')
const fixtureAppData = join(out, 'gui-path-appdata')
process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin:/usr/sbin:/sbin'
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome
process.env.APPDATA = fixtureAppData

if (process.platform === 'win32') {
  const npmBin = join(fixtureAppData, 'npm')
  const localBin = join(fixtureHome, '.local', 'bin')
  mkdirSync(npmBin, { recursive: true })
  mkdirSync(localBin, { recursive: true })
  writeFileSync(join(npmBin, 'pf-gui-npm.cmd'), '@exit /b 0\r\n')
  writeFileSync(join(localBin, 'pf-gui-local.cmd'), '@exit /b 0\r\n')
  check(which('pf-gui-npm') === join(npmBin, 'pf-gui-npm.cmd'), 'finds npm-global CLI from a minimal GUI PATH')
  check(which('pf-gui-local') === join(localBin, 'pf-gui-local.cmd'), 'finds user-local CLI from a minimal GUI PATH')
} else {
  const localBin = join(fixtureHome, '.local', 'bin')
  const npmBin = join(fixtureHome, '.npm-global', 'bin')
  mkdirSync(localBin, { recursive: true })
  mkdirSync(npmBin, { recursive: true })
  for (const [dir, name] of [[localBin, 'pf-gui-local'], [npmBin, 'pf-gui-npm']]) {
    const file = join(dir, name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  check(which('pf-gui-local') === join(localBin, 'pf-gui-local'), 'finds user-local CLI from a minimal GUI PATH')
  check(which('pf-gui-npm') === join(npmBin, 'pf-gui-npm'), 'finds npm-global CLI from a minimal GUI PATH')
}

process.env.PATH = originalPath
if (originalHome === undefined) delete process.env.HOME
else process.env.HOME = originalHome
if (originalUserProfile === undefined) delete process.env.USERPROFILE
else process.env.USERPROFILE = originalUserProfile
if (originalAppData === undefined) delete process.env.APPDATA
else process.env.APPDATA = originalAppData
rmSync(out, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nGUI path resolution passes')
process.exit(failed ? 1 : 0)
