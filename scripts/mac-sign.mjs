// Ad-hoc sign the macOS bundle, as electron-builder's `afterPack`.
//
// This is the fix for "PaneForge is damaged and can't be opened. You should move it to
// the Trash."
//
// The build sets `mac.identity: null`, which tells electron-builder to skip code signing
// entirely - the right call without a paid Apple developer account. What it does NOT do is
// leave the app unsigned in a way Apple Silicon tolerates. Electron ships ad-hoc signed,
// and packaging rewrites `Info.plist`, renames the executable and adds `app.asar`, which
// invalidates that signature rather than removing it. arm64 macOS refuses to execute a
// binary whose signature is present and does not verify, and the words it uses for that
// are "is damaged" - which reads like a corrupt download, so the answer everyone tries is
// to download it again.
//
// Clearing the quarantine flag (`scripts/install.sh`, and the update path in
// `src/main/macUpdate.ts`) does not help: quarantine is Gatekeeper, this is the kernel
// refusing to run the code. Re-signing ad-hoc is what fixes it, and it needs no
// certificate, no Apple account and no network.
//
// Signed bottom up, not with `--deep`. `--deep` is documented by Apple as "for emergency
// repairs and temporary adjustments only", and on an Electron bundle it silently skips
// nested code it does not recognise - which produces an app that launches until the first
// helper is spawned. Frameworks and helper apps first, the outer bundle last, is the order
// the signature nesting actually requires.
//
// Runs only on darwin. On Windows and Linux it returns immediately, so `dist:win` is
// unaffected.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every nested bundle inside the app, deepest first. */
function nested(app) {
  const out = []
  const frameworks = join(app, 'Contents', 'Frameworks')
  if (existsSync(frameworks)) {
    for (const name of readdirSync(frameworks)) {
      const path = join(frameworks, name)
      if (name.endsWith('.framework')) {
        // Versions/A/<name> is the code; the framework wrapper is signed after it.
        const versions = join(path, 'Versions')
        if (existsSync(versions))
          for (const v of readdirSync(versions)) if (v !== 'Current') out.push(join(versions, v))
        out.push(path)
      } else if (name.endsWith('.app') || name.endsWith('.dylib') || name.endsWith('.node')) {
        out.push(path)
      }
    }
  }
  return out
}

export function signAdHoc(app) {
  const targets = [...nested(app), app]
  for (const target of targets) {
    execFileSync(
      'codesign',
      [
        '--force',
        '--sign',
        '-',
        // Without this a re-sign keeps the stale entitlements blob from Electron's own
        // signature, and the outer app then disagrees with its helpers.
        '--preserve-metadata=entitlements',
        '--timestamp=none',
        target
      ],
      { stdio: 'inherit' }
    )
  }
  // Prove it before shipping it. `codesign --verify --deep --strict` is the same check
  // the kernel makes on launch, so a bundle that passes here is one that opens.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  return targets.length
}

/** electron-builder calls this with the packed app's context. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(app)) throw new Error(`afterPack: no bundle at ${app}`)
  const n = signAdHoc(app)
  console.log(`  • ad-hoc signed ${n} nested items in ${app}`)
}
