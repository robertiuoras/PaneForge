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
// the same list a release packs - read from `master` (never the working tree: a lane's
// half-done edit must not reach every chat on the machine), keeps a backup of what it
// replaces, writes each file through a rename so a hook starting mid-copy reads a whole
// file, reads every byte back, and on macOS re-signs the bundle (changed resources break
// its seal) with the identity a release signs with, so the permissions macOS granted stay.
//
//   node scripts/install-engine.mjs            # this machine's installed app
//   node scripts/install-engine.mjs --check    # exit 1 and name each file that differs
//   node scripts/install-engine.mjs --scripts <dir>   # another install (tests, the PC path)

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
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

const show = (path) => execFileSync('git', ['show', `master:${path}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

const target = arg('--scripts') ?? installedScripts()
if (!target || !existsSync(target)) {
  console.error(`No installed app scripts folder at ${target ?? '(none on this platform)'}.`)
  process.exit(2)
}

const pkg = JSON.parse(show('package.json').toString('utf8'))
const names = (pkg.build?.extraResources ?? []).find((r) => r.from === 'scripts')?.filter ?? []
if (!names.length) {
  console.error('master package.json ships no scripts (build.extraResources).')
  process.exit(2)
}
// Everything read before anything is written: a file missing on master stops the lot, so an
// install is never half old, half new.
const files = names.map((name) => {
  try {
    return { name, bytes: show(`scripts/${name}`) }
  } catch {
    console.error(`master has no scripts/${name}; nothing was installed.`)
    process.exit(2)
  }
})
const master = execFileSync('git', ['rev-parse', '--short', 'master'], { cwd: repo, encoding: 'utf8' }).trim()

const differs = files.filter(({ name, bytes }) => {
  const p = join(target, name)
  return !existsSync(p) || !readFileSync(p).equals(bytes)
})

if (argv.includes('--check')) {
  if (!differs.length) console.log(`installed scripts match master ${master} (${files.length} files) in ${target}`)
  else console.log(`installed scripts differ from master ${master}: ${differs.map((f) => f.name).join(', ')} (${target})`)
  process.exit(differs.length ? 1 : 0)
}

if (!differs.length) {
  console.log(`Already current: ${files.length} files match master ${master} in ${target}.`)
  process.exit(0)
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
console.log(`Installed ${differs.length} of ${files.length} files from master ${master}: ${differs.map((f) => f.name).join(', ')}.`)
console.log(`Backup of what was there: ${backup}`)

// The scripts sit inside the signed bundle, so the seal no longer matches. Re-sign the
// outer bundle only (nothing nested changed) with the release identity, then verify.
const app = /^(.*\.app)\/Contents\/Resources\/scripts\/?$/.exec(target)?.[1]
if (process.platform === 'darwin' && app) {
  const { signingIdentity } = await import('./mac-sign.mjs')
  const identity = signingIdentity() ?? '-'
  execFileSync('codesign', ['--force', '--sign', identity, '--preserve-metadata=entitlements', '--timestamp=none', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`Re-signed ${app} as "${identity}"; codesign --verify --deep --strict passes.`)
}
