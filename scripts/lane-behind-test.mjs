// Regression test for "the release refuses because the OTHER machine pushed".
//
// Measured on taskdriver.ai 2026-08-28: lanes a and b finished and marked ready, the last
// merge 192 minutes earlier, and every `autoship` answered
//
//   No release yet: origin will not take a push, releasing would strand:
//    ! [rejected]  main -> main (fetch first)
//
// Nothing was wrong. The PC had pushed three commits to the trunk, this machine had not
// pulled them, and the dry-run push that exists to catch a dead token read a behind-trunk
// as a dead credential. Two machines pushing one trunk means BEHIND is the normal state,
// so the release takes origin's commits itself when doing so is a straight fast-forward.
//
// A genuinely diverged trunk still refuses - that one needs a person - and the last check
// below is the one that must not regress.
//
// Real git repos in the temp folder, a real bare origin, real lane.mjs, no stubs.
//
//   node scripts/lane-behind-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-behind-test')
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

const origin = join(root, 'origin.git')
const repo = join(root, 'demo')
const other = join(root, 'other-machine')
const laneA = join(root, 'demo-a')

git(root, 'init', '-q', '--bare', '-b', 'master', origin)

mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
// `release: "merge"` is taskdriver.ai’s own setting: lanes merge and push, no version cut.
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a'], release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

// The other desk: a clone that pushes to the trunk while this machine is not looking.
git(root, 'clone', '-q', origin, other)
git(other, 'config', 'user.email', 'other@example.com')
git(other, 'config', 'user.name', 'other')
writeFileSync(join(other, 'from-the-pc.js'), 'export const pc = 1\n')
git(other, 'add', '-A')
git(other, 'commit', '-qm', 'feat: written on the other machine')
git(other, 'push', '-q', 'origin', 'master')

// This machine's finished lane.
git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', laneA)
git(laneA, 'config', 'user.email', 'test@example.com')
git(laneA, 'config', 'user.name', 'test')
writeFileSync(join(laneA, 'feature.js'), 'export const f = 1\n')
git(laneA, 'add', '-A')
git(laneA, 'commit', '-qm', 'feat: finished here')

const lane = (...args) => {
  try {
    return execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim()
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}

// ------------------------------------------------------------------ behind, not broken

// Read BEFORE `ready`, which ships as a side effect - after it the trunk is level and
// the state this test is about no longer exists to assert.
git(repo, 'fetch', '-q', 'origin', 'master')
const behind = Number(git(repo, 'rev-list', '--count', 'master..FETCH_HEAD'))
ok('the trunk really is behind origin before the release', behind === 1, `behind=${behind}`)

lane('ready', '--session', 'worker', '--lane', 'a')
const shipped = lane('autoship')
ok(
  'the release does not refuse over a trunk it can simply fast-forward',
  !/will not take a push/.test(shipped),
  shipped
)
ok(
  "the lane's commit reached the trunk",
  git(repo, 'log', '--format=%s', 'master').split('\n').includes('feat: finished here'),
  shipped + '\n' + git(repo, 'log', '--oneline', '-5', 'master')
)
ok(
  "and so did the other machine's",
  git(repo, 'log', '--format=%s', 'master').includes('feat: written on the other machine'),
  git(repo, 'log', '--oneline', '-5', 'master')
)
ok(
  'origin has it too - nothing was left local',
  git(repo, 'rev-parse', 'master') === git(repo, 'rev-parse', 'origin/master'),
  `${git(repo, 'rev-parse', 'master')} vs ${git(repo, 'rev-parse', 'origin/master')}`
)

// ------------------------------------------- diverged still stops, which is the point

// A commit on each side of the same trunk: no fast-forward exists, so this is the case
// that needs a person and must keep refusing rather than inventing a merge under a lock.
git(other, 'pull', '-q', '--ff-only', 'origin', 'master')
writeFileSync(join(other, 'second-from-pc.js'), 'export const pc2 = 1\n')
git(other, 'add', '-A')
git(other, 'commit', '-qm', 'feat: second on the other machine')
git(other, 'push', '-q', 'origin', 'master')
writeFileSync(join(repo, 'local-only.js'), 'export const l = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'feat: local only')

writeFileSync(join(laneA, 'feature2.js'), 'export const f2 = 1\n')
git(laneA, 'add', '-A')
git(laneA, 'commit', '-qm', 'feat: second here')
lane('ready', '--session', 'worker', '--lane', 'a')

const diverged = lane('autoship')
ok('a genuinely diverged trunk still refuses', /will not take a push/.test(diverged), diverged)

console.log(failed ? `\n${failed} failed` : '\nall behind-origin checks passed')
process.exit(failed ? 1 : 0)
