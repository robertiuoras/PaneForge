// Regression test for lanes that were claimed by a chat only TALKING about PaneForge.
//
// The bug this exists for: 2026-07-28. The prompt hook claims a lane whenever a chat is
// "about PaneForge", and a chat is about PaneForge if it so much as says the word. So a
// Jarvis chat asking "why does the strip say lane main done?" claimed lane main - which
// meant the Jarvis pane wore a "PF lane main" chip for a chat that had never opened the
// repo, the strip counted it as a chat at work, and three such chats could tell a chat
// that genuinely wanted to edit that every lane was busy. On top of that the lane it was
// handed still carried the previous chat's `ready` mark, so a chat that had done nothing
// read as "done, waiting for the release".
//
// The rule now: a claim from outside the checkout family is TENTATIVE. It still reserves a
// checkout (the agent has to be told where to work before it writes anything), but it is
// invisible to everyone else, it is the first thing given up when a real chat needs a
// lane, it expires by itself, and it becomes a real claim the moment the chat writes in
// the lane. And a `ready` mark on main belongs to the chat that made it, not to the lane.
//
//   node scripts/tentative-lane-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-tentative-lane-test')
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
for (const f of ['lane.mjs', 'test-app.mjs']) copyFileSync(join(here, f), join(repo, 'scripts', f))
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
const laneOf = (session) => Object.entries(state().lanes).find(([, c]) => c.session === session)?.[0]
const statusOf = (id) => JSON.parse(lane('status').out).lanes.find((l) => l.lane === id)
// No release attempts in a repo with no remote: every test below would otherwise spend a
// failed `git push` per command.
const noShip = () => patchState((s) => (s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }))

// ------------------------------------------------------------------ a mention reserves

const mention = JSON.parse(lane('claim', '--session', 'talker', '--cwd', join(root, 'jarvis'), '--tentative').out)
noShip()
ok('a chat that only mentioned PaneForge is still told where its checkout is', Boolean(mention.dir), JSON.stringify(mention))
ok('and the reservation says what it is', mention.tentative === true, JSON.stringify(mention))
ok('the lane file records it as tentative', state().lanes[mention.lane]?.tentative === true)
ok('and so does status, so the app and the hook can leave it out', statusOf(mention.lane).tentative === true)

// ------------------------------------------------------------------ it never blocks anyone

for (const s of ['t2', 't3', 't4']) lane('claim', '--session', s, '--cwd', join(root, s), '--tentative')
ok('four tentative chats fill the pool on paper', Object.keys(state().lanes).length === 4)

const real = lane('claim', '--session', 'worker', '--cwd', repo, '--prefer', 'main')
ok('a chat that actually wants to edit is not refused', real.ok, real.err)
const workerLane = real.ok ? JSON.parse(real.out).lane : null
ok('and its claim is a real one', workerLane && state().lanes[workerLane]?.tentative === undefined)
ok('a tentative reservation was the one given up', Object.values(state().lanes).filter((c) => c.tentative).length === 3)

// ------------------------------------------------------------------ writing makes it real

const stillTentative = Object.entries(state().lanes).find(([, c]) => c.tentative)
const [tid, tclaim] = stillTentative
const tdir = statusOf(tid).dir
const guarded = lane('guard', '--session', tclaim.session, '--path', join(tdir, 'app.js'))
ok('a tentative chat may write in its own lane', guarded.ok, guarded.out)
ok('and writing there turns the reservation into a real claim', state().lanes[tid]?.tentative === undefined)

// ------------------------------------------------------------------ it expires by itself

const [gid, gclaim] = Object.entries(state().lanes).find(([, c]) => c.tentative)
patchState((s) => {
  s.lanes[gid].claimed = Date.now() - 21 * 60 * 1000
  s.lanes[gid].seen = Date.now() - 21 * 60 * 1000
})
lane('status')
ok(
  'a reservation nothing was ever written in disappears on its own',
  state().lanes[gid]?.session !== gclaim.session,
  JSON.stringify(state().lanes[gid])
)

// ------------------------------------------------------------------ "done" belongs to a chat

// The worker finishes on master and its session ends, the way a chat closing a window does.
writeFileSync(join(repo, 'feature.js'), 'export const x = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'a feature')
lane('ready', '--session', 'worker')
noShip()
ok('a chat can mark master done', Boolean(state().ready.main), JSON.stringify(state().ready))
ok('and the mark records who said so', state().ready.main?.session === 'worker')

lane('release', '--session', 'worker')
noShip()
const next = lane('claim', '--session', 'newcomer', '--cwd', repo, '--prefer', 'main')
ok('the next chat gets main back', next.ok && JSON.parse(next.out).lane === 'main', next.err)
ok(
  'and does not inherit the last chat\'s "done" - it has done nothing yet',
  !state().ready.main,
  JSON.stringify(state().ready)
)
ok('the work itself is not lost: master still has the commit to release', statusOf('main').ahead > 0)

// ------------------------------------------------------------------ a lane claimed before

// A lane claimed the old way, by a chat that has done nothing with it, is downgraded the
// next time that chat prompts from outside the checkout family. Without this the lanes
// that were already held when the rule changed kept their chips for an hour.
lane('claim', '--session', 'legacy', '--cwd', join(root, 'elsewhere'))
const legacyLane = laneOf('legacy')
ok('a legacy claim starts as a real hold', state().lanes[legacyLane]?.tentative === undefined)
lane('claim', '--session', 'legacy', '--cwd', join(root, 'elsewhere'), '--tentative')
ok('and an untouched one is downgraded on the next mention', state().lanes[legacyLane]?.tentative === true)
writeFileSync(join(statusOf(legacyLane).dir, 'real.js'), 'export const z = 1\n')
lane('claim', '--session', 'legacy', '--cwd', join(root, 'elsewhere'), '--tentative')
ok('but a lane with work in it is never downgraded', state().lanes[legacyLane]?.tentative === undefined)

console.log(failed ? `\n${failed} failed` : '\nall tentative-lane checks passed')
process.exit(failed ? 1 : 0)
