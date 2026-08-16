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
const held = () => new Set(Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).lanes))
const patchState = (fn) => {
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}

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

// ---------------------------------------------------------------- a preference does not beat a squat

// A preference exists to protect work in the folder a chat is standing in. A folder ANOTHER
// chat is standing in protects nothing - honouring it just moves the collision one lane over.
// (Adversarial review of the first version of this fix, 2026-08-16: the prefer branch was
// checked before the squat filter and went straight past it.)
release('s3')
const s3b = claim('s3b', laneDir('a'), 'a') // asks for the lane s2's shell is still in
ok('a squatted preference is refused while anything else is free', s3b.lane !== 'a', JSON.stringify(s3b.lane))
ok('and the chat is told where it is really standing', s3b.standingIn === 'a', JSON.stringify(s3b.standingIn))
release('s3b')

// A lane marked ready is a worse place to land than a clean one - but a SQUATTED clean lane
// is worse than both, because it is two chats in one folder rather than one odd-looking
// prompt. Unsquatted always wins, whatever else is true of it.
const ready = ['b', 'c'].find((id) => !held().has(id))
patchState((s) => {
  s.ready[ready] = { at: Date.now(), by: 'someone' }
})
const s3c = claim('s3c', join(root, 'elsewhere'))
ok('a ready-but-unsquatted lane is taken before a clean squatted one', s3c.lane === ready, JSON.stringify(s3c.lane))
release('s3c')
patchState((s) => {
  delete s.ready[ready]
})

// ---------------------------------------------------------------- a conflict is never handed out

// A ready lane is a soft cost; a CONFLICTED one is the single state CLAUDE.md says no other
// chat may touch, and it was reachable with no holder at all. `releaseClaim` calls
// `noteConflict` and then deletes the lane, and `reap` only clears a conflict whose branch
// is no longer ahead of master - which a real conflict is - so the record outlives the chat.
// The chooser's second tier then tested only for a squat, so "anything unsquatted wins"
// promoted the conflicted lane over every clean squatted one. (Adversarial review of the
// squat fix, 2026-08-16: the tier that lost the conflict check was the one this file added.)
const stuck = ['b', 'c'].find((id) => !held().has(id))
const stuckOwner = claim('stuckowner', laneDir(stuck), stuck)
ok('the lane about to be conflicted was actually claimed', stuckOwner.lane === stuck, JSON.stringify(stuckOwner))
// A REAL conflict, not a recorded one: `claim` runs `retryConflicts` first, so a record
// whose merge would now succeed is resolved and handed out - correctly. Both sides have to
// touch the same line for the record to survive the retry.
writeFileSync(join(laneDir(stuck), 'app.js'), 'console.log("lane")\n', 'utf8')
git(laneDir(stuck), 'add', '-A')
git(laneDir(stuck), 'commit', '-qm', 'work that does not merge')
writeFileSync(join(repo, 'app.js'), 'console.log("master")\n', 'utf8')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'master moved the same line')
// Exactly the state `releaseClaim` leaves behind: a conflict recorded, the holder gone,
// and a lane branch still ahead of master so nothing reaps the record.
patchState((s) => {
  delete s.lanes[stuck]
  s.conflicts[stuck] = { at: Date.now(), since: Date.now(), detail: 'conflicts with master', by: 'stuckowner' }
})
const c1 = claim('c1', join(root, 'elsewhere'))
ok('a conflicted lane is not handed to the next chat', c1.lane !== stuck, JSON.stringify(c1))
release('c1')
const c2 = claim('c2', laneDir(stuck), stuck) // and asking for it BY NAME does not get it either
ok('a conflicted lane is refused even when asked for by name', c2.lane !== stuck, JSON.stringify(c2))
release('c2')
// Put the lane back to an ordinary one for the sections below: the branch stops diverging,
// so nothing re-records the conflict on the next claim.
git(laneDir(stuck), 'reset', '--hard', 'master')
patchState((s) => {
  delete s.conflicts[stuck]
})

// ---------------------------------------------------------------- it is a reorder, not a ban

// Everything but the squatted lane is taken: a chat still gets a checkout rather than a
// refusal, because no checkout at all is worse than a shared one - and it is told.
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
