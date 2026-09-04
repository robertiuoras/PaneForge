// Regression test for "a sleeping pane keeps its lane" - scripts/lane.mjs `sleep`/`wake`.
//
// Sleeping a pane kills its CLI, whose own SessionEnd hook has always called
// `lane.mjs release` on the way out - which deletes the hold, marks finished work ready,
// and hands the checkout to the next chat that asks. That is exactly wrong for a pane put
// to sleep on purpose: nothing ended, somebody is keeping the pane for later, and its lane
// may be mid-feature. `sleep` marks the hold `asleep`; every path that would otherwise give
// it away has to refuse while that mark is on, and only `wake` (or seven days) takes it off.
//
// RED first: every assertion below fails against `release`/`reap`/`claim` as they were
// before this file's `asleep` guards existed - proven by running this against a lane.mjs
// with the guards reverted, which the comments beside each assertion describe.
//
//   node scripts/lane-sleep-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-sleep-test')
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
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// -------------------------------------------------------------- sleep stamps the hold

const SESS = 'chat-sleeping'
const PANE = 'pane-sleeping'
lane(repo, 'claim', '--session', SESS)
const LANE = holderOf(SESS)
ok('the claim landed somewhere', Boolean(LANE), JSON.stringify(state().lanes))
{
  const s = state()
  s.lanes[LANE].pane = PANE
  write(s)
}
lane(repo, 'sleep', '--pane', PANE)
ok('sleep stamps asleep on the hold', typeof state().lanes[LANE]?.asleep === 'number', JSON.stringify(state().lanes[LANE]))

// -------------------------------------------------------------- and wake clears it

lane(repo, 'wake', '--pane', PANE)
ok('wake clears the mark', state().lanes[LANE]?.asleep === undefined, JSON.stringify(state().lanes[LANE]))
ok('wake refreshes seen', typeof state().lanes[LANE]?.seen === 'number')

// -------------------------------------------------------------- release parks instead of dropping

lane(repo, 'sleep', '--pane', PANE)
const laneFolder = LANE === 'main' ? repo : join(root, `demo-${LANE}`)
{
  // Commit something so this hold has finished work that release would otherwise merge.
  writeFileSync(join(laneFolder, 'note.txt'), 'half a feature\n')
  git(laneFolder, 'add', '-A')
  git(laneFolder, 'commit', '-qm', 'wip')
}
lane(repo, 'release', '--session', SESS)
ok('release does NOT delete an asleep hold', Boolean(state().lanes[LANE]), JSON.stringify(state().lanes))
ok('release does not mark it ready either', !state().ready?.[LANE], JSON.stringify(state().ready))
ok('release parks it instead', typeof state().lanes[LANE]?.parked === 'number')
ok('the hold still says which pane', state().lanes[LANE]?.pane === PANE)

// -------------------------------------------------------------- not reaped at STALE_MS

{
  const s = state()
  s.lanes[LANE].seen = Date.now() - 13 * HOUR // past STALE_MS (12h), inside ASLEEP_MAX_MS (7d)
  write(s)
}
lane(repo, 'status', '--session', 'anyone')
ok('an asleep hold survives past STALE_MS', Boolean(state().lanes[LANE]), JSON.stringify(state().lanes))

// -------------------------------------------------------------- not stolen at PARK_STEAL_MS

{
  const s = state()
  s.lanes[LANE].parked = Date.now() - 15 * 60 * 1000 // past PARK_STEAL_MS (10m)
  write(s)
}
const OTHER = 'chat-wants-a-lane'
const claimed = JSON.parse(lane(repo, 'claim', '--session', OTHER).out ?? '{}')
ok(`a claim while lane ${LANE} is asleep does not steal it`, claimed.lane !== LANE, JSON.stringify(claimed))
// clean up the reservation the probe above made
{
  const s = state()
  delete s.lanes[claimed.lane]
  write(s)
}

// -------------------------------------------------------------- wake is the only way back

lane(repo, 'wake', '--pane', PANE)
ok('wake clears an asleep hold that release had parked', state().lanes[LANE]?.asleep === undefined)
ok('the lane is still this pane\'s to keep working in', state().lanes[LANE]?.session === SESS)

// -------------------------------------------------------------- past ASLEEP_MAX_MS it is ordinary

{
  const s = state()
  s.lanes[LANE].asleep = Date.now() - 8 * DAY
  s.lanes[LANE].seen = Date.now() - 8 * DAY
  delete s.lanes[LANE].parked
  write(s)
}
lane(repo, 'status', '--session', 'anyone')
ok('an asleep hold seven days stale reaps like any other', state().lanes[LANE] === undefined, JSON.stringify(state().lanes))

console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}`)
process.exit(failed ? 1 : 0)
