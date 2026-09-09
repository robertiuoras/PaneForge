// Regression test for "a closed pane gives its lane back, asleep or not" - scripts/lane.mjs
// `closed --pane`.
//
// A sleeping pane's hold is kept on purpose: `sleep` stamps `asleep`, the CLI's SessionEnd
// hook then PARKS instead of releasing, and every sweep leaves it alone for seven days
// (lane-sleep-test.mjs pins all of that). But the pane itself can go while asleep - closed
// by hand, by the idle clock, by the reclaim sweep - and a pane with no agent runs no
// SessionEnd hook on the way out. Nothing ever cleared the mark: measured 2026-09-07, four
// holds (main 23h, a 23h, b 18h, c 17h) parked+asleep from panes long gone, every lane
// reading busy, `release --session` freeing nothing, and a chat hand-editing the ledger to
// get a checkout. `closed` is the app's word that the pane is GONE: the hold goes through
// the ordinary release - committed clean work marked ready, uncommitted work left where it
// is, the checkout handed to the next chat.
//
// RED before `closed` existed: every assertion under "closed frees" fails, because the
// command is unknown and the asleep hold is still in the ledger afterwards.
//
//   node scripts/lane-closed-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-closed-test')
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

const lane = (cwd, ...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}

const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const write = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2))
const holderOf = (session) => Object.entries(state().lanes).find(([, c]) => c.session === session)?.[0]
const folderOf = (id) => (id === 'main' ? repo : join(root, `demo-${id}`))
const stampPane = (id, pane) => {
  const s = state()
  s.lanes[id].pane = pane
  write(s)
}

// -------------------------------------------------------------- two panes, two lanes, both asleep

// The first claim in a fresh repo lands in `main`, where a commit is already on master and
// there is nothing for a release to mark ready - so the pane that stays takes main, and the
// pane that closes takes a letter lane, whose commits master does not have yet.
const KEPT = 'chat-still-sleeping'
const KEPT_PANE = 'pane-still-there'
lane(repo, 'claim', '--session', KEPT)
const KEPT_LANE = holderOf(KEPT)
ok('the staying chat holds a lane', Boolean(KEPT_LANE), JSON.stringify(state().lanes))
stampPane(KEPT_LANE, KEPT_PANE)

const GONE = 'chat-whose-pane-closed'
const GONE_PANE = 'pane-closed'
lane(repo, 'claim', '--session', GONE)
const GONE_LANE = holderOf(GONE)
ok('the closing chat holds a different, letter lane', Boolean(GONE_LANE) && GONE_LANE !== KEPT_LANE && GONE_LANE !== 'main', JSON.stringify(state().lanes))
stampPane(GONE_LANE, GONE_PANE)

// Finished, committed, clean work in the closing pane's lane - the thing a release marks ready.
writeFileSync(join(folderOf(GONE_LANE), 'note.txt'), 'finished feature\n')
git(folderOf(GONE_LANE), 'add', '-A')
git(folderOf(GONE_LANE), 'commit', '-qm', 'done')

lane(repo, 'sleep', '--pane', GONE_PANE)
lane(repo, 'sleep', '--pane', KEPT_PANE)
// The CLI's own SessionEnd hook, as it runs when the app kills the agent for a sleep.
lane(repo, 'release', '--session', GONE)
lane(repo, 'release', '--session', KEPT)
ok('control: after sleep + SessionEnd both holds are parked and asleep',
  typeof state().lanes[GONE_LANE]?.asleep === 'number' && typeof state().lanes[KEPT_LANE]?.asleep === 'number',
  JSON.stringify(state().lanes))

// -------------------------------------------------------------- the pane goes: closed frees

const r = lane(repo, 'closed', '--pane', GONE_PANE)
ok('closed --pane is a command the engine knows', r.ok, r.err || r.out)
ok('closed drops the asleep hold of the pane that went', state().lanes[GONE_LANE] === undefined, JSON.stringify(state().lanes))
ok('its committed clean work is marked ready on the way out', Boolean(state().ready?.[GONE_LANE]), JSON.stringify(state().ready))
ok('the OTHER sleeping pane keeps its lane', state().lanes[KEPT_LANE]?.session === KEPT && typeof state().lanes[KEPT_LANE]?.asleep === 'number',
  JSON.stringify(state().lanes))

// -------------------------------------------------------------- the next chat gets that checkout

const NEXT = 'chat-that-needed-a-lane'
const claimed = JSON.parse(lane(repo, 'claim', '--session', NEXT).out || '{}')
ok('a new claim can land in the freed lane', Boolean(claimed.lane) && claimed.lane !== KEPT_LANE, JSON.stringify(claimed))
{
  const s = state()
  delete s.lanes[claimed.lane]
  write(s)
}

// -------------------------------------------------------------- closed on a pane nobody holds is a no-op

const before = JSON.stringify(state())
const r2 = lane(repo, 'closed', '--pane', 'pane-never-seen')
ok('closed on an unknown pane changes nothing and does not fail', r2.ok && JSON.stringify(state()) === before, r2.err || r2.out)

// -------------------------------------------------------------- closed needs a pane

const r3 = lane(repo, 'closed')
ok('closed without --pane refuses', !r3.ok, r3.out)

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
process.exit(failed ? 1 : 0)
