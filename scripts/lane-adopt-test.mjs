// Regression test for finishing a lane whose own chat never came back.
//
// The bug this exists for, found on 2026-08-23 on taskdriver.ai: lane b had been
// conflicted for a day with fifteen commits in it and its chat gone, so every release
// shipped without them. The documented way out is
//
//   resolve --lane b  ->  fix the files, git add, git commit  ->  ready --lane b
//
// and the last step is impossible. Adoption never puts the adopter in `state.lanes.b` -
// the only record that it owns the lane is `state.conflicts.b.resolver`, which is exactly
// what `ready` checks. But every lane command starts with `retryConflicts()`, and the
// resolving commit is what makes the lane merge cleanly, so the next command DELETES
// `state.conflicts.b` and the mark with it. `ready --lane b` then answers
//
//   this session does not hold lane b - run resolve --lane b first
//
// and `resolve --lane b` answers `lane b is not conflicted`. The two steps point at each
// other and the work can never be declared done; the only way through was `retry`, which
// nobody would guess. Fixing the conflict destroyed the permission to finish it.
//
// The rule now: a lane with no chat may be declared done by whoever is holding the merge
// open, which is the same authority `retry` already grants itself on a clock.
//
//   node scripts/lane-adopt-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-adopt-test')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

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

// ------------------------------- adopting a stuck conflict ends in the work being shippable

{
  const f = fixture('adopt')
  const dir = laneA(f, 'gone-chat')
  commit(dir, 'app.js', 'console.log("lane")\n', 'feat: the work nobody could ship')
  commit(f.repo, 'app.js', 'console.log("master")\n', 'feat: master disagrees')

  // Its chat stops answering, so the conflict belongs to nobody.
  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - DEAD
  })
  f.lane('status')
  ok('the lane has no chat left', !f.state().lanes.a, JSON.stringify(f.state().lanes))
  ok('and its commit is not shippable yet', !f.state().ready.a, JSON.stringify(f.state().ready))

  const opened = f.lane('resolve', '--session', 'adopter', '--lane', 'a')
  ok('a live chat can open the half-merge', opened.ok && /merge open/.test(opened.out), opened.out || opened.err)
  ok('and the merge really is open in the lane', git(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD') !== '')

  // Resolve it the way a human would.
  writeFileSync(join(dir, 'app.js'), 'console.log("lane+master")\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'core.editor=true', 'commit', '-qm', 'merge master into lane-a')

  // Then any lane command at all runs before `ready` does - and the guard hook fires one
  // on every tool call, so in a real chat there are dozens over the minutes spent
  // resolving and re-verifying. `retryConflicts()` re-attempts the merge, finds that the
  // resolution made it clean, and drops `state.conflicts.a`. That record was the
  // adopter's ONLY claim on the lane, so fixing the conflict is what takes away the
  // permission to finish it. Which of retryConflicts' several exits does the dropping
  // varies with what else is in the worktree; the state it leaves behind does not, and
  // that state is what is set up here.
  f.patchState((s) => {
    delete s.conflicts.a
  })
  ok('the resolution left no conflict record behind', !f.state().conflicts?.a, JSON.stringify(f.state().conflicts))
  ok('and nothing else marked the work shippable', !f.state().ready.a, JSON.stringify(f.state().ready))

  // THE REGRESSION. Before the fix this threw `this session does not hold lane a`,
  // because committing the resolution is what deleted the resolver mark.
  const done = f.lane('ready', '--session', 'adopter', '--lane', 'a')
  ok('the chat that resolved it can declare it done', done.ok, done.err || done.out)
  ok('and the work is now shippable', Boolean(f.state().ready.a), JSON.stringify(f.state().ready))
}

// ------------------------------- a lane another chat is still working in is NOT adoptable

{
  const f = fixture('busy')
  const dir = laneA(f, 'busy-chat')
  commit(dir, 'feature.js', 'export const feature = 1\n', 'feat: mid-flight work')

  const stolen = f.lane('ready', '--session', 'stranger', '--lane', 'a')
  ok('a stranger cannot declare a held lane done', !stolen.ok, stolen.out)
  ok(
    'and is told to resolve first rather than being let in',
    /does not hold lane a/.test(stolen.err || stolen.out),
    stolen.err || stolen.out
  )
  ok('the work stays undeclared', !f.state().ready.a, JSON.stringify(f.state().ready))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
