// Regression test for lane commits that outlive the chat that wrote them.
//
// The bug this exists for, found on 2026-08-01: a lane's work only ever becomes shippable
// because a chat SAYS so - `ready` while it is working, or the SessionEnd hook on the way
// out. A chat that is killed, or that sleeps through a reboot, says neither. Twelve hours
// later the claim went stale and was deleted in silence, and the commits stayed on the lane
// branch with nothing pointing at them: `shippable()` only counts lanes that are marked
// ready, so the release could not see them, and nothing ever would until some later chat
// happened to be handed that same lane. Real commits sat like that for days.
//
// The fix is that losing an owner is not an opinion about the work. Committed and clean
// means it was meant to go out; that is exactly the rule the normal end-of-session path
// uses, so it is the rule used here too:
//
//   - a stale claim drains before it is dropped
//   - `retry` (which runs on a clock) sweeps lanes that have no claim left to drain
//   - uncommitted work is never marked ready, however long it has been abandoned
//   - a lane that will not merge is recorded as conflicted, not marked ready and left to
//     fail at release time with nobody around to read the failure
//
//   node scripts/lane-orphan-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-orphan-test')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** A fresh repo with lane.mjs in it, tagged so `unreleasedOnMaster` starts at zero. */
function fixture(name) {
  const repo = join(root, name)
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
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
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const patchState = (fn) => {
    const s = state()
    fn(s)
    writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  return { repo, lane, state, patchState }
}

/** Claim lane `a` and return its checkout. */
function laneA(f, session) {
  const r = JSON.parse(f.lane('claim', '--session', session, '--prefer', 'a').out)
  git(r.dir, 'config', 'user.email', 'test@example.com')
  git(r.dir, 'config', 'user.name', 'test')
  return r.dir
}

const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

/** Older than STALE_MS (12h), which is what makes a claim reapable. */
const DEAD = 13 * 60 * 60 * 1000

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// ------------------------------------------------- a killed chat's work is not abandoned

{
  const f = fixture('killed')
  const dir = laneA(f, 'killed-chat')
  commit(dir, 'feature.js', 'export const feature = 1\n', 'feat: a thing nobody declared done')

  ok('before the sweep the work is invisible to a release', !f.state().ready.a, JSON.stringify(f.state().ready))

  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - DEAD
  })
  // `status` reaps like every other command, and persists what it reaped.
  f.lane('status')

  const s = f.state()
  ok('the dead chat no longer holds the lane', !s.lanes.a, JSON.stringify(s.lanes))
  ok('its commit is marked ready instead of being forgotten', Boolean(s.ready.a), JSON.stringify(s.ready))
  ok('the mark records how much work it rescued', s.ready.a?.commits === 1, JSON.stringify(s.ready.a))

  const pending = JSON.parse(f.lane('status').out).pending
  ok('and a release can now see it', pending === true, `pending=${pending}`)
}

// ------------------------------------------------- half-finished work is left half-finished

{
  const f = fixture('dirty')
  const dir = laneA(f, 'dirty-chat')
  commit(dir, 'feature.js', 'export const feature = 1\n', 'feat: committed half')
  writeFileSync(join(dir, 'feature.js'), 'export const feature = 2\n') // uncommitted

  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - DEAD
  })
  f.lane('status')

  const s = f.state()
  ok('a lane with uncommitted edits is never marked ready', !s.ready.a, JSON.stringify(s.ready))
  ok('and the edit is still sitting in the lane', readFileSync(join(dir, 'feature.js'), 'utf8').includes('= 2'))
  ok('and the commit is still on its branch', git(f.repo, 'rev-list', '--count', 'master..lane-a') === '1')
}

// ------------------------------------------------- a lane with no claim left to drain

{
  const f = fixture('unclaimed')
  const dir = laneA(f, 'vanished-chat')
  commit(dir, 'feature.js', 'export const feature = 1\n', 'feat: orphaned before the drain existed')

  // What an older version of lane.mjs left behind, and what a kill between dropping the
  // claim and draining it would leave: commits on a branch, and nothing in the state file
  // that mentions them.
  f.patchState((s) => {
    delete s.lanes.a
  })
  ok('nothing in the state file points at the work', !f.state().ready.a && !f.state().lanes.a)

  const r = f.lane('retry')
  ok('the clock sweep finds it', Boolean(f.state().ready.a), JSON.stringify(f.state().ready))
  ok('and says so in words', /had finished work and no chat/.test(r.out), r.out)
}

// ------------------------------------------------- an unmergeable lane is reported, not marked

{
  const f = fixture('conflicted')
  const dir = laneA(f, 'doomed-chat')
  commit(dir, 'app.js', 'console.log("lane")\n', 'feat: lane edits app.js')
  commit(f.repo, 'app.js', 'console.log("master")\n', 'feat: master edits app.js')

  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - DEAD
  })
  f.lane('status')

  const s = f.state()
  ok('a lane that will not merge is not marked ready', !s.ready.a, JSON.stringify(s.ready))
  ok('it is recorded as conflicted by name', Boolean(s.conflicts.a), JSON.stringify(s.conflicts))
  ok('the conflict names the file', /app\.js/.test(s.conflicts.a?.detail ?? ''), JSON.stringify(s.conflicts.a))
  ok(
    'and the lane checkout is left clean, not mid-merge',
    git(dir, 'status', '--porcelain') === '',
    git(dir, 'status', '--porcelain')
  )
}

console.log(failed ? `\n${failed} orphan-lane check(s) failed` : '\nall orphan-lane checks passed')
process.exit(failed ? 1 : 0)
