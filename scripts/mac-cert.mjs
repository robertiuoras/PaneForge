#!/usr/bin/env node
// The signing identity `scripts/mac-sign.mjs` looks for, and the two ways it gets onto a
// machine: created once here, imported from a secret in CI.
//
// Read the long comment at the top of `mac-sign.mjs` for why a certificate exists at all.
// The short version: without one, macOS keys every permission grant to the binary's hash
// and re-asks for Documents, Desktop, Downloads and iCloud Drive on every single update.
//
//   node scripts/mac-cert.mjs create    # once per developer machine; prints the CI secrets
//   node scripts/mac-cert.mjs import    # CI: PF_CERT_P12 (base64) + PF_CERT_PASSWORD
//   node scripts/mac-cert.mjs status    # is an identity present, and what is its root hash
//
// The certificate is a self-signed CA with `codeSigning` extended key usage, valid for 20
// years. It is not trusted and does not need to be: codesign signs with an untrusted
// identity without complaint, and trusting a root means a keychain authorisation dialog
// that CI has nobody to click. macOS only reads the certificate to build the designated
// requirement, and an untrusted root hashes exactly like a trusted one.
//
// Losing it is not fatal but is not free either: a new certificate is a new root hash, so
// it is one more reset of the permission prompts. Keep the p12 in the repo secrets and
// nowhere else - it is a signing key.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const NAME = process.env.PF_SIGN_IDENTITY || 'PaneForge Self-Signed'

// A keychain of its own, never the login keychain, and with an empty password.
//
// Both halves of that are about the same thing: `errSecInternalComponent`, which is what
// codesign returns when a private key exists but its ACL does not let codesign use it
// without asking a human. The fix is `set-key-partition-list`, and that needs the
// keychain's password - which for the login keychain is Robert's, is not ours to type,
// and in CI does not exist at all. So the key goes somewhere we created and therefore
// know the password of.
//
// The password is empty on purpose rather than random-and-stored-nearby: a random one has
// to be written to disk beside the keychain to survive a reboot, which protects nothing
// and is one more file to lose. What this key can do is make PaneForge builds keep their
// macOS permissions. It is not an Apple identity, it cannot notarise, and a build signed
// with it is still refused by Gatekeeper. The copy that matters lives in the repository
// secrets.
const KEYCHAIN =
  process.env.PF_KEYCHAIN || join(homedir(), 'Library/Keychains/paneforge-signing.keychain-db')

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
}

/**
 * Put a p12 into `keychain`, creating it, unlocking it, authorising codesign against it
 * and putting it on the search list. Shared by `create` and `import` so a developer Mac
 * and the CI runner cannot drift apart in a way only a release would reveal.
 */
