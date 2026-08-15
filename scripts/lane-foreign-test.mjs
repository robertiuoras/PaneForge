// Regression test: a folder at a lane's path that is a checkout of a DIFFERENT repository.
//
// The bug this exists for (taskdriver.ai, 2026-08-15): `taskdriver.ai-c` was not a worktree
// but a full separate CLONE of the same remote, sitting on a branch called `lane-c`. The
// only test was `rev-parse --is-inside-work-tree`, which answers "is this a git checkout",
// so the clone answered yes and the engine adopted it as lane c. Nothing errored and
// nothing said anything - but every ref decision (aheadOf, drainLane, the ready-mark check,
// shippable) reads THIS repo's refs while the commits were going into the other clone's
// object database, so the lane could never have anything to release, for ever. doctor
// printed it as an ordinary held lane, and the debris scan skips lane paths by design.
//
// The load-bearing half of this file is the CONTROL: it asserts the clone really does pass
// the old predicate. Without that, this test could pass by never having reproduced anything.
//
//   node scripts/lane-foreign-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-foreign-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const lane = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const laneOf = (id) => JSON.parse(lane('status').out).lanes.find((l) => l.lane === id)

// ------------------------------------------------------------------ a real lane, for contrast

// The first chat in a repo is given `main` - the repository itself, no worktree cut. It
// takes a second chat to get a letter lane, which is the thing being contrasted here: a
// real worktree at a `<repo>-<letter>` path.
const solo = lane('claim', '--session', 'sess-solo')
ok('the first chat claims a lane', solo.ok, solo.err)
const mine = lane('claim', '--session', 'sess-a')
ok('a second chat claims another', mine.ok, mine.err)
const realLane = mine.ok ? JSON.parse(mine.out).lane : null
ok('and it is a letter lane, so a real worktree was cut for it', realLane && realLane !== 'main', String(realLane))

// ------------------------------------------------------------------ a clone squats on lane b

const bDir = join(root, 'demo-b')
git(root, 'clone', '-q', repo, bDir)
git(bDir, 'config', 'user.email', 'test@example.com')
git(bDir, 'config', 'user.name', 'test')
git(bDir, 'checkout', '-q', '-b', 'lane-b')
writeFileSync(join(bDir, 'feature.js'), 'export const x = 1\n')
git(bDir, 'add', '-A')
git(bDir, 'commit', '-qm', 'work nobody will ever see')

// THE CONTROL. If this ever stops being true the clone is no longer reproducing the bug,
// and every assertion below would pass for the wrong reason.
ok(
  'the clone passes the old predicate - it really is "inside a work tree"',
  git(bDir, 'rev-parse', '--is-inside-work-tree') === 'true'
)
ok(
  'and its object database is a different one from the repo it squats beside',
  git(bDir, 'rev-parse', '--absolute-git-dir') !== git(repo, 'rev-parse', '--absolute-git-dir')
)

// ------------------------------------------------------------------ it is named, not adopted

const b = laneOf('b')
ok('the lane path is reported as existing', b.exists === true, JSON.stringify(b))
ok('and as NOT a checkout of this repository', b.broken === true, JSON.stringify(b))
ok('while the real lane beside it is not flagged', laneOf(realLane).broken === false, JSON.stringify(laneOf(realLane)))
ok(
  'the clone commit is not counted as work this repo could release',
  b.ahead === 0 && b.dirty === false,
  `ahead=${b.ahead} dirty=${b.dirty}`
)

const doc = lane('doctor').out
ok('doctor says so in words', /NOT a worktree of this repo/.test(doc), doc.split('\n').slice(0, 12).join('\n'))

// ------------------------------------------------------------------ and a chat sent there is refused by name

const squatter = lane('claim', '--session', 'sess-b', '--prefer', 'b')
const said = `${squatter.out}\n${squatter.err ?? ''}`
ok(
  'a chat handed that lane is refused with the reason, rather than given the clone',
  !squatter.ok || !/"lane":\s*"b"/.test(squatter.out),
  said.slice(0, 400)
)
if (!squatter.ok) ok('and the refusal names it as a separate clone', /separate clone/.test(said), said.slice(0, 400))

// ------------------------------------------------------------------ nothing was deleted

ok('the clone is left exactly where it was - never guessed at', git(bDir, 'log', '-1', '--format=%s') === 'work nobody will ever see')

console.log(failed ? `\n${failed} failed` : '\nall foreign-lane checks passed')
process.exit(failed ? 1 : 0)
