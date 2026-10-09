// install-engine.mjs puts master's WHOLE shipped script set into an installed app.
//
// 2026-10-09: a hand refresh of the installed engine copied lane.mjs and its imports and
// left lane-hook.mjs at the 3 Oct build, which never tells the engine a chat was cleared;
// the /clear fix on master could not run and a dirty lane was stranded (lane-strand-test G).
// Pinned here, against a real git repo in the temp folder and a plain folder as the "app":
//   - every file package.json ships is installed, the hook included, byte for byte
//   - from master: a dirty working tree or another branch checked out never leaks in
//   - what was replaced is kept in a backup; a second run changes nothing
//   - `--check` exits 1 naming the files that differ, 0 once they match
//   - a shipped file missing on master installs nothing at all
//   - with a remote, origin/master (fetched) is the source, not a lagging local master
//
//   node scripts/install-engine-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-install-engine-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const SHIPPED = ['lane.mjs', 'lane-hook.mjs', 'lane-peers.mjs']
const repo = join(root, 'repo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
copyFileSync(join(here, 'install-engine.mjs'), join(repo, 'scripts', 'install-engine.mjs'))
const pkg = (filter) => JSON.stringify({ name: 'x', build: { extraResources: [{ from: 'scripts', to: 'scripts', filter }] } }, null, 2) + '\n'
writeFileSync(join(repo, 'package.json'), pkg(SHIPPED))
for (const f of SHIPPED) writeFileSync(join(repo, 'scripts', f), `// ${f} on master\n`)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'master')

// The installed app: an old engine and an old hook, as on the Mac at 9:16am 9 Oct.
const app = join(root, 'app-scripts')
mkdirSync(app)
for (const f of SHIPPED) writeFileSync(join(app, f), `// ${f} from the 3 Oct build\n`)
writeFileSync(join(app, 'pf-ctl.mjs'), '// not shipped by this package.json - left alone\n')

// A lane's half-done edits: on another branch, and uncommitted on top.
git(repo, 'checkout', '-q', '-b', 'lane-a')
writeFileSync(join(repo, 'scripts', 'lane.mjs'), '// lane-a commit, not on master\n')
git(repo, 'commit', '-qam', 'lane a')
writeFileSync(join(repo, 'scripts', 'lane-hook.mjs'), '// uncommitted edit\n')

const run = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(repo, 'scripts', 'install-engine.mjs'), '--scripts', app, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const masterBytes = (f) => execFileSync('git', ['show', `master:scripts/${f}`], { cwd: repo })

const before = run('--check')
ok('--check exits 1 while the install is behind', before.code === 1, before.out)
ok('and names the hook among the files that differ', /lane-hook\.mjs/.test(before.out), before.out)

const first = run()
ok('an install exits 0', first.code === 0, first.out)
ok('every shipped file, the hook included, now matches master byte for byte', SHIPPED.every((f) => readFileSync(join(app, f)).equals(masterBytes(f))), SHIPPED.map((f) => `${f}: ${readFileSync(join(app, f), 'utf8').trim()}`).join('\n'))
ok('the lane branch commit and the uncommitted edit did not leak in', !/lane-a commit|uncommitted/.test(SHIPPED.map((f) => readFileSync(join(app, f), 'utf8')).join('')))
ok('a file the package does not ship is left alone', readFileSync(join(app, 'pf-ctl.mjs'), 'utf8').includes('left alone'))
const backups = readdirSync(app).filter((n) => n.startsWith('.engine-backup-'))
ok('what it replaced is kept in one backup folder', backups.length === 1 && SHIPPED.every((f) => readFileSync(join(app, backups[0], f), 'utf8').includes('3 Oct build')), backups.join(', '))
ok('no half-written temp file is left behind', !readdirSync(app).some((n) => n.endsWith('.installing')))

const after = run('--check')
ok('--check exits 0 once it matches', after.code === 0, after.out)
const again = run()
ok('a second install changes nothing and makes no second backup', again.code === 0 && /Already current/.test(again.out) && readdirSync(app).filter((n) => n.startsWith('.engine-backup-')).length === 1, again.out)

// A shipped file master does not have: nothing at all is installed.
git(repo, 'checkout', '-q', '-f', 'master')
writeFileSync(join(repo, 'package.json'), pkg([...SHIPPED, 'gone.mjs']))
writeFileSync(join(repo, 'scripts', 'lane.mjs'), '// newer lane.mjs on master\n')
git(repo, 'commit', '-qam', 'ships a file that does not exist')
const half = run()
ok('a shipped file missing on master refuses the install', half.code !== 0 && /gone\.mjs/.test(half.out), half.out)
ok('and nothing was written', readFileSync(join(app, 'lane.mjs'), 'utf8').includes('on master') && !readFileSync(join(app, 'lane.mjs'), 'utf8').includes('newer') && !existsSync(join(app, 'gone.mjs')))

