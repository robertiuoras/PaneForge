// Regression test for stuck lanes: work that is finished, will not merge, and belongs
// to a chat that has gone away.
//
// What happened on 2026-07-26: lane b finished a commit, master had changed the same
// files, and the merge failed. The release skipped that lane by name - correctly - and
// then nothing else ever happened. The conflict was only ever mentioned in the text a
// hook prints into whichever chat sent the next prompt, the one chat that could act on
// it had moved on, and the work sat for a day. Nothing in the system could finish it,
// because a lane's conflict was its own chat's job and nobody else's.
//
// Two ways out, both tested here:
//   1. the conflict retries itself whenever master moves, and clears without a human
//      when master stops disagreeing (including when a dead chat left a merge open)
//   2. a conflict whose chat has been quiet long enough can be ADOPTED by any live chat:
//      `resolve --lane b` opens the merge there, the guard lets that chat write in a lane
//      it does not hold, and `ready --lane b` finishes it
//
// Real git repos in the temp folder, real lane.mjs, no stubs. `ship` is never reached:
// a fresh `lastShip` is seeded, so the worst case is the cooldown message.
//
//   node scripts/conflict-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-conflict-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'README.md'), 'one\n')
for (const f of ['lane.mjs', 'test-app.mjs']) copyFileSync(join(here, f), join(repo, 'scripts', f))
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

/** Runs the CLI. Never throws: the failure cases here are exit codes with a message. */
const lane = (...args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const patchState = (fn) => {
  const s = JSON.parse(readFileSync(statePath, 'utf8'))
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const laneOf = (id) => JSON.parse(lane('status').out).lanes.find((l) => l.lane === id)
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

// Two chats: master, and a lane that is about to disagree with it.
JSON.parse(lane('claim', '--session', 'sess-main').out)
const work = JSON.parse(lane('claim', '--session', 'sess-b').out)
patchState((s) => {
  s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }
})

// ------------------------------------------------------------- a conflict is recorded

commit(work.dir, 'README.md', 'from the lane\n', 'lane edit')
commit(repo, 'README.md', 'from master\n', 'master edit')

const readyFail = lane('ready', '--session', 'sess-b')
ok('a lane that cannot merge is refused, by file name', readyFail.code !== 0 && /README\.md/.test(readyFail.err), readyFail.err)
ok('the conflict is recorded against the lane', laneOf(work.lane).conflicted === true)
ok('and it is dated, so it can age', typeof laneOf(work.lane).conflict?.since === 'number')
ok('a fresh conflict belongs to its own chat', laneOf(work.lane).conflict.adoptable === false)

// ------------------------------------------------------------- another chat may not barge in

const tooSoon = lane('resolve', '--session', 'sess-other', '--lane', work.lane)
ok('another chat cannot take a live chat\'s conflict', tooSoon.code !== 0 && /active/.test(tooSoon.err), tooSoon.err)

// ------------------------------------------------------------- ...until that chat goes quiet

patchState((s) => {
  s.lanes[work.lane].seen = Date.now() - 46 * 60 * 1000
})
ok('a conflict whose chat went quiet is adoptable', laneOf(work.lane).conflict.adoptable === true)

const adopt = lane('resolve', '--session', 'sess-other', '--lane', work.lane)
ok('it can be adopted, and the merge is opened', adopt.code === 0 && /README\.md/.test(adopt.out), adopt.out || adopt.err)
const merging = (cwd) => {
  try {
    return git(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').length > 0
  } catch {
    return false
  }
}
ok('git agrees there is a merge to finish', merging(work.dir))
ok('and it is open in the lane, never in the main checkout', !merging(repo))

// The guard is what makes adoption real rather than advice.
const allowed = lane('guard', '--session', 'sess-other', '--path', join(work.dir, 'README.md'))
ok('the adopting chat may write in that lane', allowed.code === 0, allowed.out)
const refused = lane('guard', '--session', 'sess-nobody', '--path', join(work.dir, 'README.md'))
ok('everyone else still may not', refused.code === 2, refused.out)

// Resolve it the way a chat would, then finish the lane it does not hold.
commit(work.dir, 'README.md', 'from master, and the lane\n', 'resolve the merge')
const done = lane('ready', '--session', 'sess-other', '--lane', work.lane)
ok('the adopting chat can mark that lane done', done.code === 0 && /marked done/.test(done.out), done.out || done.err)
ok('the lane is no longer conflicted', laneOf(work.lane).conflicted === false)
ok('and its work is queued for the release', laneOf(work.lane).ready === true)

// ------------------------------------------------------------- conflicts that fix themselves

const solo = JSON.parse(lane('claim', '--session', 'sess-gone').out)
ok('a third chat gets its own lane', solo.lane !== work.lane && solo.lane !== 'main', solo.lane)
commit(solo.dir, 'shared.txt', 'lane version\n', 'lane adds a file')
commit(repo, 'shared.txt', 'master version\n', 'master adds the same file')

const stuck = lane('ready', '--session', 'sess-gone')
ok('the second lane is stuck too', stuck.code !== 0 && laneOf(solo.lane).conflicted === true, stuck.err)

// That chat now disappears, leaving the merge open - the state nothing could recover from.
patchState((s) => {
  s.lanes[solo.lane].seen = Date.now() - 46 * 60 * 1000
})
// Master stops disagreeing: the change it conflicted with is taken back out.
git(repo, 'rm', '-q', 'shared.txt')
git(repo, 'commit', '-qm', 'master drops the file')

const auto = lane('autoship')
ok('the abandoned merge is cleared up and the conflict clears itself', laneOf(solo.lane).conflicted === false, auto.out)
ok('the work that was stuck is queued for the release', laneOf(solo.lane).ready === true, auto.out)
ok(
  'and the lane really does hold its own version of the file',
  readFileSync(join(solo.dir, 'shared.txt'), 'utf8').trim() === 'lane version'
)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
