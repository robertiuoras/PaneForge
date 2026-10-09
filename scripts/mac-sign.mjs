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
//
// ## Why it signs with a certificate now, and not ad-hoc
//
// Ad-hoc makes the app RUN. What it does not do is let macOS remember a permission.
//
// TCC - the thing that asks "PaneForge would like to access your Documents folder" -
// stores each grant against the app's *designated requirement*, not against its path. A
// signature with no certificate has nothing stable to name the app by, so codesign falls
// back to the cdhash of the binary, and the grant reads `cdhash H"ec87a5..."`. Every
// build changes that hash. This repo cuts a patch release whenever a chat finishes, the
// app auto-updates, and so every release re-asked for Documents, Desktop, Downloads,
// iCloud Drive, the local network and Apple Events, from zero. That is not a bug anyone
// can fix in the app: no entitlement, no Info.plist string and no amount of
// `xattr -d com.apple.quarantine` changes what TCC decided to key the grant on.
//
// Signing with ANY certificate - it does not have to be Apple's - changes the designated
// requirement to:
//
//   identifier "com.robert.paneforge" and certificate root = H"<the cert>"
//
// which has no cdhash in it and therefore survives every rebuild. The permissions are
// asked once. A self-signed root is enough for that, and costs nothing; what it does NOT
// buy is Gatekeeper, which still wants an Apple-notarised app, so `scripts/install.sh`
// and the update path keep clearing quarantine exactly as before.
//
// The identity does not need to be TRUSTED to sign with - `find-identity -v` hides it and
// codesign uses it anyway. That is deliberate here: trusting a root is a keychain
// authorisation dialog, and CI has no one to click it.
//
// `PF_SIGN_IDENTITY` names the identity (default `PaneForge Self-Signed`). When no such
// identity exists in the keychain - a fresh checkout, someone else's Mac, a fork's CI -
// the build falls back to ad-hoc with a warning rather than failing, because an app that
// re-asks for permissions still beats no app at all.
// `scripts/mac-cert.mjs` creates the identity and prints what CI needs.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** The keychain file `mac-cert.mjs` puts the identity in (CI's temp one first), or null. */
function signingKeychain() {
  return (
    process.env.PF_KEYCHAIN ||
    [
      join(tmpdir(), 'pf-signing.keychain-db'),
      join(homedir(), 'Library/Keychains/paneforge-signing.keychain-db')
    ].find((p) => existsSync(p)) ||
    null
  )
}

const security = (args) =>
  execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The signing identity as `{ name, keychain, locked }`, or null when there is none and we
 * must go ad-hoc. `keychain` is the file it was found in (null = the user's keychain search
 * list), and codesign must be handed it with `--keychain` (`signBundle`). `locked` = that
 * file would not unlock with the empty password, so codesign would ask for the password in
 * a dialog (`signProbe` refuses it).
 *
 * The keychain FILE is searched first, not only the search list: on 2026-10-09 the Mac's
 * list no longer named paneforge-signing (another project's `security list-keychains -s`
 * had replaced it), so `find-identity` found nothing, the identity read as missing and
 * install-engine re-signed the installed app ad-hoc - its designated requirement became a
 * cdhash and every macOS permission it held was lost until it was re-signed by hand.
 * `run` is for the test, which cannot rewrite a real search list.
 */
export function findSigningIdentity({ run = security, keychain = signingKeychain() } = {}) {
  const name = process.env.PF_SIGN_IDENTITY || 'PaneForge Self-Signed'
  // `mac-cert.mjs` cannot reliably turn a new keychain's 300-second auto-lock off - doing
  // that needs the Security agent, and a shell with no GUI session cannot answer it. An
  // Electron build is longer than 300 seconds, so by the time afterPack runs the keychain
  // created at the start of the job may well have relocked, and codesign would report
  // `errSecInternalComponent` - which says nothing about keychains. Unlocking here costs
  // milliseconds and happens a moment before the signature, so the timeout cannot expire
  // in between.
  // From a chat's shell the Mac's paneforge-signing keychain does NOT unlock this way while
  // the same command over ssh does (2026-10-10 12:05am Sat), and a codesign on a locked
  // keychain starts SecurityAgent: a password dialog on Robert's screen (2026-10-01), or
  // errSecInternalComponent while the screen is locked.
  let locked = false
  if (keychain) {
    try {
      run(['unlock-keychain', '-p', '', keychain])
    } catch {
      locked = true
    }
  }
  for (const file of keychain ? [keychain, null] : [null]) {
    try {
      // Not `-v`: a self-signed root is untrusted, so `-v` filters it out - while codesign
      // signs with it perfectly well. Matching on the quoted name avoids picking up another
      // project's certificate that happens to sit in the same keychain.
      const out = run(['find-identity', '-p', 'codesigning', ...(file ? [file] : [])])
      if (out.includes(`"${name}"`)) return { name, keychain: file, locked: file ? locked : false }
    } catch {
      /* not in this one */
    }
  }
  return null
}

