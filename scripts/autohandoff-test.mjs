// Moving a finished pane to a paired device when this machine is out of room.
//
// As with reclaim-test, the refusals are the file. This is more destructive than reclaim
// (it kills a pty rather than trimming a buffer) so the weight is on every case that must
// never move: a pane on screen, one already moving, one mid-turn, one holding a live
// question - and the queue that must GIVE UP rather than force a mid-turn pane across.
//
//   node scripts/autohandoff-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-autohandoff-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'autohandoff.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/autoHandoff.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { autoHandoffPlan, hostFor, movable, queueVerdict, queuedNote, DEFAULT_AUTO_HANDOFF } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, JSON.stringify(a) === JSON.stringify(b), a)

const NOW = 1_000_000_000
const MIN = 60_000

const over = { level: 'over', usedMb: 2530, nextPaneMb: 197, roomFor: null, trim: true, offload: true, advice: '' }
const ok = { ...over, level: 'ok' }

const pane = (o) => ({
  id: 'p',
  state: 'ready',
  lastKeyboard: NOW - 20 * MIN,
  focused: false,
  visible: false,
  remote: false,
  handingOff: false,
  asking: false,
  projectName: 'proj',
  ...o
})
const ids = (plan) => plan.map((p) => p.id).join(',')

const peers = [{ device: 'pc', deviceName: 'PC', online: true, projects: [{ name: 'proj', path: '/pc/proj' }] }]

{
  // Only when the policy says so - a machine with room keeps its own panes, however many
  // peers are up.
  const panes = [pane({ id: 'a' }), pane({ id: 'b' })]
  eq('level ok moves nothing, whatever the peers', autoHandoffPlan(panes, ok, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)
  const manyPeers = [...peers, { device: 'phone', deviceName: 'Phone', online: true, projects: [{ name: 'proj', path: '/ph' }] }]
  eq('still nothing with two peers online', autoHandoffPlan(panes, ok, manyPeers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)
}

{
  // The refusals, one at a time - each paired with a plain 'keep' pane so the last-pane
  // rule (below) never masks the case being tested.
  const cases = [
    ['the focused pane', { focused: true }],
    ['a pane on screen', { visible: true }],
    ["another device's mirrored pty", { remote: true }],
    ['a pane already on its way', { handingOff: true }]
  ]
  for (const [label, extra] of cases) {
    const panes = [pane({ id: 'x', ...extra }), pane({ id: 'keep' })]
    eq(`never moves ${label}`, ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
  }

  for (const state of ['working', 'starting', 'stalled']) {
    const panes = [pane({ id: 'x', state }), pane({ id: 'keep' })]
    eq(`never moves a pane that is ${state}`, ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
  }

  // The one state where `asking` flips the meaning: a live question drawn on screen must
  // never be moved, even though `needsYou` is otherwise the best moment to move a pane.
  {
    const panes = [pane({ id: 'x', state: 'needsYou', asking: true }), pane({ id: 'keep' })]
    eq('never moves a needsYou pane holding a live question', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
  }

  {
    const panes = [pane({ id: 'x', lastKeyboard: NOW - 5 * MIN }), pane({ id: 'keep' })]
    eq('never moves a pane quieter than minIdleMinutes for less time than that', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
  }

  {
    const panes = [pane({ id: 'x' }), pane({ id: 'keep' })]
    const blocked = { x: NOW + 1000 }
    eq('never retries a pane still in its cooldown', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, blocked, NOW)), 'keep')
  }
}

{
  // The last-pane rule: an app that empties itself onto another machine has not helped.
  const one = [pane({ id: 'only' })]
  eq('never the last pane', autoHandoffPlan(one, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)
  const two = [pane({ id: 'a', lastKeyboard: NOW - 30 * MIN }), pane({ id: 'b', lastKeyboard: NOW - 20 * MIN })]
  const plan = autoHandoffPlan(two, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)
  eq('one of two movable panes is moved, not both', plan.length, 1)
  eq('the quieter one goes', plan[0].id, 'a')
}

{
  // The load-bearing positive: a turn that just ended is the ordinary case this exists for.
  check('needsYou with no live question is movable', movable({ state: 'needsYou', asking: false }) === true)
  const panes = [pane({ id: 'a', state: 'needsYou', asking: false, lastKeyboard: NOW - 30 * MIN }), pane({ id: 'keep' })]
  eq('and autoHandoffPlan really moves it', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'a')
}

{
  // Only an online peer, and only one that calls the project by the same name.
  const offline = [{ device: 'pc', deviceName: 'PC', online: false, projects: [{ name: 'proj', path: '/pc/proj' }] }]
  eq('an offline peer is never a host', hostFor(offline, 'proj'), null)
  const wrongProject = [{ device: 'pc', deviceName: 'PC', online: true, projects: [{ name: 'other', path: '/pc/other' }] }]
  eq('a peer holding a different project returns null', hostFor(wrongProject, 'proj'), null)
  eq('an online peer with the same project name is the host', hostFor(peers, 'proj'), {
    device: 'pc',
    deviceName: 'PC',
    cwd: '/pc/proj'
  })
  eq('no project name is never hosted', hostFor(peers, ''), null)
}

{
  const panes = [
    pane({ id: 'a', lastKeyboard: NOW - 40 * MIN }),
    pane({ id: 'b', lastKeyboard: NOW - 30 * MIN }),
    pane({ id: 'c', lastKeyboard: NOW - 20 * MIN }),
    pane({ id: 'd', lastKeyboard: NOW - 10 * MIN })
  ]
  eq(
    'maxPerSweep caps how many move at once',
    autoHandoffPlan(panes, over, peers, { ...DEFAULT_AUTO_HANDOFF, maxPerSweep: 1 }, {}, NOW).length,
    1
  )
}

{
  // The queue: a pane asked for mid-turn, moved the instant its turn ends.
  const q = { id: 'x', device: 'pc', since: NOW }
  eq('still working: wait', queueVerdict(q, { state: 'working', asking: false }, DEFAULT_AUTO_HANDOFF, NOW), 'wait')
  eq('holding a live question: wait, not go', queueVerdict(q, { state: 'needsYou', asking: true }, DEFAULT_AUTO_HANDOFF, NOW), 'wait')
  eq('turn ended: go', queueVerdict(q, { state: 'needsYou', asking: false }, DEFAULT_AUTO_HANDOFF, NOW), 'go')

  const pastBudget = NOW + (DEFAULT_AUTO_HANDOFF.waitMinutes + 1) * MIN
  const expired = queueVerdict(q, { state: 'working', asking: false }, DEFAULT_AUTO_HANDOFF, pastBudget)
  eq('past the wait budget while still busy: expired', expired, 'expired')
  check('expiry is never treated as "move it anyway"', expired !== 'go')

  eq('the pane closed while queued: drop', queueVerdict(q, undefined, DEFAULT_AUTO_HANDOFF, NOW), 'drop')
  eq('the pane exited on its own while queued: drop', queueVerdict(q, { state: 'exited', asking: false }, DEFAULT_AUTO_HANDOFF, NOW), 'drop')

  check('the waiting note names the device', queuedNote('PC').includes('PC'))
}

console.log(`autohandoff: ${checks} checks passed`)
