// Regression test for "a release waits on a lane nobody is working in".
//
// `idle-main-test.mjs` covers the CLAIM half of the 2026-08-07 taskdriver.ai squat: a chat
// in another project held `main`, so every later chat opened a worktree it did not need.
// This is the RELEASE half, which is the half that costs work. `busyLanes` waits for any
// lane with unfinished work in it and had no bound at all - the wait ended when the holding
// chat committed, marked ready or died, and a chat that does none of those three waits for
// ever. That day lane a's three verified, pushed commits were reported as "queued behind
// another active chat", and nothing short of the 12h stale sweep would have cleared it.
//
// Liveness was the wrong question: the squatter's heartbeat was four minutes old, because a
// window being open is not a person editing. So the bound is measured off the WORK - the
// newest mtime among the uncommitted files, and the newest commit the release does not have
// (see HOLD_BUSY_MS). Untouched for an hour is not work in progress.
//
// Every check below fails on the code before that change except the two that assert the
// waiting still happens, which is the half that must not regress: a release that walks over
// somebody's live edit is a worse bug than a release that waits.
//
//   node scripts/busy-hold-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-busy-hold-test')
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
/** Commit with a committer date the test chooses - that is what `git log --format=%ct` reads. */
const gitAt = (cwd, when, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }
  }).trim()

const repo = join(root, 'demo')
const laneA = join(root, 'demo-a')
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
git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', laneA)
git(laneA, 'config', 'user.email', 'test@example.com')
git(laneA, 'config', 'user.name', 'test')

const lane = (...args) =>
  execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe'
  }).trim()
/** `blockedBy` is `busyLanes` under its public name - the one field that answers this. */
const blocked = () => JSON.parse(lane('status')).blockedBy

const statePath = join(repo, '.git', 'paneforge-lanes.json')
const patchState = (fn) => {
  // The ledger is written by the first lane command, and this test writes it before
  // running one - `held()` IS the setup, so there is nothing to read on the first call.
  let s
  try {
    s = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    s = { lanes: {}, ready: {}, conflicts: {}, release: null }
  }
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const HOUR = 60 * 60 * 1000
/** Both chats present and live: a fresh heartbeat is exactly what the squat had. */
const held = (extra = {}) =>
  patchState((s) => {
    s.lanes = {
      main: { session: 'squatter', cwd: '/elsewhere', claimed: Date.now() - 6 * HOUR, seen: Date.now(), ...extra },
      a: { session: 'worker', cwd: laneA, claimed: Date.now(), seen: Date.now() }
    }
    s.ready = {}
    s.conflicts = {}
  })
/** Backdate a file the way an hour of nobody touching it would. */
const untouchedFor = (path, ms) => {
  const t = (Date.now() - ms) / 1000
  utimesSync(path, t, t)
}

// -------------------------------------------------------- the wait that must not regress

const wip = join(repo, 'half-typed.js')
held()
writeFileSync(wip, 'export const y =\n')
ok('an edit somebody just made still holds the release', blocked().includes('main'), JSON.stringify(blocked()))

// -------------------------------------------------------------------- ...and its bound

untouchedFor(wip, 2 * HOUR)
ok('the same edit, untouched for two hours, does not', !blocked().includes('main'), JSON.stringify(blocked()))

untouchedFor(wip, 30 * 60 * 1000)
ok('half an hour is not long enough to walk past it', blocked().includes('main'), JSON.stringify(blocked()))
unlinkSync(wip)

// A reservation made on the word "PaneForge" is documented as never delaying a release
// (TENTATIVE_MS) and was enforced nowhere: one stray file in the lane gated everyone.
// Claimed just now on purpose: `reap` PROMOTES a tentative claim past TENTATIVE_MS that
// has a dirty tree, on the grounds that something was written in it after all. So the
// reservation is only a reservation inside that window, and that is the window to test.
held({ tentative: true, claimed: Date.now() })
writeFileSync(wip, 'export const y =\n')
ok('a lane only reserved by a mention never holds a release', !blocked().includes('main'), JSON.stringify(blocked()))
unlinkSync(wip)

// -------------------------------------------------------- a letter lane, same two rules

held()
writeFileSync(join(laneA, 'feature.js'), 'export const f = 1\n')
git(laneA, 'add', '-A')
git(laneA, 'commit', '-qm', 'feat: mid-flight')
ok('a commit made moments ago holds the release', blocked().includes('a'), JSON.stringify(blocked()))

const old = new Date(Date.now() - 3 * HOUR).toISOString()
gitAt(laneA, old, 'commit', '-q', '--amend', '--no-edit', '--date', old)
ok('a lane whose last commit is three hours old does not', !blocked().includes('a'), JSON.stringify(blocked()))

// Not waiting is not the same as dropping. The work is still on its branch, and merges
// with the next release the moment its chat marks the lane ready.
ok(
  'the work it stopped waiting for is still on the lane branch',
  git(repo, 'log', '-1', '--format=%s', 'lane-a') === 'feat: mid-flight',
  git(repo, 'log', '-1', '--format=%s', 'lane-a')
)

// An old commit is not cover for a live edit sitting on top of it.
writeFileSync(join(laneA, 'scratch.js'), 'export const s = 1\n')
ok('an uncommitted file on top of it starts the wait again', blocked().includes('a'), JSON.stringify(blocked()))
unlinkSync(join(laneA, 'scratch.js'))

// -------------------------------------------------------------------- and it says why

held()
writeFileSync(wip, 'export const y =\n')
untouchedFor(wip, 12 * 60 * 1000)
const doctor = lane('doctor')
ok(
  'the report names the evidence, not just the lane',
  /main \(uncommitted edits, last touched 1[12]m ago\)/.test(doctor),
  doctor.split('\n').find((l) => l.includes('Waiting on')) ?? doctor
)
unlinkSync(wip)

// ------------------------------------------- a TRACKED file, which is where this broke

// Every check above edits an UNTRACKED file, and `git status --porcelain` writes those as
// `?? path` - two characters then a space, so a fixed `slice(3)` lands on the path. A file
// git already knows is written ` M path`, with a LEADING SPACE, and `git()` trims its
// output: the first line arrives one character short, `slice(3)` ate the path's first
// letter, every stat threw, and `lastTouched` returned 0 - which `busyLanes` reads as
// "age unknown, be careful" and waits on for ever. Measured on taskdriver.ai 2026-08-28:
// lane c, one edit to `scratchpad/current-run.txt` untouched for 131 minutes, still held
// two finished lanes 188 minutes after the last merge.
held()
const tracked = join(repo, 'app.js')
writeFileSync(tracked, 'console.log(2)\n')
ok('a tracked file just edited holds the release', blocked().includes('main'), JSON.stringify(blocked()))

untouchedFor(tracked, 2 * HOUR)
ok(
  'the same tracked edit, untouched for two hours, does not',
  !blocked().includes('main'),
  JSON.stringify(blocked())
)

untouchedFor(tracked, 12 * 60 * 1000)
const trackedDoctor = lane('doctor')
ok(
  'and its age is readable, not blank',
  /main \(uncommitted edits, last touched 1[12]m ago\)/.test(trackedDoctor),
  trackedDoctor.split('\n').find((l) => l.includes('Waiting on')) ?? trackedDoctor
)
git(repo, 'checkout', '--', 'app.js')

console.log(failed ? `\n${failed} failed` : '\nall busy-hold checks passed')
process.exit(failed ? 1 : 0)