// With a remote, what was pushed wins over a local master that has not caught up (the PC).
const remote = join(root, 'remote.git')
git(root, 'init', '-q', '--bare', '-b', 'master', remote)
git(repo, 'checkout', '-q', '-f', 'HEAD~1')
git(repo, 'branch', '-f', 'master', 'HEAD')
git(repo, 'checkout', '-q', 'master')
git(repo, 'remote', 'add', 'origin', remote)
git(repo, 'push', '-q', 'origin', 'master')
const pushed = join(root, 'pusher')
git(root, 'clone', '-q', remote, pushed)
git(pushed, 'config', 'user.email', 'test@example.com')
git(pushed, 'config', 'user.name', 'test')
writeFileSync(join(pushed, 'scripts', 'lane-hook.mjs'), '// lane-hook.mjs pushed from the other desk\n')
git(pushed, 'commit', '-qam', 'pushed')
git(pushed, 'push', '-q', 'origin', 'master')
const fromOrigin = run()
ok('with a remote it installs origin/master, fetched, not the lagging local master', fromOrigin.code === 0 && readFileSync(join(app, 'lane-hook.mjs'), 'utf8').includes('other desk') && /origin\/master/.test(fromOrigin.out), fromOrigin.out)

// Re-signing the installed Mac app (mac-sign.mjs, pure parts: they run on any machine).
// 2026-10-09 11:59pm Fri: the Mac's keychain search list no longer named
// paneforge-signing.keychain-db, `find-identity` over the list found no identity, and the
// install re-signed PaneForge Classic ad-hoc - requirement cdhash, every permission lost.
// The two outputs below are that Mac's real ones (hashes masked).
const { findSigningIdentity, resignRefusal, signProbe } = await import('./mac-sign.mjs')
const KEYCHAIN = '/Users/x/Library/Keychains/paneforge-signing.keychain-db'
const LIST_OUT = `Policy: Code Signing
  Matching identities
  1) <HASH> "Jarvis Self Signed"
  2) <HASH> "Apple Development: robertiuoras@gmail.com (834ZJ9P3NT)"
  3) <HASH> "hexpolish-signing" (CSSMERR_TP_NOT_TRUSTED)
     3 identities found

  Valid identities only
  1) <HASH> "Jarvis Self Signed"
  2) <HASH> "Apple Development: robertiuoras@gmail.com (834ZJ9P3NT)"
     2 valid identities found
`
const FILE_OUT = `Policy: Code Signing
  Matching identities
  1) <HASH> "PaneForge Self-Signed" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`
const security = (byFile, unlocks = true) => (args) => {
  if (args[0] === 'unlock-keychain') {
    if (unlocks) return ''
    throw new Error('security: SecKeychainUnlock: The user name or passphrase you entered is not correct.')
  }
  if (args[0] !== 'find-identity') throw new Error(`unexpected security ${args.join(' ')}`)
  return args[3] ? byFile[args[3]] ?? '' : LIST_OUT
}
const off = findSigningIdentity({ run: security({ [KEYCHAIN]: FILE_OUT }), keychain: KEYCHAIN })
ok('an identity in the signing keychain is found when the search list does not name that keychain', off?.name === 'PaneForge Self-Signed' && off?.keychain === KEYCHAIN, JSON.stringify(off))
// 2026-10-10 12:03-12:11am Sat: from a chat's shell that keychain does not unlock with the
// empty password (over ssh it does), and every codesign then started SecurityAgent for its
// password - a dialog on Robert's screen (the 2026-10-01 popups) whenever it is not locked.
// A keychain that did not unlock is never handed to codesign, not even for the probe.
ok('a keychain that unlocks is not marked locked', off?.locked === false, JSON.stringify(off))
const shut = findSigningIdentity({ run: security({ [KEYCHAIN]: FILE_OUT }, false), keychain: KEYCHAIN })
ok('a keychain that will not unlock is marked locked', shut?.name === 'PaneForge Self-Signed' && shut?.locked === true, JSON.stringify(shut))
const why = shut && signProbe(shut)
ok('and the probe refuses it without running codesign (no password dialog)', /dialog/.test(why ?? ''), why)
const onList = findSigningIdentity({ run: security({}), keychain: null })
ok('no keychain file and none on the list = no identity (ad-hoc)', onList === null, JSON.stringify(onList))
const CERT = 'identifier "com.robert.paneforge" and certificate root = H"49f54a6617076f14e216b0a5512477dd7d861b38"'
ok('a certificate-signed app with no identity found is refused, naming the permissions', /forget every permission/.test(resignRefusal(CERT, null) ?? ''), resignRefusal(CERT, null))
ok('with the identity found it may be re-signed', resignRefusal(CERT, off) === null)
ok('an ad-hoc app may be re-signed ad-hoc: it has no permissions to lose', resignRefusal('cdhash H"6d664b576b52804d768a200d525ab377265bfe0a"', null) === null)

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
