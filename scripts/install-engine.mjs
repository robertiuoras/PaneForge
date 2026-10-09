// Put master's lane engine AND hooks into an installed app, all of them at once.
//
// Claude Code's lane hooks run the INSTALLED copy (`~/.claude/settings.json` points at
// `<app>/Resources/scripts/lane-hook.mjs`, which runs its sibling `lane.mjs`), so a fix on
// master changes nothing until that folder changes. Without a release the only way in was
// a hand copy, and on 2026-10-09 (5:02pm Fri) one copied lane.mjs and the files it imports
// and left lane-hook.mjs at the 3 Oct build. That hook never passes `--cleared` on /clear,
// so the engine's keep-the-dirty-lane fix (4178a080) could never run: the same morning a
// /clear in taskdriver.ai dropped a dirty lane a, the pane's next chat was sent to lane b
// and two recovery chats were spent on work already on main (lane-strand-test section G).
//
// So this copies the WHOLE shipped set - package.json `build.extraResources` for scripts,
// the same list a release packs - read from `origin/master` (never the working tree: a lane's
// half-done edit must not reach every chat on the machine), keeps a backup of what it
// replaces, writes each file through a rename so a hook starting mid-copy reads a whole
// file, reads every byte back, and on macOS re-signs the bundle (changed resources break
// its seal) with the identity a release signs with, so the permissions macOS granted stay.
//
//   node scripts/install-engine.mjs            # this machine's installed app
//   node scripts/install-engine.mjs --check    # exit 1 and name each file that differs
//   node scripts/install-engine.mjs --scripts <dir>   # another install (tests, the PC path)

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function installedScripts() {
  if (process.platform === 'darwin') return '/Applications/PaneForge Classic.app/Contents/Resources/scripts'
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'claude-orchestrator', 'resources', 'scripts')
  return null
}

