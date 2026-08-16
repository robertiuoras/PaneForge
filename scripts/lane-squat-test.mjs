// Regression test for handing out a lane whose FOLDER another chat is standing in.
//
// The bug this exists for, measured on `assistant` 2026-08-16. Chat 0ea5827a was sitting in
// `assistant-a`, asked for lane a, and was refused because another chat held it - so it was
// given lane b. Nothing moves a running shell, so it carried on standing in `assistant-a`.
// When the chat holding lane a went away, the next chat was handed lane a and told, in
// prose, to work in `assistant-a` - the folder somebody else was still standing in. Two
// chats, one worktree, each told the folder was theirs. Robert's words: "very confused ...
// i still think there may be conflicts".
//
// Two halves to the fix, both checked here:
//   1. `claim` treats a lane whose folder another hold's `cwd` is inside as the LAST one to
//      hand out - a reorder, never a refusal, because no checkout at all is worse.
//   2. `claim` returns `standingIn`, the lane this chat's shell is really in when that is
//      not the lane it holds, so the hook can say so instead of the roster hinting at it.
//
//   node scripts/lane-squat-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-squat-test')
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
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const statePath = join(repo, '.git', 'paneforge-lanes.json')
const laneDir = (id) => (id === 'main' ? repo : `${repo}-${id}`)

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
const claim = (session, cwd, prefer) => {
  const r = lane('claim', '--session', session, '--cwd', cwd, ...(prefer ? ['--prefer', prefer] : []))
  if (!r.ok) return { lane: null, err: r.err }
  try {
    return JSON.parse(r.out)
  } catch {
    return { lane: null, err: r.out }
  }
}
const release = (session) => lane('release', '--session', session)

// ---------------------------------------------------------------- the real sequence

const s0 = claim('s0', repo) // the repo's own chat, in the main checkout
ok('a chat in the main checkout gets main', s0.lane === 'main', JSON.stringify(s0))
ok('and is not reported as standing anywhere else', s0.standingIn === null, JSON.stringify(s0.standingIn))

const s1 = claim('s1', laneDir('a'), 'a')
ok('a chat in <repo>-a gets lane a', s1.lane === 'a', JSON.stringify(s1))
ok('a chat in its own lane is not squatting', s1.standingIn === null, JSON.stringify(s1.standingIn))

// The chat whose preference is refused. It keeps standing where it is - that is the bug.
const s2 = claim('s2', laneDir('a'), 'a')
ok('a second chat in <repo>-a is refused lane a and gets another', s2.lane !== 'a' && s2.lane, JSON.stringify(s2))
ok('and is TOLD it is standing in lane a', s2.standingIn === 'a', JSON.stringify(s2.standingIn))

// Lane a is free again, but s2's shell is still in that folder.
release('s1')
const s3 = claim('s3', join(root, 'elsewhere'))
ok('the next chat is NOT handed the squatted lane a', s3.lane !== 'a', JSON.stringify(s3))
ok('it gets a free unsquatted lane instead', ['b', 'c'].includes(s3.lane), JSON.stringify(s3.lane))

// ---------------------------------------------------------------- the repo root is not a squat

// Nearly every chat opens in the repository itself and is handed a letter lane; treating
// that as squatting would mark `main` - the one lane with no worktree to pay for - unsafe
// in almost every session, and warn about it every prompt until the words stopped being
// read. The write guard already refuses an edit in a checkout a chat does not hold.
const root2 = claim('rootchat', repo) // main is held by s0, so this one gets a letter lane
ok('a chat in the repo root is handed a letter lane', root2.lane && root2.lane !== 'main', JSON.stringify(root2.lane))
ok('and holding it from the repo root is not squatting', root2.standingIn === null, JSON.stringify(root2.standingIn))
release('rootchat')

// ---------------------------------------------------------------- it is a reorder, not a ban

// Everything but the squatted lane is taken: a chat still gets a checkout rather than a
// refusal, because no checkout at all is worse than a shared one - and it is told.
const held = () => new Set(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).lanes))
let fill = 0
for (const id of ['main', 'b', 'c']) if (!held().has(id)) claim(`filler${fill++}`, laneDir(id), id)
ok('everything except the squatted lane is now held', [...held()].sort().join('') === 'bcmain', [...held()].join(','))
const s4 = claim('s4', join(root, 'elsewhere'))
ok('with nothing else free, the squatted lane IS handed out', s4.lane === 'a', JSON.stringify(s4))

// And once the squatter is gone, lane a is an ordinary lane again.
release('s2')
release('s4')
const s5 = claim('s5', join(root, 'elsewhere'))
ok('once the squatter leaves, lane a is handed out normally', s5.lane === 'a', JSON.stringify(s5))

// ---------------------------------------------------------------- subdirectories count

release('s5')
const s6 = claim('s6', join(laneDir('a'), 'scripts', 'deep'))
ok('a chat in a SUBDIRECTORY of a lane is placed in that lane', s6.lane === 'a', JSON.stringify(s6))
ok('and is not called a squatter for it', s6.standingIn === null, JSON.stringify(s6.standingIn))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
