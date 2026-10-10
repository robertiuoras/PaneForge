/**
 * A chat ending must not start a second release beside its own running one.
 *
 * 2026-10-09, PaneForge on the Windows PC: a chat ran `lane.mjs autoship --session <its id>`
 * in a background shell, which outlives `/clear`. The suite went green at 10:54:01 and the
 * release began pushing master; the chat cleared at 10:54:11, and SessionEnd ran
 * `lane.mjs release --session <the same id>`. `releaseClaim` dropped every claim that
 * session had published - including the release claim beside the cross-device lock, which
 * made the lock read as abandoned - cleared `state.release` because the session matched,
 * and started its own release. Two pushes of master raced: GitHub refused one with
 * "[remote rejected] master -> master (failed)" (the running release, which then reported
 * "origin refused the push") and took the other at 10:54:34. In a repo that cuts versions
 * the same race is two versions.
 *
 * The contract:
 *   1. While the process that started a release lives, the chat ending leaves its marker
 *      and its release claim alone (so the lock still reads as held) and starts nothing.
 *      The chat's other claims are still given back at once.
 *   2. A release whose process is gone is cleared exactly as before.
 *
 *   node scripts/lane-release-running-test.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAIM_NS, LOCK_REF, RELEASE_SLOT, claimRef, lockIsStale } from './lane-peers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const LANE = join(here, 'lane.mjs')
const DEVICE = 'desk-one'

let failed = 0
function ok(cond, what) {
  if (cond) console.log(`  ok   ${what}`)
  else {
    failed++
    console.log(`  FAIL ${what}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'pf-release-running-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function lane(...args) {
  try {
    const out = execFileSync(process.execPath, [LANE, ...args, '--repo', desk], {
      cwd: desk,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PF_DEVICE: DEVICE, LANE_REPO: desk }
    })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }
  }
}

const origin = join(root, 'origin.git')
execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
const seed = join(root, 'seed')
execFileSync('git', ['clone', origin, seed], { stdio: 'ignore' })
git(seed, 'config', 'user.email', 'test@example.com')
git(seed, 'config', 'user.name', 'test')
writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'release-running', version: '0.0.1' }, null, 2))
writeFileSync(join(seed, '.lanes.json'), JSON.stringify({ release: 'merge' }, null, 2))
writeFileSync(join(seed, 'file.txt'), 'seed\n')
git(seed, 'add', '-A')
git(seed, 'commit', '-m', 'seed')
git(seed, 'push', '-u', 'origin', 'main')

const desk = join(root, 'Desk')
execFileSync('git', ['clone', origin, desk], { stdio: 'ignore' })
git(desk, 'config', 'user.email', 'desk@example.com')
git(desk, 'config', 'user.name', 'desk')

const ledgerPath = join(desk, '.git', 'paneforge-lanes.json')
const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'))
const remoteRefs = () => git(origin, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)
const claimsOf = (session) => remoteRefs().filter((r) => r.startsWith(`${CLAIM_NS}/`) && r.includes(`/${session}/`))

/** What `ship` leaves behind while it runs: the lock, its claim, and the local marker. */
function releaseInFlight(session, pid) {
  const tree = execFileSync('git', ['mktree'], { cwd: desk, input: '', encoding: 'utf8' }).trim()
  const token = execFileSync('git', ['commit-tree', tree, '-m', `paneforge release lock ${DEVICE} test`], {
    cwd: desk,
    input: '',
    encoding: 'utf8'
  }).trim()
  git(desk, 'push', '--quiet', '--force', 'origin', `${token}:${LOCK_REF}`)
  const tip = git(desk, 'rev-parse', 'HEAD')
  git(desk, 'push', '--quiet', 'origin', `${tip}:${claimRef({ device: DEVICE, slot: RELEASE_SLOT, session, at: Date.now() })}`)
  const s = ledger()
  s.release = { session, at: Date.now(), pid }
  writeFileSync(ledgerPath, JSON.stringify(s, null, 2))
}

console.log('\n1. the chat ends while its own release is still running')
{
  const got = lane('claim', '--session', 's1')
  ok(/"lane":\s*"main"/.test(got.out), `the chat holds the trunk (${got.out.slice(0, 80)})`)
  // This test process stands in for the background `autoship`: alive for the whole check.
  releaseInFlight('s1', process.pid)

  const r = lane('release', '--session', 's1')
  const after = ledger()
  ok(after.release?.session === 's1', `the running release keeps its marker (got ${JSON.stringify(after.release)})`)
  ok(
    claimsOf('s1').some((ref) => ref.includes(`/${RELEASE_SLOT}/`)),
    'and its release claim stays on the remote'
  )
  ok(remoteRefs().includes(LOCK_REF), 'the lock is still there')
  ok(!lockIsStale(remoteRefs(), { now: Date.now() }), 'and reads as held, so no second release can take it')
  ok(!claimsOf('s1').some((ref) => ref.includes('/main/')), 'the chat still gives back its trunk claim at once')
  ok(!/released|merged into/i.test(r.out), `and nothing was released on the way out (said: ${r.out.slice(0, 160)})`)
}

console.log('\n2. a release whose process is gone is cleared as before')
{
  lane('claim', '--session', 's2')
  const gone = spawnSync(process.execPath, ['-e', '0']).pid
  releaseInFlight('s2', gone)

  lane('release', '--session', 's2')
  const after = ledger()
  ok(after.release == null, `the dead release's marker is cleared (got ${JSON.stringify(after.release)})`)
  ok(claimsOf('s2').length === 0, 'and every claim the chat published is withdrawn')
}

// 2026-10-10 12:13am Sat: a `ready` stopped mid-suite (its process killed) left its marker,
// and every other chat's release then read "another chat is mid-release" until the marker
// aged out twenty minutes later. A dead process can never clear its own marker.
console.log('\n3. another chat is not held by a release whose process is gone')
{
  const mark = (session, pid) => {
    const s = ledger()
    s.release = { session, at: Date.now(), pid }
    writeFileSync(ledgerPath, JSON.stringify(s, null, 2))
  }
  mark('s3', process.pid)
  const held = lane('autoship', '--session', 's4')
  ok(/mid-release/.test(held.out), `a live release still holds another chat's (said: ${held.out.slice(0, 120)})`)
  ok(ledger().release?.session === 's3', 'and keeps its marker')

  mark('s3', spawnSync(process.execPath, ['-e', '0']).pid)
  const free = lane('autoship', '--session', 's4')
  ok(!/mid-release/.test(free.out), `a dead one does not (said: ${free.out.slice(0, 120)})`)
  lane('status')
  ok(ledger().release?.session !== 's3', `and \`status\` throws its marker away (got ${JSON.stringify(ledger().release)})`)
}

// Same cleanup as lane-device-test.mjs: a transient Windows handle on the temp dir is noise
// about disk cleanup, never the assertions above.
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
} catch (e) {
  console.log(`\n(cleanup: could not remove ${root}: ${e.message})`)
}
console.log(failed ? `\n${failed} failed` : '\nall ok')
process.exit(failed ? 1 : 0)
