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

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
