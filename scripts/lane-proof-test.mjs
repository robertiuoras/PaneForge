// A ship may only report a lane it can PROVE went out.
//
// 2026-08-28, taskdriver.ai: `.git/paneforge-lanes.json` recorded
// `lastShip = {"lanes":["b","a","c","d"]}` while lane a's own commit was not an ancestor
// of `origin/main`, and `state.conflicts` was `{}`. The ship then cleared every ready
// mark, so lane a read as "not ready" to every other chat and its production fix stayed
// unshipped while production stayed broken. Recording the INTENT to merge is the
// empty-as-success shape: from any other chat, a lane that was silently passed over and a
// lane that merged look exactly the same.
//
// Two rules, both driven here against real git:
//
//   a lane enters `lastShip.lanes` only once its commit is proved on origin's branch,
//   and one that cannot be proved KEEPS its ready mark
//
//   a lane that is passed over leaves evidence, by name
//
// The push is made to succeed while origin's branch does NOT move, with a `post-receive`
// hook that rewinds it - which is the real failure's shape (git said ok, the work is not
// there) without needing a broken network. The control is the same repo with the hook
// gone: the lane must then be reported, or this test would pass on a ship that reports
// nothing at all.
//
//   node scripts/lane-proof-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const ENGINE = join(repoRoot, 'scripts', 'lane.mjs')
const work = mkdtempSync(join(tmpdir(), 'pf-laneproof-'))
let failures = 0

function ok(name, pass, detail = '') {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` - ${detail}`}`)
  if (!pass) failures++
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

function lane(repo, ...args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args, '--repo', repo], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const ledger = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))

function project(name) {
  const origin = join(work, `${name}.git`)
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', origin], { windowsHide: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge' }, null, 2) + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  return { repo, origin }
}

/**
 * Take the push and then put the branch back. `git push` exits 0 and origin's `main` is
 * exactly where it was - which is what a lane that "shipped" without its commits landing
 * looks like from the pushing side.
 */
function swallowPushes(origin) {
  const hook = join(origin, 'hooks', 'post-receive')
  writeFileSync(
    hook,
    ['#!/bin/sh', 'while read old new ref; do', '  git update-ref "$ref" "$old"', 'done', ''].join('\n')
  )
  chmodSync(hook, 0o755)
}

function laneWithWork(repo, session, file) {
  const spot = JSON.parse(lane(repo, 'claim', '--session', session, '--cwd', repo).out)
  writeFileSync(join(spot.dir, file), 'export const x = 1\n')
  git(spot.dir, 'add', '-A')
  git(spot.dir, 'commit', '-qm', `feat: ${file}`)
  return spot
}

// -------------------------------------------------- a push that lands nowhere is not a ship

{
  const { repo, origin } = project('swallowed')
  laneWithWork(repo, 'hold-main', 'held.js') // chat 1 takes the trunk
  const a = laneWithWork(repo, 'chat-a', 'feature.js')
  ok('the lane really is lane a', a.lane === 'a', a.lane)
  const tip = git(a.dir, 'rev-parse', 'HEAD')

  swallowPushes(origin)
  const done = lane(repo, 'ready', '--session', 'chat-a')

  const originMain = git(origin, 'rev-parse', 'main')
  const landed = spawnSync('git', ['merge-base', '--is-ancestor', tip, originMain], {
    cwd: repo,
    windowsHide: true
  }).status === 0
  ok('the work really did NOT reach origin', !landed)

  const state = ledger(repo)
  ok(
    'so the lane is NOT reported as shipped',
    !(state.lastShip?.lanes ?? []).includes('a'),
    JSON.stringify(state.lastShip)
  )
  ok('and it KEEPS its ready mark for the next release', !!state.ready?.a, JSON.stringify(state.ready))
  ok('and the refusal is said out loud, by name', /lane a is not out/i.test(done.out), done.out)
}

// ------------------------------------------------------------- the control: the same, landing

{
  const { repo, origin } = project('landing')
  laneWithWork(repo, 'hold-main', 'held.js')
  const a = laneWithWork(repo, 'chat-a', 'feature.js')
  const tip = git(a.dir, 'rev-parse', 'HEAD')

  lane(repo, 'ready', '--session', 'chat-a')

  const originMain = git(origin, 'rev-parse', 'main')
  const landed = spawnSync('git', ['merge-base', '--is-ancestor', tip, originMain], {
    cwd: repo,
    windowsHide: true
  }).status === 0
  ok('with nothing swallowing the push the work IS on origin', landed)

  const state = ledger(repo)
  ok('and now the lane IS reported', (state.lastShip?.lanes ?? []).includes('a'), JSON.stringify(state.lastShip))
  ok('and its ready mark is cleared', !state.ready?.a, JSON.stringify(state.ready))
}

// ------------------------------------------------- a lane passed over says so, rather than vanishing

{
  const { repo } = project('already')
  laneWithWork(repo, 'hold-main', 'held.js')

  // One lane goes out first, which starts the release cooldown - so the NEXT lane's `ready`
  // marks it and waits, which is the only way to still have a ready mark in hand when the
  // work behind it stops being missing from the branch.
  const first = laneWithWork(repo, 'chat-1', 'other.js')
  lane(repo, 'ready', '--session', 'chat-1')

  const held = laneWithWork(repo, 'chat-2', 'feature.js')
  lane(repo, 'ready', '--session', 'chat-2')
  ok(
    `lane ${held.lane} is marked ready and waiting on the cooldown`,
    !!ledger(repo).ready?.[held.lane],
    JSON.stringify(ledger(repo).ready)
  )

  // The same diff, arriving on the branch by another road. `git cherry` compares PATCH IDS,
  // so an identical change is an identical patch however it got there - and that is exactly
  // the state where a lane has nothing left to merge, which used to drop it out of `ready`
  // with nothing whatever said about it.
  writeFileSync(join(repo, 'feature.js'), 'export const x = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'feat: feature.js, by another road')
  lane(repo, 'ship')

  const note = ledger(repo).passed?.[held.lane]
  ok('a lane passed over leaves a note behind, by name', !!note, JSON.stringify(ledger(repo).passed))
  ok('and the note says why', /does not already have/.test(note?.why ?? ''), note?.why)
  const doctor = lane(repo, 'doctor')
  ok(
    'and doctor says it out loud',
    new RegExp(`lane ${held.lane} was passed over`, 'i').test(doctor.out),
    doctor.out.slice(0, 300)
  )
  ok(
    'and it is not counted as one that went out',
    !(ledger(repo).lastShip?.lanes ?? []).includes(held.lane),
    JSON.stringify(ledger(repo).lastShip)
  )
}

console.log(failures ? `\n${failures} failed` : '\nall lane-proof checks passed')
process.exit(failures ? 1 : 0)
