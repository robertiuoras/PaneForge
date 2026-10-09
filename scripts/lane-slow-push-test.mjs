// Regression test: a release push slower than an ordinary git call is waited for, a push that
// really does run out of time says so, and a push that reported failure is checked against
// origin before anyone is told it failed.
//
// 2026-10-09 3:2xpm on the Mac: `lane.mjs ready --repo ~/Projects/videos` merged lane b (~55 MB
// of mp4 renders) into master, then printed "No release yet: lanes merged into master, but
// origin refused the push: " with nothing after the colon. A later `git push` said "Everything
// up-to-date": origin had it. Every git call had one 20s deadline; the push was killed at 20s,
// the transfer finished without it, and a killed git says nothing, which read as "refused".
//
// Real git, real lane.mjs, a local bare origin, no stubs:
//   1. origin's pre-receive hook takes 24s, past the old 20s deadline: the release must wait
//      for it and report the lane pushed (about 25 seconds);
//   2. the push really does run out of time (the hook deadline cuts it short): the release
//      says it timed out after N s, never "refused" with nothing after it;
//   3. the push reports failure but origin has the commit (a pre-push hook that lands it and
//      then exits 1): the release checks origin and reports the lane pushed;
//   4. a lane marked done WHILE that slow release runs keeps its ready mark when the release
//      finishes, and the next release ships it. The fix above went missing exactly this way
//      (PaneForge lane b, 9 Oct 2026 4:17pm: "another chat is mid-release", then the running
//      release cleared every ready mark, including one it had never seen).
//
//   node scripts/lane-slow-push-test.mjs

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-slow-push-test-' + process.pid)
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
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c', 'd', 'e'], release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
const origin = join(root, 'origin.git')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

const hook = (dir, name, body) => {
  const p = join(dir, 'hooks', name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const baseEnv = { ...process.env }
delete baseEnv.PANEFORGE_HOOK_DEADLINE
const lane = (env, ...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...baseEnv, ...env } }).trim() }
  } catch (e) {
    return { ok: false, out: `${(e.stdout ?? '').toString().trim()}\n${(e.stderr ?? '').toString().trim()}`.trim() }
  }
}
const originMaster = () => git(origin, 'rev-parse', 'refs/heads/master')
// One finished lane per scenario, each a new file so nothing ever conflicts.
const finishLane = (name) => {
  const { dir } = JSON.parse(lane({}, 'claim', '--session', `builder-${name}`, '--prefer', 'a').out)
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', `feat: ${name}`)
  return git(dir, 'rev-parse', 'HEAD')
}
const onOrigin = (sha) => {
  try {
    git(origin, 'merge-base', '--is-ancestor', sha, 'refs/heads/master')
    return true
  } catch {
    return false
  }
}
const waitFor = (cond, ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return cond()
}

// ------------------------------------------- 1. origin takes longer than 20s to accept
// Only the trunk is slow: claims and the release lock are refs with no content, and on a
// real origin they go through as fast as ever.
const slowFor = (s) => `while read old new ref; do [ "$ref" = refs/heads/master ] && sleep ${s}; done; exit 0`
const slow = hook(origin, 'pre-receive', slowFor(24))
const tip1 = finishLane('slow')
const t0 = Date.now()
const one = lane({}, 'ready', '--session', 'builder-slow')
const took = Date.now() - t0
ok(`a 24s push is waited for (${Math.round(took / 1000)}s)`, took >= 24_000, `${took}ms\n${one.out}`)
ok('...the lane is reported pushed', /merged into master and pushed \(lanes a\)/.test(one.out), one.out)
ok('...never as refused', !/refused/.test(one.out), one.out)
ok('...and origin has it', onOrigin(tip1), one.out)

// ------------------------------------------- 2. the push really runs out of time
// The hook deadline is the only deadline a test can make short. Origin takes 30s; the
// release gets 12s in all, so its push is cut off partway.
hook(origin, 'pre-receive', slowFor(30))
const tip2 = finishLane('late')
const two = lane({ PANEFORGE_HOOK_DEADLINE: String(Date.now() + 12_000) }, 'ready', '--session', 'builder-late')
ok('a push cut off at its deadline says it timed out', /timed out after \d+ s/.test(two.out), two.out)
ok('...never "refused" with nothing after it', !/refused the push:\s*$/m.test(two.out) && !/refused/.test(two.out), two.out)
// The cut-off push still lands on origin once its hook ends; let it, so part 3 starts clean.
waitFor(() => onOrigin(tip2), 40_000)
rmSync(slow, { force: true })
git(repo, 'fetch', '-q', 'origin')
// A release cut off by its hook's deadline cannot give the release lock back (every git
// after the deadline refuses to start); the lock clears itself after LOCK_STALE_MS. Clear it
// now rather than wait, so part 3 tests the push and not the lock.
for (const ref of git(origin, 'for-each-ref', '--format=%(refname)', 'refs/paneforge').split('\n').filter(Boolean))
  git(origin, 'update-ref', '-d', ref)

// ------------------------------------------- 3. the push says it failed, origin has it
// The push lands the commit itself and then reports failure: the same state a push killed
// after its upload leaves behind.
hook(
  join(repo, '.git'),
  'pre-push',
  'while read lref lsha rref rsha; do [ "$rref" = refs/heads/master ] && git push --no-verify -q origin "$lsha:$rref" && exit 1; done; exit 0'
)
const tip3 = finishLane('landed')
const three = lane({}, 'ready', '--session', 'builder-landed')
ok('a push that failed but landed is checked against origin', onOrigin(tip3) && /merged into master and pushed \(lanes [ab]\)/.test(three.out), three.out)
ok('...and is not reported as refused', !/refused/.test(three.out), three.out)
ok('...and this machine knows origin has it', git(repo, 'rev-parse', 'refs/remotes/origin/master') === originMaster(), three.out)

// ------------------------------------------- 4. a lane finished while a release is pushing
rmSync(join(repo, '.git', 'hooks', 'pre-push'), { force: true })
hook(origin, 'pre-receive', slowFor(15))
const ledger = () => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
finishLane('first')
const first = spawn(process.execPath, [join(repo, 'scripts', 'lane.mjs'), 'ready', '--session', 'builder-first'], { cwd: repo, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let firstOut = ''
first.stdout.on('data', (d) => (firstOut += d))
first.stderr.on('data', (d) => (firstOut += d))
const firstDone = new Promise((r) => first.on('close', r))
const running = waitFor(() => Boolean(ledger().release), 20_000)
const tip4 = finishLane('second')
const second = lane({}, 'ready', '--session', 'builder-second')
await firstDone
const after = ledger()
ok('(the second lane really was marked done mid-release)', running && /mid-release/.test(second.out), `${second.out}
${firstOut}`)
ok('a lane marked done during a release keeps its ready mark', Object.values(after.ready ?? {}).some((m) => m.commit === tip4), JSON.stringify(after.ready) + `
${firstOut}`)
rmSync(join(origin, 'hooks', 'pre-receive'), { force: true })
const next = lane({}, 'ship', '--session', 'builder-second')
ok('...and the next release ships it', onOrigin(tip4), next.out)

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* a killed push can hold the folder for a few seconds on Windows */
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