// What was pushed, not what this checkout's own `master` last saw: on the PC the repo's local
// master lags origin until somebody there merges. No remote (tests, a fresh clone) = master.
const gitOk = (...args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim()
  } catch {
    return null
  }
}
if (gitOk('remote', 'get-url', 'origin')) gitOk('fetch', '-q', 'origin', 'master')
const source = gitOk('rev-parse', '--verify', '-q', 'refs/remotes/origin/master') ? 'origin/master' : 'master'
const show = (path) => execFileSync('git', ['show', `${source}:${path}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

const target = arg('--scripts') ?? installedScripts()
if (!target || !existsSync(target)) {
  console.error(`No installed app scripts folder at ${target ?? '(none on this platform)'}.`)
  process.exit(2)
}

const pkg = JSON.parse(show('package.json').toString('utf8'))
const names = (pkg.build?.extraResources ?? []).find((r) => r.from === 'scripts')?.filter ?? []
if (!names.length) {
  console.error(`${source} package.json ships no scripts (build.extraResources).`)
  process.exit(2)
}
// Everything read before anything is written: a file missing on master stops the lot, so an
// install is never half old, half new.
const files = names.map((name) => {
  try {
    return { name, bytes: show(`scripts/${name}`) }
  } catch {
    console.error(`${source} has no scripts/${name}; nothing was installed.`)
    process.exit(2)
  }
})
const master = `${source} ${gitOk('rev-parse', '--short', source)}`

const differs = files.filter(({ name, bytes }) => {
  const p = join(target, name)
  return !existsSync(p) || !readFileSync(p).equals(bytes)
})

if (argv.includes('--check')) {
  if (!differs.length) console.log(`installed scripts match ${master} (${files.length} files) in ${target}`)
  else console.log(`installed scripts differ from ${master}: ${differs.map((f) => f.name).join(', ')} (${target})`)
  process.exit(differs.length ? 1 : 0)
}

if (!differs.length) {
  console.log(`Already current: ${files.length} files match ${master} in ${target}.`)
  process.exit(0)
}

// The scripts sit inside the signed bundle, so the seal will no longer match and the outer
// bundle is re-signed (nothing nested changes) with the release identity. Whether that can
// work is settled BEFORE anything is written: on 2026-10-09 (11:59pm Fri) no identity was
// found, the install went ahead, re-signed the app ad-hoc and its macOS permissions went
// with it; and codesign run from a chat's shell answers errSecInternalComponent for this
// key (the same command over ssh signs), after it has already broken the old seal.
const app = /^(.*\.app)\/Contents\/Resources\/scripts\/?$/.exec(target)?.[1]
let sign = null
if (process.platform === 'darwin' && app) {
  const { designatedRequirement, findSigningIdentity, resignRefusal } = await import('./mac-sign.mjs')
  const found = findSigningIdentity()
  let designated = ''
  try {
    designated = designatedRequirement(app)
  } catch {
    /* not signed at all: nothing to keep, an ad-hoc signature is an improvement */
  }
  const refusal = resignRefusal(designated, found)
  if (refusal) {
    console.error(`Nothing was installed: ${refusal}`)
    process.exit(2)
  }
  const args = found ? [...(found.keychain ? ['--keychain', found.keychain] : []), '--sign', found.name] : ['--sign', '-']
  const scratch = mkdtempSync(join(tmpdir(), 'pf-install-engine-'))
  if (found) {
    copyFileSync('/usr/bin/true', join(scratch, 'probe'))
    const probe = spawnSync('codesign', ['--force', ...args, '--timestamp=none', join(scratch, 'probe')], { encoding: 'utf8' })
    if (probe.status !== 0) {
      rmSync(scratch, { recursive: true, force: true })
      console.error(`Nothing was installed: codesign cannot sign as "${found.name}" from this shell (${probe.stderr.trim()}). Run it from a Terminal or over ssh.`)
      process.exit(2)
    }
  }
  // What a re-sign rewrites, kept outside the bundle so a failed one can be undone whole.
  const exe = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8').match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
  const sealed = [exe && join('Contents', 'MacOS', exe), join('Contents', '_CodeSignature', 'CodeResources')].filter((f) => f && existsSync(join(app, f)))
  sealed.forEach((f, i) => copyFileSync(join(app, f), join(scratch, `sealed-${i}`)))
  sign = { args, label: found?.name ?? '-', designated, designatedRequirement, scratch, sealed }
}

const backup = join(target, `.engine-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(backup)
for (const { name } of differs) if (existsSync(join(target, name))) copyFileSync(join(target, name), join(backup, name))
for (const { name, bytes } of differs) {
  const tmp = join(target, `.${name}.installing`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, join(target, name))
}
const wrong = files.filter(({ name, bytes }) => !readFileSync(join(target, name)).equals(bytes))
if (wrong.length) {
  console.error(`Read back wrong: ${wrong.map((f) => f.name).join(', ')}. The replaced files are in ${backup}.`)
  process.exit(1)
}
console.log(`Installed ${differs.length} of ${files.length} files from ${master}: ${differs.map((f) => f.name).join(', ')}.`)
console.log(`Backup of what was there: ${backup}`)

if (sign) {
  try {
    execFileSync('codesign', ['--force', ...sign.args, '--preserve-metadata=entitlements', '--timestamp=none', app], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  } catch {
    // Old scripts and the old signature back, byte for byte, so the old seal is whole again.
    for (const { name } of differs) {
      if (existsSync(join(backup, name))) copyFileSync(join(backup, name), join(target, name))
      else rmSync(join(target, name), { force: true })
    }
    rmSync(backup, { recursive: true, force: true })
    sign.sealed.forEach((f, i) => copyFileSync(join(sign.scratch, `sealed-${i}`), join(app, f)))
    const whole = spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0
    if (whole) rmSync(sign.scratch, { recursive: true, force: true })
    console.error(
      `Re-signing ${app} as "${sign.label}" failed, so the install was rolled back ` +
        `(${whole ? 'its old signature verifies again' : `and it STILL DOES NOT VERIFY; its old signature files are in ${sign.scratch}`}).`
    )
    process.exit(1)
  }
  rmSync(sign.scratch, { recursive: true, force: true })
  // The requirement is what macOS keys every permission on: the same certificate gives the
  // same requirement, so a change here is a permission reset and has to be said.
  const after = sign.designatedRequirement(app)
  if (sign.designated && !/cdhash/.test(sign.designated) && after !== sign.designated) {
    console.error(`Re-signed ${app} as "${sign.label}", but its designated requirement changed: ${sign.designated} -> ${after}. macOS will ask for its permissions again.`)
    process.exit(1)
  }
  console.log(`Re-signed ${app} as "${sign.label}"; codesign --verify --deep --strict passes; designated requirement: ${after}`)
}
