// Regression test for the release gate: which lanes make everyone else's work wait.
//
// The bug this exists for: a chat marked its lane `ready` and then kept editing. The
// ready mark was believed forever, so `busyLanes` skipped that lane, `autoship` decided
// nobody was mid-work and called `ship`, and `ship` aborted on the dirty checkout - an
// error `autoship` swallows by design, so no release happened and nothing said why. On
// 2026-07-26 that held v0.3.17 back with three lanes marked ready and one still being
// typed in, and the only visible symptom was a release that never came.
//
// So: a ready mark is only true while the lane still looks the way it did when the mark
// was made. Dirty again, or moved on to a new commit, and the lane is working again.
//
// Runs `scripts/lane.mjs` itself against real git repos in the temp folder. `ship` is
// never reached: the state is seeded with a fresh `lastShip`, so the worst case is the
// cooldown message rather than a tag and a push.
//
//   node scripts/release-gate-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-release-gate-test')
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

// ------------------------------------------------------------------ a repo with lanes

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
// No `typecheck` script: the gate's own compile check is not what is under test here.
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const lane = (...args) => {
  const r = execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe'
  })
  return r.trim()
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const laneOf = (id) => JSON.parse(lane('status')).lanes.find((l) => l.lane === id)

// Two chats: one sits in the main checkout, one gets a worktree lane.
const main = JSON.parse(lane('claim', '--session', 'sess-main'))
const work = JSON.parse(lane('claim', '--session', 'sess-work'))
ok('the first chat gets the main checkout', main.lane === 'main', `got ${main.lane}`)
ok('the second chat gets a worktree lane', work.lane !== 'main' && work.dir !== repo, `got ${work.lane}`)

// A release just went out, so nothing below can reach `ship`.
patchState((s) => {
  s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }
})

// Work in the lane, committed and declared done.
writeFileSync(join(work.dir, 'feature.js'), 'export const x = 1\n')
git(work.dir, 'add', '-A')
git(work.dir, 'commit', '-qm', 'a feature')
const readyOut = lane('ready', '--session', 'sess-work')
ok('a finished lane is marked ready', laneOf(work.lane).ready === true, readyOut)
ok(
  'a ready lane alone does not hold the release',
  /went out/.test(lane('autoship')),
  lane('autoship')
)

// ------------------------------------------------------- the bug: ready, then typing again

writeFileSync(join(work.dir, 'half-typed.js'), 'export const y =\n')
ok('editing again drops the stale ready mark', laneOf(work.lane).ready === false)
ok(
  'the release waits, and says which chat it is waiting for',
  lane('autoship').includes(`waiting on chats still working: ${work.lane}`),
  lane('autoship')
)

// The same hole in the main checkout, which is where it actually bit: master itself was
// dirty while marked ready, and `ship` aborts on a dirty main checkout.
rmSync(join(work.dir, 'half-typed.js'))
lane('ready', '--session', 'sess-work')
// `ready` refuses outright while a lane is dirty, so the only way to be ready and dirty
// at once is the real one: say done, then start typing again.
lane('ready', '--session', 'sess-main')
ok('a clean main checkout can mark itself ready', laneOf('main').ready === true)
writeFileSync(join(repo, 'half-typed.js'), 'export const z =\n')
ok('editing master again drops its ready mark', laneOf('main').ready === false)
ok(
  'a dirty main checkout holds the release by name',
  lane('autoship').includes('waiting on chats still working: main'),
  lane('autoship')
)

// ------------------------------------------------------- and the control: still shippable

rmSync(join(repo, 'half-typed.js'))
lane('ready', '--session', 'sess-main')
ok('a clean main checkout is ready again', laneOf('main').ready === true)
ok(
  'with every chat done the only thing left is the cooldown',
  /went out/.test(lane('autoship')),
  lane('autoship')
)

// Committing more work after saying "done" is working again too - not a release.
git(work.dir, 'commit', '-qm', 'more', '--allow-empty')
ok('committing after ready drops the mark as well', laneOf(work.lane).ready === false)
ok(
  'that lane holds the release too',
  lane('autoship').includes(`waiting on chats still working: ${work.lane}`),
  lane('autoship')
)

