// Regression test for the two halves of the 2026-08-09 squat: a VISITOR chat - one whose
// own project is a different repository, standing in this one only because its shell cd'd
// here - claimed `main`, finished its work in ten minutes, and then held the checkout for
// the half hour its window stayed open. The idle sweep could not help for an hour, so
// every real chat in the repo was sent to a letter lane by a chat that had left.
//
// The fix is two rules, tested here:
//   - a visitor is handed a letter lane while one is free; `main` is the repo's own
//     chats' checkout. Its preference for `main` counts only when the folder holds
//     uncommitted work to protect.
//   - `park` (run by the Stop hook when a turn ends) marks a clean hold as given up
//     softly: the chat keeps its lane and un-parks by speaking again, but a chat that
//     NEEDS the checkout takes a parked `main` after minutes (PARK_STEAL_MS) - and at
//     once when the parked holder is a visitor.
//
//   node scripts/visitor-park-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-visitor-park-test')
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
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b'] }, null, 2) + '\n')
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
const claim = (session, ...rest) => lane('claim', '--session', session, ...rest)
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return { lanes: {}, ready: {}, conflicts: {}, release: null, lastShip: null }
  }
}
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const clear = () =>
  patchState((s) => {
    s.lanes = {}
    s.ready = {}
    s.conflicts = {}
  })

// ------------------------------------------------------------------ a visitor avoids main

clear()
let r = JSON.parse(claim('visitor', '--visitor').out)
ok('a visitor with main free is still sent to a letter lane', r.lane === 'a', r.lane)

clear()
r = JSON.parse(claim('visitor', '--visitor', '--prefer', 'main').out)
ok('a visitor asking for a clean main does not get it', r.lane === 'a', r.lane)

clear()
writeFileSync(join(repo, 'half-typed.js'), 'export const y =\n')
r = JSON.parse(claim('visitor', '--visitor', '--prefer', 'main').out)
ok('a visitor standing over uncommitted work keeps main - the work wins', r.lane === 'main', r.lane)
ok('and the hold says what it is', state().lanes.main?.visitor === true)
unlinkSync(join(repo, 'half-typed.js'))

clear()
patchState((s) => {
  s.lanes.a = { session: 'chat-a', cwd: '/x', claimed: Date.now(), seen: Date.now() }
  s.lanes.b = { session: 'chat-b', cwd: '/x', claimed: Date.now(), seen: Date.now() }
})
r = JSON.parse(claim('visitor', '--visitor').out)
ok('with every letter taken, main is still better than a refusal', r.lane === 'main', r.lane)

clear()
r = JSON.parse(claim('homechat').out)
ok('a home chat still gets main first, exactly as before', r.lane === 'main', r.lane)

// ------------------------------------------------------------------ park

// A parked visitor main goes instantly.
clear()
patchState((s) => {
  s.lanes.main = { session: 'visitor', cwd: '/x', claimed: Date.now(), seen: Date.now(), visitor: true }
})
lane('park', '--session', 'visitor')
ok('park marks the clean hold', Boolean(state().lanes.main?.parked))
r = JSON.parse(claim('worker').out)
ok('a parked visitor main is handed over at once', r.lane === 'main', r.lane)
ok('and the visitor holds nothing now', !Object.values(state().lanes).some((c) => c.session === 'visitor'))

// A parked HOME main waits out its grace, then goes.
clear()
patchState((s) => {
  s.lanes.main = { session: 'homechat', cwd: repo, claimed: Date.now(), seen: Date.now() }
})
lane('park', '--session', 'homechat')
r = JSON.parse(claim('worker').out)
ok('a home chat parked a moment ago keeps main', r.lane === 'a', r.lane)
patchState((s) => {
  s.lanes.main.parked = Date.now() - 11 * 60 * 1000
})
r = JSON.parse(claim('worker2').out)
ok('past the grace, a parked main is handed over', r.lane === 'main', r.lane)

// Speaking again un-parks: the hold is the chat's for as long as it is talking.
clear()
patchState((s) => {
  s.lanes.main = { session: 'homechat', cwd: repo, claimed: Date.now(), seen: Date.now() }
})
lane('park', '--session', 'homechat')
claim('homechat')
ok('a claim by the parked chat clears the mark', !state().lanes.main?.parked)

// Park never touches a lane with anything in it.
clear()
patchState((s) => {
  s.lanes.main = { session: 'homechat', cwd: repo, claimed: Date.now(), seen: Date.now() }
})
writeFileSync(join(repo, 'half-typed.js'), 'export const y =\n')
lane('park', '--session', 'homechat')
ok('a dirty lane is not parked, whatever the hook says', !state().lanes.main?.parked)
unlinkSync(join(repo, 'half-typed.js'))

// A parked letter lane frees the pool when it is full.
clear()
patchState((s) => {
  s.lanes.main = { session: 'chat-m', cwd: repo, claimed: Date.now(), seen: Date.now() }
  s.lanes.a = { session: 'visitor', cwd: '/x', claimed: Date.now(), seen: Date.now(), visitor: true }
  s.lanes.b = { session: 'chat-b', cwd: '/x', claimed: Date.now(), seen: Date.now() }
})
lane('park', '--session', 'visitor')
r = claim('worker')
ok('a full pool takes the parked visitor lane rather than refusing', r.ok && JSON.parse(r.out).lane === 'a', r.err || r.out)

console.log(failed ? `\n${failed} failed` : '\nall visitor-park checks passed')
process.exit(failed ? 1 : 0)
