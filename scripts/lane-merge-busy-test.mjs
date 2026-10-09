// Regression test: a release merge that fails for a reason that is not a conflict leaves the
// lane ready for the next release; only real unmerged files make a conflict.
//
// 2026-10-09, clients repo on the Windows PC: lane a was a plain fast-forward of main and
// `git merge-tree` was clean, yet it was recorded CONFLICTED twice (12:49pm, 12:57pm) with
// an empty detail. The PC was saturated (36 git.exe, hook timeouts): the merge was killed at
// its 20s deadline, the killed git had said nothing, no file was unmerged, and the empty
// answer went where the list of disagreeing files goes. The 10-minute retry landed it.
//
// Real git, real lane.mjs, no stubs. Two non-conflict failures real git can be made to give:
//   1. it refuses with an error and touches nothing (an unparseable merge setting), exit 128;
//   2. it never answers: a merge driver that outlives git's deadline, so lane.mjs kills it -
//      the same SIGKILL/ETIMEDOUT the PC's merges died of. Takes about 20 seconds.
//
//   node scripts/lane-merge-busy-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-merge-busy-test-' + process.pid)
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
writeFileSync(join(repo, 'shared.txt'), 'top\n1\n2\n3\n4\n5\n6\n7\n8\nbottom\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b'], release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
const origin = join(root, 'origin.git')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

const baseEnv = { ...process.env }
delete baseEnv.PANEFORGE_HOOK_DEADLINE
const lane = (env, ...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...baseEnv, ...env } }).trim() }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const ledger = () => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
const onMaster = (sha) => {
  try {
    git(repo, 'merge-base', '--is-ancestor', sha, 'master')
    return true
  } catch {
    return false
  }
}

const claimed = JSON.parse(lane({}, 'claim', '--session', 'builder', '--prefer', 'a').out)
const dir = claimed.dir
git(dir, 'config', 'user.email', 'test@example.com')
git(dir, 'config', 'user.name', 'test')
writeFileSync(join(dir, 'shared.txt'), 'top\n1 lane\n2\n3\n4\n5\n6\n7\n8\nbottom\n')
git(dir, 'commit', '-qam', 'feat: lane work')
const laneTip = git(dir, 'rev-parse', 'HEAD')

// ------------------------------------------- 1. git refuses with an error, nothing unmerged
// The lane is a plain fast-forward of master, the incident's shape. A setting every merge
// must parse makes `merge-tree` and `merge` both exit 128 without writing anything.
const refused = lane(
  { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'merge.conflictStyle', GIT_CONFIG_VALUE_0: 'bogus' },
  'ready', '--session', 'builder'
)
const one = ledger()
ok('a refused merge records no conflict', !one.conflicts?.a, JSON.stringify(one.conflicts?.a) + `\n${refused.out}\n${refused.err ?? ''}`)
ok('...the lane keeps its ready mark for the next release', Boolean(one.ready?.a), JSON.stringify(one.ready))
ok('...and nothing landed', !onMaster(laneTip), refused.out)
ok('...and the release says why it waits', /NOT out/.test(refused.out) && /conflictstyle/i.test(refused.out), refused.out)

// ------------------------------------------- 2. git never answers
// Master changes the same file further down, so the release needs a content merge, and the
// merge driver for that file sleeps past lane.mjs's 20s deadline.
writeFileSync(join(repo, 'shared.txt'), 'top\n1\n2\n3\n4\n5\n6\n7\n8 master\nbottom\n')
git(repo, 'commit', '-qam', 'master moves on')
git(repo, 'push', '-q', 'origin', 'master')
writeFileSync(join(repo, '.git', 'info', 'attributes'), 'shared.txt merge=slow\n')
git(repo, 'config', 'merge.slow.driver', `"${process.execPath.replace(/\\/g, '/')}" -e "setTimeout(() => {}, 24000)"`)
const t0 = Date.now()
const hung = lane({}, 'ship', '--session', 'builder')
const took = Date.now() - t0
const two = ledger()
ok('a merge killed at its deadline records no conflict', !two.conflicts?.a, JSON.stringify(two.conflicts?.a) + `\n${hung.out}\n${hung.err ?? ''}`)
ok('...the lane keeps its ready mark', Boolean(two.ready?.a), JSON.stringify(two.ready) + `\n${hung.out}`)
ok('...nothing landed', !onMaster(laneTip), hung.out)
ok('...the reason is not empty', /NOT out - \S/.test(hung.out), hung.out)
ok(`...and it gave up once, not once per fallback (${Math.round(took / 1000)}s)`, took < 38_000, `${took}ms`)

// ------------------------------------------- 3. the machine is fine again
git(repo, 'config', '--unset', 'merge.slow.driver')
rmSync(join(repo, '.git', 'info', 'attributes'), { force: true })
const later = lane({}, 'ship', '--session', 'builder')
const three = ledger()
ok('the next release lands the lane', onMaster(laneTip), `${later.out}\n${later.err ?? ''}`)
ok('...with both sides of the file', /1 lane/.test(readFileSync(join(repo, 'shared.txt'), 'utf8')) && /8 master/.test(readFileSync(join(repo, 'shared.txt'), 'utf8')))
ok('...and no conflict anywhere in the ledger', !Object.keys(three.conflicts ?? {}).length, JSON.stringify(three.conflicts))

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* a killed driver can hold the folder for a few seconds on Windows */
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