/**
 * Why re-signing an installed app with `found` (or ad-hoc, when null) must not happen, or
 * null when it may. An app whose designated requirement names a certificate keeps its
 * macOS permissions only while it stays signed by that certificate; ad-hoc turns the
 * requirement into a cdhash and loses them all (2026-10-09, install-engine). An ad-hoc app
 * re-signed ad-hoc loses nothing it had.
 */
export function resignRefusal(designated, found) {
  if (found || !designated || /cdhash/.test(designated)) return null
  return (
    `the installed app is signed with a certificate (${designated}) and no signing ` +
    `identity was found (${signingKeychain() ?? 'no signing keychain file'}, then the ` +
    'keychain search list); re-signing it ad-hoc would make macOS forget every permission it holds.'
  )
}

/** codesign's arguments that pick `found` (null = ad-hoc). */
export function identityArgs(found) {
  return found ? [...(found.keychain ? ['--keychain', found.keychain] : []), '--sign', found.name] : ['--sign', '-']
}

/**
 * Why codesign cannot sign as `found` from this process, or null when it can: a test-sign
 * of a scratch copy of a system binary. A chat's shell gets errSecInternalComponent for
 * this key while the same command over ssh signs (2026-10-10 12:10am Sat), and a real
 * re-sign that fails that way has already broken the bundle's old seal. Bounded, so a
 * keychain prompt nobody answers cannot hang a build.
 */
export function signProbe(found) {
  // Never handed to codesign at all: that is what would open the dialog.
  if (found?.locked) return `${found.keychain} does not unlock without its password here, and codesign would ask for it in a dialog`
  const dir = mkdtempSync(join(tmpdir(), 'pf-sign-probe-'))
  try {
    copyFileSync('/usr/bin/true', join(dir, 'probe'))
    const r = spawnSync('codesign', ['--force', ...identityArgs(found), '--timestamp=none', join(dir, 'probe')], { encoding: 'utf8', timeout: 30_000 })
    if (r.status === 0) return null
    return (r.error?.message ?? r.stderr ?? '').trim().split('\n').pop() || `codesign exited ${r.status}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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

/**
 * Sign every nested item and then the bundle. `identity` is a keychain identity name, or
 * `-` for ad-hoc; `keychain` is the file `findSigningIdentity` found it in.
 */
export function signBundle(app, identity = '-', keychain = null) {
  const targets = [...nested(app), app]
  for (const target of targets) {
    execFileSync(
      'codesign',
      [
        '--force',
        ...identityArgs(identity === '-' ? null : { name: identity, keychain }),
        // Without this a re-sign keeps the stale entitlements blob from Electron's own
        // signature, and the outer app then disagrees with its helpers.
        '--preserve-metadata=entitlements',
        // No timestamp: the Apple timestamp server is a network call on every one of the
        // ~8 nested items, and it is only meaningful for a certificate that can expire in
        // a way anyone checks. A self-signed root is not that.
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

/** Back-compat alias: the ad-hoc case, which is still the fallback. */
export function signAdHoc(app) {
  return signBundle(app, '-')
}

/**
 * The bundle's designated requirement. This is the string TCC keys its permission grants
 * on, so it is the one output worth reading: a `cdhash` in it means the grants die on the
 * next release.
 */
export function designatedRequirement(app) {
  const out = execFileSync('codesign', ['-d', '-r-', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // `# designated =>` on some macOS versions, bare `designated =>` on others, and reading
  // it wrongly is silent: the check for a cdhash then passes on every bundle because the
  // string is empty.
  const line = out.split('\n').find((l) => l.includes('designated =>'))
  return line ? line.slice(line.indexOf('designated =>') + 'designated =>'.length).trim() : ''
}

/** electron-builder calls this with the packed app's context. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(app)) throw new Error(`afterPack: no bundle at ${app}`)

  let found = findSigningIdentity()
  const cannot = found && signProbe(found)
  if (cannot) {
    // A release has to carry the certificate: every installed Mac copy's permissions hang
    // on it. Only a local build falls back to ad-hoc.
    if (process.env.CI) throw new Error(`afterPack: found "${found.name}" but codesign cannot use it (${cannot}).`)
    console.log(`  ! found "${found.name}" but codesign cannot use it here (${cannot}); signing ad-hoc.`)
    found = null
  }
  const identity = found?.name ?? null
  const n = signBundle(app, identity ?? '-', found?.keychain)

  if (identity) {
    console.log(`  • signed ${n} nested items in ${app} as "${identity}"`)
    const dr = designatedRequirement(app)
    console.log(`  • designated requirement: ${dr}`)
    // The whole point of the certificate. A cdhash here means the identity was not used
    // and every macOS permission will be asked again on the next release, which is a
    // silent regression - the app runs, it just nags forever. Fail the build instead.
    if (/cdhash/.test(dr))
      throw new Error(
        `afterPack: signed with "${identity}" but the designated requirement is still ` +
          `cdhash-based (${dr}). macOS permissions would reset on every update.`
      )
  } else {
    console.log(`  • ad-hoc signed ${n} nested items in ${app}`)
    console.log(
      '  ! no signing identity: macOS will re-ask for every permission after each update.'
    )
    console.log('  ! run `node scripts/mac-cert.mjs` to create one.')
  }
}
