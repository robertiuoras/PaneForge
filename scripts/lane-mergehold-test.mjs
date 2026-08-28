// Regression test: the release cooldown must not hold a repo that cuts no release.
//
// What happened on 2026-08-28, on taskdriver.ai: a lane finished, was verified, and was
// marked ready. `autoship` answered
//
//   "went out 115m ago. The work is committed and still on its lane; it merges and goes
//    out with the next release (about 5m)."
//
// ...and then the work sat on the lane for another 45 minutes until a person asked why it
// had not landed. Eight days earlier the same shape held four ready lanes for 576 minutes.
//
// Two things were true at once. The cooldown (COOLDOWN_MS, two hours; SMALL_HOLD_MS, six)
// is a RELEASE cadence device - its whole cost model is a build to install, a restart to
// take it and a version number to read - and it was being applied to a repo in `merge`
// mode, which cuts no version, builds no installer and prompts nobody to update. And once
// the window did expire, nothing called `autoship` again: the in-app timer only runs for
// repos with an open pane, and lane-cron.mjs is installed on the PC, not this machine. So
// the hold was not "wait five minutes", it was "wait until somebody types".
//
// The rule now: a `merge` (or `none`) repo ships the moment the lane is ready and no chat
// is mid-work. A `version` repo still batches, because there a release costs something.
//
// Real git repos in the temp folder, real lane.mjs, no stubs.
//
//   node scripts/lane-mergehold-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-mergehold-test')
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

/**
 * A repo with one lane holding one finished commit, and a `lastShip` stamped RIGHT NOW -
 * which is the state the bug needs: something is waiting, and the cooldown has only just
 * started. `release` picks the mode under test.
 */
function fixture(name, release) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'file.txt'), 'first\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  // A real bare origin: `ship` refuses to merge onto a branch it cannot then push, and
  // without this the merge-mode case fails on the push rather than on the rule under test.
  const origin = join(root, `${name}.git`)
  git(root, 'init', '-q', '--bare', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')

  const env = { ...process.env, PF_RELEASE: release }
  const lane = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
          cwd: repo,
          env,
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim()
      }
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }

  JSON.parse(lane('claim', '--session', 'sess-main').out)
  const work = JSON.parse(lane('claim', '--session', 'sess-b').out)

  // A release that went out one minute ago. Both windows (2h and 6h) are wide open.
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.lastShip = { version: '0.0.1', at: Date.now() - 60_000, lanes: [] }
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')

  // One small fix on the lane - small on purpose, so the six-hour window is the one that
  // would apply if mode were ignored, not the two-hour one.
  writeFileSync(join(work.dir, 'file.txt'), 'first\nsecond\n')
  git(work.dir, 'add', '-A')
  git(work.dir, 'commit', '-qm', 'fix: one line')

  return { repo, lane, work }
}

const landed = (repo) => git(repo, 'log', '--oneline', 'master').includes('fix: one line')

// ---------------------------------------------------------------- merge mode ships now

{
  const { repo, lane } = fixture('merge-repo', 'merge')
  const done = lane('ready', '--session', 'sess-b')
  ok('a merge-mode repo does not report a cooldown', !/next release/i.test(done.out), done.out)
  ok('a merge-mode repo lands the work on master immediately', landed(repo), done.out || done.err)
}

// -------------------------------------------------------- version mode still batches

{
  const { repo, lane } = fixture('version-repo', 'version')
  const done = lane('ready', '--session', 'sess-b')
  ok('a version-mode repo still holds the work for company', /next release/i.test(done.out), done.out)
  ok('and does not put it on master yet', !landed(repo), done.out)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
