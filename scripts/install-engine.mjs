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
// with it; and codesign run from a chat's shell cannot use this key (signProbe), after it
// has already broken the old seal.
const app = /^(.*\.app)\/Contents\/Resources\/scripts\/?$/.exec(target)?.[1]
let sign = null
if (process.platform === 'darwin' && app) {
  const mac = await import('./mac-sign.mjs')
  const found = mac.findSigningIdentity()
  // Only "not signed at all" means there is nothing to keep. Anything else unreadable (a
  // seal an earlier run broke, a codesign whose output reads differently) could still be a
  // certificate app, and guessing "unsigned" there is how it would end up ad-hoc.
  let designated = ''
  let unreadable = null
  try {
    designated = mac.designatedRequirement(app)
    if (!designated) unreadable = 'no designated requirement in codesign -d -r- output'
  } catch (e) {
    if (!/not signed at all/.test(String(e.stderr ?? ''))) unreadable = String(e.stderr ?? e.message).trim()
  }
  const cannot = !unreadable && found && mac.signProbe(found)
  const refusal = unreadable
    ? `cannot read the signature of ${app} (${unreadable})`
    : mac.resignRefusal(designated, found) ?? (cannot && `codesign cannot sign as "${found.name}" from this shell (${cannot}). Run it from a Terminal or over ssh`)
  if (refusal) {
    console.error(`Nothing was installed: ${refusal}.`)
    process.exit(2)
  }
  // What a re-sign rewrites, kept outside the bundle so any failure can be undone whole:
  // the main executable (its signature is embedded) and CodeResources.
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))?.[1]
  if (!exe || !existsSync(join(app, 'Contents', 'MacOS', exe))) {
    console.error(`Nothing was installed: cannot find the main executable of ${app} in its Info.plist, so a failed re-sign could not be undone.`)
    process.exit(2)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'pf-install-engine-'))
  const sealed = [join('Contents', 'MacOS', exe), join('Contents', '_CodeSignature', 'CodeResources')].map((f, i) => ({ f, copy: join(scratch, `sealed-${i}`), had: existsSync(join(app, f)) }))
  try {
    for (const { f, copy, had } of sealed) if (had) copyFileSync(join(app, f), copy)
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true })
    console.error(`Nothing was installed: could not keep a copy of ${app}'s signature files (${e.message}).`)
    process.exit(2)
  }
  sign = { mac, found, designated, scratch, sealed }
}

const backup = join(target, `.engine-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
try {
  mkdirSync(backup)
  for (const { name } of differs) if (existsSync(join(target, name))) copyFileSync(join(target, name), join(backup, name))
} catch (e) {
  rmSync(backup, { recursive: true, force: true })
  if (sign) rmSync(sign.scratch, { recursive: true, force: true })
  console.error(`Nothing was installed: could not back up what is there (${e.message}).`)
  process.exit(2)
}

// Written through a rename so a file in use (the running app, a hook starting) is replaced
// whole, never truncated in place. A temp file a failure leaves is removed with it.
const tempOf = (to) => `${to}.installing`
const put = (from, to) => {
  try {
    copyFileSync(from, tempOf(to))
    renameSync(tempOf(to), to)
  } catch (e) {
    rmSync(tempOf(to), { force: true })
    throw e
  }
}

// Old scripts and, on a Mac, the old signature files back, so the old seal is whole again.
function rollBack(why) {
  const left = []
  for (const { name } of differs) {
    try {
      if (existsSync(join(backup, name))) put(join(backup, name), join(target, name))
      else rmSync(join(target, name), { force: true })
    } catch {
      left.push(name)
    }
  }
  if (!left.length) rmSync(backup, { recursive: true, force: true })
  let whole = true
  if (sign) {
    for (const { f, copy, had } of sign.sealed) {
      try {
        if (had) put(copy, join(app, f))
        else rmSync(join(app, f), { force: true })
      } catch {
        left.push(f)
      }
    }
    // An app that had no signature gets none back: the re-sign made its _CodeSignature.
    if (!sign.designated) rmSync(join(app, 'Contents', '_CodeSignature'), { recursive: true, force: true })
    else whole = spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0
    if (whole && !left.length) rmSync(sign.scratch, { recursive: true, force: true })
  }
  console.error(
    `${why} The install was rolled back` +
      (left.length ? `, except ${left.join(', ')} (old copies in ${backup}${sign ? ` and ${sign.scratch}` : ''})` : '') +
      (!sign ? '.' : !sign.designated ? '; it is unsigned again, as it was.' : whole ? '; its old signature verifies again.' : `; it STILL DOES NOT VERIFY (old signature files in ${sign.scratch}).`)
  )
  process.exit(1)
}

try {
  for (const { name, bytes } of differs) {
    const to = join(target, name)
    try {
      writeFileSync(tempOf(to), bytes)
      renameSync(tempOf(to), to)
    } catch (e) {
      rmSync(tempOf(to), { force: true })
      throw e
    }
  }
} catch (e) {
  rollBack(`Writing the new scripts failed (${e.message}).`)
}
const wrong = files.filter(({ name, bytes }) => !readFileSync(join(target, name)).equals(bytes))
if (wrong.length) rollBack(`Read back wrong: ${wrong.map((f) => f.name).join(', ')}.`)

if (sign) {
  const label = sign.found?.name ?? '-'
  try {
    execFileSync('codesign', ['--force', ...sign.mac.identityArgs(sign.found), '--preserve-metadata=entitlements', '--timestamp=none', app], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  } catch {
    rollBack(`Re-signing ${app} as "${label}" failed.`)
  }
  // The requirement is what macOS keys every permission on: the same certificate gives the
  // same requirement, so a change here would be a permission reset.
  let after = ''
  try {
    after = sign.mac.designatedRequirement(app)
  } catch (e) {
    rollBack(`Re-signed ${app} as "${label}", but its signature cannot be read back (${String(e.stderr ?? e.message).trim()}).`)
  }
  if (sign.designated && !/cdhash/.test(sign.designated) && after !== sign.designated) {
    rollBack(`Re-signed ${app} as "${label}", but its designated requirement changed (${sign.designated} -> ${after}), which would make macOS ask for its permissions again.`)
  }
  rmSync(sign.scratch, { recursive: true, force: true })
  console.log(`Installed ${differs.length} of ${files.length} files from ${master}: ${differs.map((f) => f.name).join(', ')}.`)
  console.log(`Backup of what was there: ${backup}`)
  console.log(`Re-signed ${app} as "${label}"; codesign --verify --deep --strict passes; designated requirement: ${after}`)
} else {
  console.log(`Installed ${differs.length} of ${files.length} files from ${master}: ${differs.map((f) => f.name).join(', ')}.`)
  console.log(`Backup of what was there: ${backup}`)
}
