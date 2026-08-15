/**
 * Two machines, one repository - against a REAL remote.
 *
 * `lane-peers-test.mjs` proves the arithmetic of a claim. This proves the plumbing, which
 * is the half that has actually broken things in this repo before: a name that is perfect
 * and a push that never happened look identical from the pure side. So there is a real
 * bare repo here, two real clones, and the second clone is told it is a different machine
 * (`PF_DEVICE`) - which is the only thing that separates it from being this one.
 *
 * The contract, in the order it is checked:
 *
 *   1. A desk that takes the trunk says so on the remote, in a ref anyone can read.
 *   2. The other desk, claiming afterwards, is sent to a LETTER lane rather than onto the
 *      shared branch - which is the whole bug: an assistant chat on the Mac and one on the
 *      PC, both handed `main`, both pushing the same branch.
 *   3. A letter lane is never coordinated. Two desks holding `lane-a` is two local-only
 *      branches on two disks and must cost no refusal and no ref.
 *   4. A chat ending gives the trunk back at once, not in PEER_STALE_MS.
 *   5. The release lock is decided by the SERVER: two desks pushing the same ref, one
 *      wins, and the loser is told who won rather than cutting a second version.
 *   6. A repo with no origin behaves exactly as it did before any of this existed.
 *
 *   node scripts/lane-device-test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { CLAIM_NS, LOCK_REF } from './lane-peers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LANE = join(here, 'lane.mjs')

let failed = 0
function ok(cond, what) {
  if (cond) console.log(`  ok   ${what}`)
  else {
    failed++
    console.log(`  FAIL ${what}`)
  }
}
function eq(a, b, what) {
  ok(a === b, `${what}${a === b ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`)
}

const root = mkdtempSync(join(tmpdir(), 'pf-device-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Run the real CLI as a named device, in a named checkout. Never throws on a refusal. */
function lane(repo, device, ...args) {
  try {
    const out = execFileSync(process.execPath, [LANE, ...args, '--repo', repo], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PF_DEVICE: device, LANE_REPO: repo }
    })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }
  }
}
function laneJson(repo, device, ...args) {
  const r = lane(repo, device, ...args)
  try {
    return JSON.parse(r.out)
  } catch {
    return { _raw: r.out, _ok: r.ok }
  }
}

// A bare repo playing origin, and two clones playing two desks.
const origin = join(root, 'origin.git')
execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })

const seed = join(root, 'seed')
execFileSync('git', ['clone', origin, seed], { stdio: 'ignore' })
git(seed, 'config', 'user.email', 'test@example.com')
git(seed, 'config', 'user.name', 'test')
writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'peer-fixture', version: '0.0.1' }, null, 2))
// `release: "merge"` is what every repo but PaneForge itself gets, and it is what this
// fixture wants: the point here is the cross-device lock, never cutting a real version.
writeFileSync(join(seed, '.lanes.json'), JSON.stringify({ release: 'merge' }, null, 2))
writeFileSync(join(seed, 'file.txt'), 'seed\n')
git(seed, 'add', '-A')
git(seed, 'commit', '-m', 'seed')
git(seed, 'push', '-u', 'origin', 'main')

const mac = join(root, 'Desk1')
const pc = join(root, 'Desk2')
for (const [dir, who] of [
  [mac, 'desk-one'],
  [pc, 'desk-two']
]) {
  execFileSync('git', ['clone', origin, dir], { stdio: 'ignore' })
  git(dir, 'config', 'user.email', `${who}@example.com`)
  git(dir, 'config', 'user.name', who)
}

const remoteRefs = () =>
  git(origin, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)
const claimRefs = () => remoteRefs().filter((r) => r.startsWith(`${CLAIM_NS}/`))

console.log('\n1. a desk that takes the trunk says so')
{
  const got = laneJson(mac, 'desk-one', 'claim', '--session', 'mac-1')
  eq(got.lane, 'main', 'the first chat gets the trunk, exactly as it always did')
  const refs = claimRefs()
  eq(refs.length, 1, 'and one claim is on the remote')
  ok(refs[0].includes('/desk-one/main/mac-1/'), `the claim names the device, the slot and the session: ${refs[0]}`)
  ok(
    remoteRefs().every((r) => !r.startsWith('refs/heads/lane-')),
    'and no lane branch was pushed - lanes are still local scratch'
  )
}

console.log('\n2. the other desk is not handed the same trunk')
{
  const got = laneJson(pc, 'desk-two', 'claim', '--session', 'pc-1')
  ok(got.lane && got.lane !== 'main', `the second desk gets a letter lane instead of the shared branch (got ${got.lane})`)
  eq(got.branch, `lane-${got.lane}`, 'on its own local branch')
  eq(got.peerTrunk?.device, 'desk-one', 'and it is told WHICH machine has the trunk, not merely that it moved')
  ok(/desk-one/.test(JSON.stringify(got.peerTrunk)), 'by name, so a person can go and look')
  eq(got.sharedTrunk, false, 'nothing is sharing the trunk')

  // What the APP can see of any of this. The lane strip redraws every five seconds from
  // the state file alone - no git, no child process - so before this it could only ever
  // say "a chat has it" about a checkout on the other side of the house. The engine
  // already asked origin to answer the two checks above; the answer is now written down
  // on the way past, which costs no extra request and is the only reason a window with no
  // network budget can name the desk.
  const seen = JSON.parse(readFileSync(join(pc, '.git', 'paneforge-lanes.json'), 'utf8'))
  eq(seen.lanes[got.lane]?.device, 'desk-two', 'a lane record names the desk that claimed it')
  ok(
    (seen.peers?.refs ?? []).some((r) => r.includes('/desk-one/main/mac-1/')),
    'and what the OTHER desk published is cached where the app reads, not thrown away with the process'
  )
}

