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
for (const f of ['lane.mjs', 'test-app.mjs']) copyFileSync(join(here, f), join(repo, 'scripts', f))
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

lane('release', '--session', 'sess-main')
lane('release', '--session', 'sess-work')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
