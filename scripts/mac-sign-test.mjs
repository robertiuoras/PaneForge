// Does the ad-hoc signing hook do what "PaneForge is damaged" needs?
//
//   npm run test:macsign
//
// Two halves, because this machine may not be a Mac.
//
// Everywhere: the hook loads, and it is a no-op off darwin - a broken `afterPack` fails
// `dist:win` too, and a Windows release dying on a macOS-only script would be a silly way
// to find that out.
//
// On macOS only: build a bundle shaped like the real one (a framework with a Versions
// chain, a helper .app, a native .node), damage its signature the way electron-builder
// does - rewrite Info.plist after Electron signed it - and check that
//   1. `codesign --verify --deep --strict` FAILS before the hook, which is the exact
//      check the kernel makes on launch and the exact reason macOS says "is damaged", and
//   2. it PASSES after.
// Without step 1 this test would pass against a build that never needed fixing.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
let checks = 0
function ok(what, cond, detail = '') {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

const mod = await import('./mac-sign.mjs')
ok('the hook exports a default function', typeof mod.default === 'function')
ok('and signAdHoc for the test to drive', typeof mod.signAdHoc === 'function')

// A context from a Windows build. It must return without touching anything.
let threw = ''
try {
  await mod.default({ electronPlatformName: 'win32', appOutDir: '/nope', packager: {} })
} catch (e) {
  threw = String(e?.message ?? e)
}
ok('it is a no-op on a Windows build', threw === '', threw)

if (process.platform !== 'darwin') {
  console.log('\n  (the signing half needs a Mac - skipped)')
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

const out = mkdtempSync(join(tmpdir(), 'pf-sign-'))
try {
  // The shape electron-builder produces: an app with a framework (Versions/A), a helper
  // app and a native module beside them.
  const app = join(out, 'PaneForge.app')
  const contents = join(app, 'Contents')
  const macos = join(contents, 'MacOS')
  const fw = join(contents, 'Frameworks', 'Test.framework')
  const helper = join(contents, 'Frameworks', 'PaneForge Helper.app', 'Contents', 'MacOS')
  for (const d of [macos, join(fw, 'Versions', 'A'), helper]) mkdirSync(d, { recursive: true })
  const plist = (id, name) =>
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleName</key><string>${name}</string><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>`
  writeFileSync(join(contents, 'Info.plist'), plist('com.robert.paneforge', 'PaneForge'))
  writeFileSync(join(helper, '..', 'Info.plist'), plist('com.robert.paneforge.helper', 'PaneForge Helper'))
  // Real Mach-O binaries, not empty files: codesign refuses anything else.
  copyFileSync('/bin/echo', join(macos, 'PaneForge'))
  copyFileSync('/bin/echo', join(helper, 'PaneForge Helper'))
  copyFileSync('/usr/lib/libSystem.B.dylib', join(fw, 'Versions', 'A', 'Test'))
  symlinkSync('A', join(fw, 'Versions', 'Current'))
  symlinkSync(join('Versions', 'Current', 'Test'), join(fw, 'Test'))

  const verify = () => spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  // Sign it properly, then break it the way packaging does: edit Info.plist afterwards.
  execFileSync('codesign', ['--force', '--sign', '-', join(macos, 'PaneForge')], { stdio: 'ignore' })
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
  writeFileSync(join(contents, 'Info.plist'), plist('com.robert.paneforge', 'PaneForge') + '\n')
  ok(
    'a bundle edited after signing fails the check macOS makes on launch',
    verify().status !== 0,
    'it verified clean, so this test proves nothing'
  )

  mod.signAdHoc(app)
  const after = verify()
  ok('and passes once the hook has re-signed it', after.status === 0, after.stderr?.trim())
} finally {
  rmSync(out, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