console.log('\n3. this desk is never blocked by itself, and a letter is never coordinated')
{
  // Re-claiming is the path that runs on EVERY prompt. It must return the same lane and
  // must not start refusing things because a claim of our own is sitting on the remote.
  const again = laneJson(mac, 'desk-one', 'claim', '--session', 'mac-1')
  eq(again.lane, 'main', 'the holder keeps its own trunk')
  eq(again.fresh, false, 'and is recognised rather than re-issued')

  const second = laneJson(pc, 'desk-two', 'claim', '--session', 'pc-2')
  ok(second.lane && second.lane !== 'main', 'a third chat gets another letter')
  const letters = claimRefs().filter((r) => !/\/main\/|\/release\//.test(r))
  eq(letters.length, 0, 'and NO letter lane was ever published - two local branches need no agreement')
}

console.log('\n4. the trunk comes back the moment the chat ends')
{
  lane(mac, 'desk-one', 'release', '--session', 'mac-1')
  eq(claimRefs().length, 0, 'the claim is withdrawn at once, not left to age out for 45 minutes')

  const now = laneJson(pc, 'desk-two', 'claim', '--session', 'pc-3')
  // Desk two's own letters are taken, so with the trunk genuinely free it may have it.
  ok(now.lane, `and the other desk can be handed the trunk again (got ${now.lane})`)
  eq(now.peerTrunk, null, 'with nobody named, because nobody holds it')
}

console.log('\n5. the release lock is decided by the server')
{
  // Exactly what lockToken() builds: an orphan commit over an empty tree, carrying the
  // device's name, so no two machines can produce the same sha.
  const token = (repo, who) => {
    const tree = execFileSync('git', ['mktree'], { cwd: repo, input: '', encoding: 'utf8' }).trim()
    return execFileSync('git', ['commit-tree', tree, '-m', `paneforge release lock ${who}`], {
      cwd: repo,
      input: '',
      encoding: 'utf8'
    }).trim()
  }
  const push = (repo, spec) => {
    try {
      execFileSync('git', ['push', '--quiet', 'origin', spec], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
      return true
    } catch {
      return false
    }
  }

  const one = token(mac, 'desk-one')
  const two = token(pc, 'desk-two')
  ok(one !== two, 'the two desks build different tokens - a shared sha would decide nothing')
  ok(push(mac, `${one}:${LOCK_REF}`), 'one desk takes the lock')
  ok(remoteRefs().includes(LOCK_REF), 'and the ref is on the remote')

  // The whole mechanism. A ref pointing at an unrelated history refuses a plain push, so
  // the SERVER picks the winner and there is no read-then-decide window to lose.
  ok(!push(pc, `${two}:${LOCK_REF}`), 'the other desk cannot take it - the server refuses a non-fast-forward')

  // The version this shipped with first, kept as the control: both desks sit on the same
  // branch tip, and pushing a sha a ref already holds SUCCEEDS. A lock built on the tip
  // therefore hands itself to everybody, which is what this case caught.
  const tip = git(pc, 'rev-parse', 'refs/remotes/origin/main')
  ok(!push(pc, `${tip}:${LOCK_REF}`), 'nor by pushing the branch tip both desks share')
  ok(push(mac, `${one}:${LOCK_REF}`), 'while the holder re-pushing its own token is still a no-op that succeeds')

  ok(push(mac, `:${LOCK_REF}`), 'released')
  ok(!remoteRefs().includes(LOCK_REF), 'the lock is gone')
  ok(push(pc, `${two}:${LOCK_REF}`), 'and the next release, on either desk, may run')
  push(pc, `:${LOCK_REF}`)
}

console.log('\n6. a repo with no origin is untouched')
{
  const solo = join(root, 'solo')
  execFileSync('git', ['init', '-b', 'main', solo], { stdio: 'ignore' })
  git(solo, 'config', 'user.email', 'solo@example.com')
  git(solo, 'config', 'user.name', 'solo')
  writeFileSync(join(solo, 'package.json'), JSON.stringify({ name: 'solo', version: '0.0.1' }, null, 2))
  writeFileSync(join(solo, '.lanes.json'), JSON.stringify({ release: 'none' }, null, 2))
  git(solo, 'add', '-A')
  git(solo, 'commit', '-m', 'seed')

  const got = laneJson(solo, 'desk-one', 'claim', '--session', 'solo-1')
  eq(got.lane, 'main', 'the solo chat gets the trunk with no remote to ask')
  eq(got.peerTrunk, null, 'and nothing was asked of anybody')
  ok(existsSync(join(solo, '.git')), 'the checkout is intact')
}

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed\n` : '\nall good\n')
process.exit(failed ? 1 : 0)