function installP12(p12, password, keychain) {
  try {
    run('security', ['delete-keychain', keychain], { stdio: 'ignore' })
  } catch {
    /* not there yet, which is the normal first run */
  }
  run('security', ['create-keychain', '-p', '', keychain])
  run('security', ['unlock-keychain', '-p', '', keychain])
  // A new keychain relocks after 300s and on sleep, and an Electron build is longer than
  // that - so without this the failure lands on the last nested item, minutes in. It is
  // best-effort because `set-keychain-settings` asks the Security agent for authorisation
  // and a shell with no GUI session cannot answer, which arrives as the unhelpful
  // "User canceled the operation". That is survivable: `mac-sign.mjs` unlocks the
  // keychain again immediately before it signs, which is a second away rather than
  // minutes, so the timeout never gets to matter either way.
  try {
    run('security', ['set-keychain-settings', '-t', '0', '-u', keychain], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
  } catch {
    /* relocking is handled at signing time instead */
  }

  run('security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'])
  // codesign is a different process, so the key's ACL must name it. Without this every
  // signature fails with errSecInternalComponent - an error that says nothing about
  // keychains and sends you looking at the certificate instead.
  run('security', [
    'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
    '-s', '-k', '', keychain
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  // Prepend rather than replace: `-s <one>` drops the System keychain from the search
  // list, and every later `security` call in the session then fails to find a root.
  const list = run('security', ['list-keychains', '-d', 'user'])
    .split('\n')
    .map((l) => l.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .filter((k) => k !== keychain)
  run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...list])
}

/** Every identity in the keychain, trusted or not - `-v` hides self-signed ones. */
function identities() {
  try {
    return run('security', ['find-identity', '-p', 'codesigning'])
  } catch {
    return ''
  }
}

function rootHash() {
  const line = identities()
    .split('\n')
    .find((l) => l.includes(`"${NAME}"`))
  return line ? (line.trim().split(/\s+/)[1] ?? '') : ''
}

function create() {
  if (rootHash()) {
    console.log(`"${NAME}" already exists (root ${rootHash()}). Nothing to do.`)
    console.log('Delete it in Keychain Access first if you really want a new one -')
    console.log('a new certificate resets every macOS permission prompt once more.')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'pf-cert-'))
  const password = run('openssl', ['rand', '-hex', '24']).trim()
  try {
    writeFileSync(
      join(dir, 'cert.cnf'),
      [
        '[ req ]',
        'distinguished_name = dn',
        'x509_extensions = ext',
        'prompt = no',
        '',
        '[ dn ]',
        `CN = ${NAME}`,
        'O  = PaneForge',
        'C  = US',
        '',
        '[ ext ]',
        'basicConstraints=critical,CA:true',
        'keyUsage=critical,digitalSignature',
        // Without this codesign refuses the identity outright: it will not sign with a
        // certificate that does not say it is for signing code.
        'extendedKeyUsage=critical,codeSigning',
        'subjectKeyIdentifier=hash',
        ''
      ].join('\n')
    )

    run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'),
      '-days', '7300', '-nodes',
      '-config', join(dir, 'cert.cnf')
    ], { stdio: ['ignore', 'ignore', 'ignore'] })

    // The legacy algorithms are not optional. OpenSSL 3 defaults a p12 to AES-256-CBC
    // with a SHA-256 MAC, and macOS's `security import` cannot read that - it reports
    // "MAC verification failed during PKCS12 import (wrong password?)", which sends you
    // looking for a typo in a password that is correct.
    run('openssl', [
      'pkcs12', '-export',
      '-inkey', join(dir, 'key.pem'),
      '-in', join(dir, 'cert.pem'),
      '-name', NAME,
      '-out', join(dir, 'signing.p12'),
      '-passout', `pass:${password}`,
      '-certpbe', 'PBE-SHA1-3DES',
      '-keypbe', 'PBE-SHA1-3DES',
      '-macalg', 'sha1'
    ], { stdio: ['ignore', 'ignore', 'ignore'] })

    installP12(join(dir, 'signing.p12'), password, KEYCHAIN)

    const p12 = readFileSync(join(dir, 'signing.p12')).toString('base64')
    console.log(`Created "${NAME}" (root ${rootHash()}) in ${KEYCHAIN}`)
    console.log('')
    console.log('Store these two as repository secrets so CI signs with the SAME')
    console.log('certificate - a different one resets the permission prompts again:')
    console.log('')
    console.log(`  gh secret set PF_CERT_PASSWORD --body '${password}'`)
    console.log(`  gh secret set PF_CERT_P12 --body '${p12}'`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function importFromEnv() {
  const b64 = process.env.PF_CERT_P12
  const password = process.env.PF_CERT_PASSWORD
  // Not an error. A fork, or this repo before the secrets exist, should still get a
  // working build - one whose permissions reset per update, which mac-sign says out loud.
  if (!b64 || !password) {
    console.log('PF_CERT_P12/PF_CERT_PASSWORD not set - the build will be ad-hoc signed.')
    return
  }

  // The runner is thrown away after the job, so its keychain may as well live in tmp.
  const keychain = join(tmpdir(), 'pf-signing.keychain-db')
  const dir = mkdtempSync(join(tmpdir(), 'pf-cert-'))
  try {
    const p12 = join(dir, 'signing.p12')
    writeFileSync(p12, Buffer.from(b64, 'base64'))
    installP12(p12, password, keychain)

    // Say it out loud. A job that imported nothing still builds, still goes green and
    // still publishes - it just publishes an app that re-asks for every permission, which
    // nobody would look for in a build log weeks later.
    if (!rootHash()) throw new Error('imported the certificate but no identity appeared')
    console.log(`Imported "${NAME}" (root ${rootHash()}) into ${keychain}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function status() {
  const hash = rootHash()
  if (!hash) {
    console.log(`No "${NAME}" identity. Builds will be ad-hoc signed and macOS will`)
    console.log('re-ask for every permission after each update. Fix: mac-cert.mjs create')
    process.exitCode = 1
    return
  }
  console.log(`"${NAME}" present, root ${hash}`)
}

if (process.platform !== 'darwin') {
  console.log('mac-cert: darwin only, nothing to do.')
} else {
  const cmd = process.argv[2] || 'status'
  if (cmd === 'create') create()
  else if (cmd === 'import') importFromEnv()
  else if (cmd === 'status') status()
  else {
    console.error(`unknown command "${cmd}" - expected create, import or status`)
    process.exitCode = 2
  }
}
