// Regression test for reclaiming idle, empty lanes.
//
// The bug this exists for: on 2026-07-27 all four lanes were held by chats opened hours
// apart. Three of them had done nothing at all - clean tree, no commits, no ready mark -
// and the chat that actually had work to do was told "all lanes busy" and had to wait for
// a human to close a window. The 12-hour stale sweep is for chats that died; it is far too
// slow to be the answer to a chat that is simply idle.
//
// So: when there is nothing free, a lane that has been quiet for an hour AND has nothing
// in it may be taken. The second half is what makes it safe - one uncommitted character,
// one unreleased commit, a ready mark or a conflict, and the lane is never touched,
// however long it has been quiet.
//
//   node scripts/idle-lane-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-idle-lane-test')
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
const claim = (session) => lane('claim', '--session', session)
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
/** Older than the idle window, but nowhere near the 12h stale sweep. */
const HOURS_2 = 2 * 60 * 60 * 1000
const quiet = (session, ago) =>
  patchState((s) => {
    for (const c of Object.values(s.lanes)) if (c.session === session) c.seen = Date.now() - ago
  })
const dirOf = (session) => {
  const [id] = Object.entries(state().lanes).find(([, c]) => c.session === session)
  return JSON.parse(lane('status').out).lanes.find((l) => l.lane === id).dir
}

// ------------------------------------------------------------------ fill every lane

const claims = ['a', 'b', 'c', 'd'].map((n) => JSON.parse(claim(`sess-${n}`).out))
ok('four chats fill the pool', new Set(claims.map((c) => c.lane)).size === 4, JSON.stringify(claims.map((c) => c.lane)))
patchState((s) => {
  s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }
})

// ------------------------------------------------------------------ busy stays busy

const refused = claim('sess-e')
ok('a fifth chat is refused while every lane is in use', !refused.ok && /all lanes busy/.test(refused.err), refused.err)

// ------------------------------------------------------------------ work is never taken

// Uncommitted work in one idle lane, a commit in another: both quiet for two hours.
writeFileSync(join(dirOf('sess-b'), 'half-typed.js'), 'export const y =\n')
const cDir = dirOf('sess-c')
writeFileSync(join(cDir, 'feature.js'), 'export const x = 1\n')
git(cDir, 'add', '-A')
git(cDir, 'commit', '-qm', 'a feature')
quiet('sess-b', HOURS_2)
quiet('sess-c', HOURS_2)

const stillRefused = claim('sess-e')
ok(
  'an idle lane with work in it is left alone',
  !stillRefused.ok && /all lanes busy/.test(stillRefused.err),
  stillRefused.err
)

// A lane that finished and is waiting for the release is not free either.
lane('ready', '--session', 'sess-c')
quiet('sess-c', HOURS_2)
const readyRefused = claim('sess-e')
ok(
  'a lane waiting for its release is left alone',
  !readyRefused.ok && /all lanes busy/.test(readyRefused.err),
  readyRefused.err
)

// ------------------------------------------------------------------ empty and quiet goes

const aLane = Object.entries(state().lanes).find(([, c]) => c.session === 'sess-a')[0]
const dLane = Object.entries(state().lanes).find(([, c]) => c.session === 'sess-d')[0]
quiet('sess-a', HOURS_2 + 60_000) // the older of the two idle empties
quiet('sess-d', HOURS_2)

const taken = claim('sess-e')
ok('a chat that needs a checkout now gets the idle empty one', taken.ok, taken.err)
const got = taken.ok ? JSON.parse(taken.out) : {}
ok('the lane it takes is the one quiet longest', got.lane === aLane, `got ${got.lane}, wanted ${aLane}`)
ok('the newer idle lane is untouched', state().lanes[dLane]?.session === 'sess-d')
ok('the reclaimed lane now belongs to the new chat', state().lanes[aLane]?.session === 'sess-e')

// One lane is taken per claim, when a claim needs it - never a sweep. The next chat
// through takes the next idle empty one, and only then.
const nextClaim = claim('sess-f')
ok('the next chat takes the next idle empty lane', nextClaim.ok, nextClaim.err)
ok(
  'and it is the other idle empty one, not a lane with work',
  nextClaim.ok && JSON.parse(nextClaim.out).lane === dLane,
  nextClaim.ok ? JSON.parse(nextClaim.out).lane : nextClaim.err
)
ok(
  'and the remaining lanes with work in them are still theirs',
  state().lanes[Object.entries(state().lanes).find(([, c]) => c.session === 'sess-b')[0]].session === 'sess-b'
)

console.log(failed ? `\n${failed} failed` : '\nall idle-lane checks passed')
process.exit(failed ? 1 : 0)
