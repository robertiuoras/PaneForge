// Finished lanes merge into the trunk, never into whatever the main folder has checked out.
//
// Measured on taskdriver.ai 2026-09-23: the main folder had been left on
// `feat/github-actions-usage-card`, and lane.mjs took "the branch the main folder is on" as
// the trunk - so every `ready` for 35 hours merged into that feature branch, which ended up
// 171 commits ahead of origin/main. The trunk is now `.lanes.json` `branch`, else origin's
// default, else main/master; a main folder found off it is put back when that changes no
// file, and otherwise nothing merges and the lane keeps its ready mark.
//
// Three repos, real git, a real bare origin each, real lane.mjs, no stubs:
//   heals     main folder on a feature branch that already has everything the trunk has
//   refuses   main folder on a branch that has diverged from the trunk
//   declared  `.lanes.json` names a branch that is not origin's default, and it wins
//
//   node scripts/lane-trunk-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-trunk-test')
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
const commit = (cwd, file, subject) => {
  writeFileSync(join(cwd, file), `${subject}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', subject)
}
const subjects = (repo, ref) => git(repo, 'log', '--format=%s', ref).split('\n')

/** A repo on master with a bare origin whose HEAD is master, and lane a with one finished commit. */
function makeRepo(name, lanes = {}) {
  const origin = join(root, `${name}.git`)
  const repo = join(root, name)
  git(root, 'init', '-q', '--bare', '-b', 'master', origin)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a'], release: 'merge', ...lanes }, null, 2) + '\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')
  // What a clone has and `remote add` does not: origin's default branch, which is the
  // answer the trunk now comes from.
  git(repo, 'remote', 'set-head', 'origin', 'master')
  const laneA = join(root, `${name}-a`)
  return { repo, origin, laneA }
}

function addLane({ repo, laneA }, base) {
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', laneA, base)
  git(laneA, 'config', 'user.email', 'test@example.com')
  git(laneA, 'config', 'user.name', 'test')
  commit(laneA, 'lane.js', 'feat: finished in lane a')
}

const lane = (repo, ...args) => {
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
const ledger = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))

// ------------------------------------------------------------------ heals

{
  const r = makeRepo('heals')
  addLane(r, 'master')
  // The main folder is left on a feature branch that carries a commit of its own,
  // everything master has, and a lane an earlier release already merged into it by
  // mistake - the taskdriver.ai shape (171 commits, lane merges among them).
  git(r.repo, 'checkout', '-q', '-b', 'feat/parked')
  commit(r.repo, 'parked.js', 'feat: the parked branch')
  git(r.repo, 'branch', 'lane-old', 'master')
  git(r.repo, 'worktree', 'add', '-q', join(root, 'heals-old'), 'lane-old')
  commit(join(root, 'heals-old'), 'old.js', 'feat: an earlier lane')
  git(r.repo, 'merge', '--no-ff', '-q', '-m', 'merge lane old', 'lane-old')
  const parkedTip = git(r.repo, 'rev-parse', 'HEAD')

  const said = lane(r.repo, 'ready', '--session', 'worker', '--lane', 'a')
  ok('the main folder is back on master', git(r.repo, 'symbolic-ref', '--short', 'HEAD') === 'master', said)
  ok("master now has the lane's work", subjects(r.repo, 'master').includes('feat: finished in lane a'), said)
  ok("...and the parked branch's commit, which the folder already had", subjects(r.repo, 'master').includes('feat: the parked branch'))
  ok(
    'the feature branch itself did not receive the lane',
    git(r.repo, 'rev-parse', 'feat/parked') === parkedTip,
    git(r.repo, 'log', '--oneline', '-3', 'feat/parked')
  )
  ok('origin master got it all', git(r.repo, 'rev-parse', 'master') === git(r.origin, 'rev-parse', 'master'))
  ok('no file in the main folder changed', !git(r.repo, 'status', '--porcelain'))
  const doc = lane(r.repo, 'doctor')
  ok('doctor says what happened, in plain words', /had been left on feat\/parked.*back on master/.test(doc), doc)
}

// ------------------------------------------------------------------ on purpose

{
  // Somebody made a feature branch in the main folder and is committing to it. No finished
  // chat has merged there, so it is theirs: the lanes wait rather than take it over.
  const r = makeRepo('purpose')
  addLane(r, 'master')
  git(r.repo, 'checkout', '-q', '-b', 'feat/mine')
  commit(r.repo, 'mine.js', 'feat: my own work')
  const mineTip = git(r.repo, 'rev-parse', 'HEAD')
  const masterTip = git(r.repo, 'rev-parse', 'master')
  const said = lane(r.repo, 'ready', '--session', 'worker', '--lane', 'a')
  ok('a branch in use on purpose is not taken over', git(r.repo, 'symbolic-ref', '--short', 'HEAD') === 'feat/mine', said)
  ok('...nothing merged into it', git(r.repo, 'rev-parse', 'HEAD') === mineTip)
  ok('...master did not move', git(r.repo, 'rev-parse', 'master') === masterTip)
  ok('...and it says why', /somebody may be using it on purpose/.test(said), said)
}

// ------------------------------------------------------------------ refuses

{
  const r = makeRepo('refuses')
  const base = git(r.repo, 'rev-parse', 'HEAD')
  addLane(r, 'master')
  // master moves on while the main folder sits on a branch cut before that: each side has
  // work the other lacks, so there is no fast-forward and no safe answer without a person.
  commit(r.repo, 'trunk.js', 'feat: on master')
  git(r.repo, 'checkout', '-q', '-b', 'feat/diverged', base)
  commit(r.repo, 'side.js', 'feat: on the side branch')
  const sideTip = git(r.repo, 'rev-parse', 'HEAD')
  const masterTip = git(r.repo, 'rev-parse', 'master')

  const said = lane(r.repo, 'ready', '--session', 'worker', '--lane', 'a')
  ok('the release refuses and says why', /side branch \(feat\/diverged\).*finished chats are waiting/.test(said), said)
  ok('nothing merged into the side branch', git(r.repo, 'rev-parse', 'HEAD') === sideTip, git(r.repo, 'log', '--oneline', '-3'))
  ok('master did not move', git(r.repo, 'rev-parse', 'master') === masterTip)
  ok('the main folder was left where it was', git(r.repo, 'symbolic-ref', '--short', 'HEAD') === 'feat/diverged')
  ok('the lane keeps its ready mark for the next retry', Boolean(ledger(r.repo).ready.a), JSON.stringify(ledger(r.repo).ready))
  const doc = lane(r.repo, 'doctor')
  ok('doctor prints the waiting line', /MAIN FOLDER[\s\S]*side branch \(feat\/diverged\), so finished chats are waiting/.test(doc), doc)

  // Somebody puts the folder back by hand: the next retry releases the waiting lane.
  git(r.repo, 'checkout', '-q', 'master')
  const retry = lane(r.repo, 'retry')
  ok('back on master, the waiting lane goes out', subjects(r.repo, 'master').includes('feat: finished in lane a'), retry)
  ok('...and the side branch is still untouched', git(r.repo, 'rev-parse', 'feat/diverged') === sideTip)
}

// ------------------------------------------------------------------ declared

{
  // origin's default is master, but the repo says its lanes belong on develop.
  const r = makeRepo('declared', { branch: 'develop' })
  git(r.repo, 'checkout', '-q', '-b', 'develop')
  git(r.repo, 'push', '-q', '-u', 'origin', 'develop')
  addLane(r, 'develop')
  const masterTip = git(r.repo, 'rev-parse', 'master')

  const said = lane(r.repo, 'ready', '--session', 'worker', '--lane', 'a')
  ok('the lane merged into the declared branch', subjects(r.repo, 'develop').includes('feat: finished in lane a'), said)
  ok('origin default (master) was not touched', git(r.repo, 'rev-parse', 'master') === masterTip)
  ok('the main folder stayed on develop', git(r.repo, 'symbolic-ref', '--short', 'HEAD') === 'develop')
}

console.log(failed ? `\n${failed} failed` : '\nall trunk checks passed')
process.exit(failed ? 1 : 0)