// ------------------------------------- committed work on master is not "still working"
//
// What Robert kept meeting: "waiting on chats still working: main", where main was a chat
// that had committed everything, was perfectly clean, and simply had not said `ready` -
// so every other lane's finished work sat behind a window nobody was going to close.
// master IS the release branch: a commit on it is already in the next release, and
// holding the release for it holds it for itself.

git(work.dir, 'commit', '-qm', 'lane keeps working', '--allow-empty')
lane('ready', '--session', 'sess-work')
git(repo, 'commit', '-qm', 'master commits and says nothing', '--allow-empty')
ok('committing on master drops its ready mark', laneOf('main').ready === false)
ok(
  'but committed, clean work on master does not hold anyone up',
  !lane('autoship').includes('waiting on chats still working'),
  lane('autoship')
)
writeFileSync(join(repo, 'still-typing.js'), 'export const q =\n')
ok(
  'an uncommitted edit on master still does',
  lane('autoship').includes('waiting on chats still working: main'),
  lane('autoship')
)
rmSync(join(repo, 'still-typing.js'))

// ------------------------------------------------------------------ the suite gate
//
// Until 2026-08-20 a typecheck was the only thing between a commit and a tag, and a
// typecheck says the types agree - never that the app works. 130 dev builds went out in
// the 14 days after v0.8.0 on that gate alone, and a broken one costs whoever runs the
// dev channel a download, a restart and a still-broken app. So an automatic release now
// runs the repo's own `npm test` as well.
//
// Two things are worth a test rather than a comment: that a red suite really does stop
// the release (a gate that reports and ships is not a gate), and that the answer is
// CACHED on the commit - the app's retry timer asks once a minute, so an uncached suite
// would burn its whole runtime every minute for as long as master stayed red.

const runs = join(root, 'suite-runs')
const exitFile = join(root, 'suite-exit')
writeFileSync(runs, '')
writeFileSync(exitFile, '1')
writeFileSync(
  join(repo, 'scripts', 'fake-test.mjs'),
  `import { appendFileSync, readFileSync } from 'node:fs'\n` +
    `appendFileSync(${JSON.stringify(runs)}, 'x')\n` +
    `if (readFileSync(${JSON.stringify(exitFile)}, 'utf8').trim() !== '0') {\n` +
    `  console.log('FAIL  the one that broke')\n` +
    `  process.exit(1)\n` +
    `}\n` +
    `console.log('ok    everything')\n`
)
// The counter and the exit code live OUTSIDE the checkout on purpose: a file the suite
// writes inside it would make master dirty, and a dirty master holds the release for a
// reason that has nothing to do with what is being tested here.
writeFileSync(
  join(repo, 'package.json'),
  JSON.stringify({ name: 'demo', version: '0.0.1', scripts: { test: 'node scripts/fake-test.mjs' } }, null, 2) + '\n'
)
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'a suite that fails')
// Nothing may be waiting on a chat, and the cooldown must be spent, or the refusal we
// read back could be either of those instead.
lane('ready', '--session', 'sess-work')
lane('ready', '--session', 'sess-main')
patchState((s) => {
  s.lastShip = { version: '0.0.1', at: Date.now() - 24 * 60 * 60 * 1000, lanes: [] }
})
const redOut = lane('autoship')
ok('a failing suite stops the release', /fails its own test suite/.test(redOut), redOut)
ok('and it quotes the check that failed', /the one that broke/.test(redOut), redOut)
ok('the suite really ran', readFileSync(runs, 'utf8').length === 1, `ran ${readFileSync(runs, 'utf8').length} times`)

const redAgain = lane('autoship')
ok('it still refuses on the next attempt', /fails its own test suite/.test(redAgain), redAgain)
ok(
  'but does not run the suite again for the same commit',
  readFileSync(runs, 'utf8').length === 1,
  `ran ${readFileSync(runs, 'utf8').length} times`
)

// A new commit is the only thing that may invalidate that answer - the suite is a fact
// about a tree, and this is the tree changing.
writeFileSync(exitFile, '0')
git(repo, 'commit', '-qm', 'fix the suite', '--allow-empty')
lane('ready', '--session', 'sess-main')
const greenOut = lane('autoship')
ok('a new commit re-runs it', readFileSync(runs, 'utf8').length === 2, `ran ${readFileSync(runs, 'utf8').length} times`)
ok('and a passing suite no longer holds the release', !/test suite/.test(greenOut), greenOut)

lane('release', '--session', 'sess-main')
lane('release', '--session', 'sess-work')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
