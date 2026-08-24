// Regression test for a hold on a checkout that is not on disk.
//
// The bug this exists for, found on 2026-08-24: `assistant` showed three rows under LANES
// ELSEWHERE - a, b and c, each "quiet 10h" - against a repository whose only worktree was
// the trunk. The lane folders had been deleted, so no heartbeat could ever arrive and
// nothing could ever be typed in them, and the only rule that drops a claim on silence is
// STALE_MS, which is twelve hours. The rows were unfalsifiable for the rest of the day.
//
// The rule added is narrow on purpose, and every assertion here is one of its edges:
//
//   - a letter lane whose folder is gone, quiet past TENTATIVE_MS, is dropped
//   - a ghost whose BRANCH is ahead of master keeps its hold: nothing can drain a
//     checkout that is not there, so dropping it would orphan the commits
//   - a folder-less claim made just now is a lane being SET UP, and is kept
//   - a lane whose folder exists is untouched however quiet it is - that is STALE_MS's job
//   - `main` is never dropped this way: its folder is the repository itself
//
//   node scripts/lane-ghost-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-ghost-test')

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

/** Past TENTATIVE_MS (20m) and nowhere near STALE_MS (12h): only the new rule can act. */
const QUIET = 45 * 60 * 1000

/** The folder deleted, and git told, the way a person tidying up leaves it. */
const removeWorktree = (f, dir) => {
  rmSync(dir, { recursive: true, force: true })
  try {
    git(f.repo, 'worktree', 'prune')
  } catch {
    /* a prune that cannot run leaves a stricter test, not a broken one */
  }
}

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// ------------------------------------------------------ the folder is gone, the hold is not

{
  const f = fixture('vanished')
  const dir = laneA(f, 'ghost-chat')
  ok('the lane starts out held', f.state().lanes.a?.session === 'ghost-chat', JSON.stringify(f.state().lanes))

  removeWorktree(f, dir)
  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - QUIET
  })
  f.lane('status')

  const s = f.state()
  ok('a hold on a checkout that is not there is dropped', !s.lanes.a, JSON.stringify(s.lanes))
  const rows = JSON.parse(f.lane('status').out).lanes
  ok(
    'and the row stops naming a chat',
    rows.find((l) => l.lane === 'a')?.heldBy == null,
    JSON.stringify(rows.find((l) => l.lane === 'a'))
  )
}

// ------------------------------------------- a ghost carrying commits is NOT dropped

{
  const f = fixture('vanished-with-work')
  const dir = laneA(f, 'ghost-with-work')
  commit(dir, 'feature.js', 'export const feature = 1\n', 'feat: written before the folder went')

  removeWorktree(f, dir)
  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - QUIET
  })
  f.lane('status')

  // The control that keeps the rule honest. `drainLane` needs a checkout for every step it
  // takes, so with the folder gone there is no way to mark this work ready - dropping the
  // claim would leave commits on a branch nothing points at. The hold stays.
  const s = f.state()
  ok('a ghost with commits on its branch keeps its hold', s.lanes.a?.session === 'ghost-with-work', JSON.stringify(s.lanes))
  ok('and the commit is still on its branch', git(f.repo, 'rev-list', '--count', 'master..lane-a') === '1')
}

// ------------------------------------------------ a claim with no folder YET is being set up

{
  const f = fixture('setting-up')
  laneA(f, 'fresh-chat')
  // A claim is written before the worktree is built, so this is the shape of a lane a few
  // milliseconds old. Reaping it on the spot would delete a live chat's lane.
  f.patchState((s) => {
    s.lanes.a.dir = join(f.repo, '..', 'setting-up-a')
    s.lanes.a.seen = Date.now()
  })
  rmSync(join(dirname(f.repo), 'setting-up-a'), { recursive: true, force: true })
  f.lane('status')

  ok('a folder-less claim made just now is kept', f.state().lanes.a?.session === 'fresh-chat', JSON.stringify(f.state().lanes))
}

// ------------------------------------------- a lane that DOES exist is nobody's business here

{
  const f = fixture('present')
  laneA(f, 'quiet-chat')
  f.patchState((s) => {
    s.lanes.a.seen = Date.now() - QUIET
  })
  f.lane('status')

  ok(
    'a quiet hold on a checkout that is there is left alone',
    f.state().lanes.a?.session === 'quiet-chat',
    JSON.stringify(f.state().lanes)
  )
}

// ------------------------------------------------------------------ the trunk is not a lane

{
  const f = fixture('trunk')
  f.lane('claim', '--session', 'trunk-chat', '--prefer', 'main')
  f.patchState((s) => {
    if (s.lanes.main) s.lanes.main.seen = Date.now() - QUIET
  })
  f.lane('status')

  ok(
    'main is never dropped for a missing folder - its folder is the repository',
    !f.state().lanes.main || f.state().lanes.main.session === 'trunk-chat',
    JSON.stringify(f.state().lanes)
  )
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
