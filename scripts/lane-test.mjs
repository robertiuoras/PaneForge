// Regression test for worktree lanes: the seeding a fresh checkout needs, and the
// one way this feature can damage the folder it was meant to protect.
//
// The first version of the dependency seeding was a directory junction to the repo's
// node_modules. It worked, and then `git worktree remove` (git 2.53, Windows) walked
// into the junction and deleted the real tree out of the original folder - tidying up
// the second session broke the first. Hardlinks replaced it: same bytes, no disk, and
// deleting either copy leaves the other whole. The last three checks here are that
// exact failure, so it cannot come back quietly.
//
// Everything runs against real git repos in the temp folder; nothing is stubbed.
//
//   node scripts/lane-test.mjs

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wanted = join(tmpdir(), 'paneforge-lane-test')
rmSync(wanted, { recursive: true, force: true })
mkdirSync(wanted, { recursive: true })
// realpath, because macOS hands out /var/folders/... while git answers with the
// /private/var it resolves to. Every path assertion below is a string compare, so
// without this four of them failed on a Mac against lanes that were in fact correct.
const root = realpathSync(wanted)

// A lane also links Claude Code's own config folder to the original's. That part
// is covered by lane-memory-test.mjs against a throwaway HOME; here it is simply
// pointed away from the real one, so a run of this file cannot touch it.
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.USERPROFILE = root
process.env.HOME = root

// lanes.ts is TypeScript and imports nothing but node builtins, so a one-file
// bundle is enough to exercise it outside Electron.
const bundle = join(root, 'lanes.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'main', 'lanes.ts')],
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { resolveLane } = await import(`file:///${bundle.replace(/\\/g, '/')}`)

let failed = 0
const ok = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}
const waitFor = async (path, ms = 60000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

const repo = join(root, 'demo')
mkdirSync(join(repo, 'backend'), { recursive: true })
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.env\n.env.local\nbackend/.env\n.claude/\n')
writeFileSync(join(repo, 'backend', 'keep.txt'), 'x\n')
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'init')

// The things a fresh checkout cannot have, because git does not track them.
writeFileSync(join(repo, '.env'), 'SECRET=1\n')
writeFileSync(join(repo, '.env.local'), 'L=1\n')
writeFileSync(join(repo, 'backend', '.env'), 'B=1\n')
mkdirSync(join(repo, '.claude'), { recursive: true })
writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"perm":1}\n')
mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true })
writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
mkdirSync(join(repo, 'backend', 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(repo, 'backend', 'node_modules', 'dep', 'index.js'), '2\n')

ok('a folder nobody else holds is left alone', (await resolveLane(repo, [])).cwd === repo)

const laneA = join(root, 'demo-a')
const lane = (await resolveLane(repo, [repo]))
ok('a second session in the same folder gets lane a', lane.cwd === laneA && lane.lane === 'a')
ok('the lane is a checkout of the repo', existsSync(join(laneA, 'app.js')))
ok('.env is seeded', readFileSync(join(laneA, '.env'), 'utf8') === 'SECRET=1\n')
ok('.env.local is seeded', existsSync(join(laneA, '.env.local')))
ok('a subfolder .env is seeded', existsSync(join(laneA, 'backend', '.env')))
ok('local agent settings are seeded', existsSync(join(laneA, '.claude', 'settings.local.json')))

await waitFor(join(laneA, 'node_modules'))
await waitFor(join(laneA, 'backend', 'node_modules'))
ok('dependencies arrive in the lane', existsSync(join(laneA, 'node_modules', 'left-pad', 'index.js')))
ok(
  'dependencies are hardlinked, not a link to the original folder',
  realpathSync(join(laneA, 'node_modules')) !== realpathSync(join(repo, 'node_modules'))
)
ok(
  'a hardlinked file is the same bytes as the original',
  statSync(join(laneA, 'node_modules', 'left-pad', 'index.js')).ino ===
    statSync(join(repo, 'node_modules', 'left-pad', 'index.js')).ino
)
ok('subfolder dependencies arrive too', existsSync(join(laneA, 'backend', 'node_modules', 'dep', 'index.js')))
ok('no half-built temp folder is left behind', !existsSync(join(laneA, 'node_modules.pf-tmp')))

const laneB = join(root, 'demo-b')
const third = (await resolveLane(repo, [repo, laneA]))
ok('a third session gets its own lane', third.lane === 'b' && third.cwd === laneB)
await waitFor(join(laneB, 'node_modules'))

ok('a lane nobody is in is reused rather than piling up folders', (await resolveLane(repo, [repo])).cwd === laneA)
ok('a lane asked for another lane still branches off the main repo', (await resolveLane(laneA, [laneA])).cwd === join(root, 'demo-b'))

const plain = join(root, 'plain')
mkdirSync(plain, { recursive: true })
const shared = (await resolveLane(plain, [plain]))
ok('a folder that is not a repo is shared with a warning', shared.cwd === plain && Boolean(shared.note))

// The junction failure, in the two shapes that hit it.
const realDep = join(repo, 'node_modules', 'left-pad', 'index.js')
const subDep = join(repo, 'backend', 'node_modules', 'dep', 'index.js')
git(repo, 'worktree', 'remove', '--force', laneA)
ok('git worktree remove leaves the original dependencies alone', existsSync(realDep))
rmSync(laneB, { recursive: true, force: true })
ok('deleting a lane folder leaves the original dependencies alone', existsSync(realDep))
ok('deleting a lane folder leaves subfolder dependencies alone', existsSync(subDep))

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
