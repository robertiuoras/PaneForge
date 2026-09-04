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
const {
  autoHandoffPlan,
  idleOffloadPlan,
  hostFor,
  movable,
  queueable,
  queueVerdict,
  queuedNote,
  offloadMinutes,
  expensive,
  paneCost,
  DEFAULT_AUTO_HANDOFF,
  IDLE_OFFLOAD_MINUTES,
  staysHere,
  suggestMove,
  budgetPlan,
  endsOnArrival
} = createRequire(import.meta.url)(outfile)

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

  // What an AGENT left running in the background is a REFUSAL here, not another `job`.
  // `job` means "worth moving" - a dev server that just started costs nothing yet and is
  // the pane to move. A background job is the opposite: the move kills the pty and starts
  // a fresh pane on the other machine, so a build three minutes into twenty dies with it,
  // and unlike a turn there is no boundary to queue behind. Robert, 2026-08-27: "it
  // shouldnt close or clear mid build".
  check(
    'a pane with a background job is not movable',
    movable({ state: 'ready', asking: false, backJob: 'npm run build' }) === false
  )
  check(
    '...and it is not queueable either, because nothing will announce that it finished',
    queueable({ state: 'working', asking: false, backJob: 'npm run build' }) === false
  )
  check(
    'control - the same pane with nothing running is movable',
    movable({ state: 'ready', asking: false }) === true
  )
  check(
    'control - a FINISHED pane with nothing running is queueable',
    queueable({ state: 'ready', asking: false }) === true
  )
  // Since 2026-09-04 a pane mid-turn is not queued at all: the queue is for a pane that
  // goes quiet between the decision and the move, and arming on a chat with a prompt
  // running is what moved one out from under its own turn.
  check(
    '...and a pane mid-turn is not, whatever else is true of it',
    queueable({ state: 'working', asking: false }) === false
  )
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

{
  // The clock: the only sweep that can fire on a single-window desk, and therefore the one
  // whose refusals carry the weight. `visible` is the ONE gate it drops.
  const on = { ...DEFAULT_AUTO_HANDOFF, offloadIdleMinutes: IDLE_OFFLOAD_MINUTES }
  const quiet = NOW - (IDLE_OFFLOAD_MINUTES + 5) * MIN

  // ON by default since 2026-08-28 - Robert wants the work on the PC - so the default is
  // now asserted as firing, and the OFF case is the zero somebody sets by hand.
  eq(
    'on by default, at half the sleep clock, so a quiet pane is offered before it sleeps here',
    ids(idleOffloadPlan([pane({ id: 'x', lastKeyboard: quiet }), pane({ id: 'y' })], peers, DEFAULT_AUTO_HANDOFF, {}, NOW)),
    'x'
  )
  eq('...at fifteen minutes', IDLE_OFFLOAD_MINUTES, 15)
  eq(
    'zero is how it is turned off, and it beats the clock',
    idleOffloadPlan([pane({ id: 'x', lastKeyboard: quiet }), pane({ id: 'y' })], peers, { ...on, offloadIdleMinutes: 0 }, {}, NOW).length,
    0
  )
  eq(
    'enabled:false beats the clock',
    idleOffloadPlan([pane({ id: 'x', lastKeyboard: quiet }), pane({ id: 'y' })], peers, { ...on, enabled: false }, {}, NOW).length,
    0
  )

  // The whole point: the pressure sweep refuses this pane and the clock takes it. Asserted
  // as a PAIR, because either half alone would pass while the feature stayed dead.
  {
    const panes = [pane({ id: 'x', visible: true, lastKeyboard: quiet }), pane({ id: 'keep' })]
    eq(
      'the pressure sweep still refuses a pane on screen',
      ids(autoHandoffPlan(panes, over, peers, on, {}, NOW)),
      'keep'
    )
    eq('the clock moves a pane on screen, which is the only reason it exists', ids(idleOffloadPlan(panes, peers, on, {}, NOW)), 'x')
  }

  // ...and pressure is not consulted at all: `ok` is the reading on the desk that is merely
  // busy, which is exactly when the lag is felt.
  eq(
    'a machine with room still offloads on the clock',
    ids(idleOffloadPlan([pane({ id: 'x', visible: true, lastKeyboard: quiet }), pane({ id: 'keep' })], peers, on, {}, NOW)),
    'x'
  )

  // Every other refusal, verbatim. A regression in any of these is work moved off a desk
  // somebody is using, or an answer thrown away mid-write.
  const kept = [
    ['the focused pane', { focused: true }],
    ["another device's mirrored pty", { remote: true }],
    ['a pane already on its way', { handingOff: true }],
    ['a pane mid-turn', { state: 'working' }],
    ['a pane still starting', { state: 'starting' }],
    ['a pane holding a live question', { state: 'needsYou', asking: true }]
  ]
  for (const [label, extra] of kept) {
    const panes = [pane({ id: 'x', lastKeyboard: quiet, visible: true, ...extra }), pane({ id: 'keep', lastKeyboard: quiet })]
    eq(`the clock never moves ${label}`, ids(idleOffloadPlan(panes, peers, on, {}, NOW)), 'keep')
  }

  {
    const panes = [
      pane({ id: 'x', lastKeyboard: NOW - (IDLE_OFFLOAD_MINUTES - 5) * MIN }),
      pane({ id: 'keep', lastKeyboard: quiet })
    ]
    eq('quiet for less than offloadIdleMinutes stays', ids(idleOffloadPlan(panes, peers, on, {}, NOW)), 'keep')
  }

  {
    const panes = [pane({ id: 'x', lastKeyboard: quiet }), pane({ id: 'keep', lastKeyboard: quiet })]
    eq('a pane still in its cooldown is not retried', ids(idleOffloadPlan(panes, peers, on, { x: NOW + 1000 }, NOW)), 'keep')
  }

  {
    // Never the last pane: an app that empties its own window has not helped anybody.
    const only = [pane({ id: 'x', lastKeyboard: quiet, visible: true })]
    eq('the clock never empties the window', idleOffloadPlan(only, peers, on, {}, NOW).length, 0)
  }

  {
    const panes = [
      pane({ id: 'a', lastKeyboard: quiet - 10 * MIN, visible: true }),
      pane({ id: 'b', lastKeyboard: quiet - 5 * MIN, visible: true }),
      pane({ id: 'c', lastKeyboard: quiet, visible: true }),
      pane({ id: 'd' })
    ]
    eq('maxPerSweep caps the clock too, quietest first', ids(idleOffloadPlan(panes, peers, { ...on, maxPerSweep: 2 }, {}, NOW)), 'a,b')
  }

  {
    // No peer holding this project is not a reason to close anything - the clock simply
    // finds nowhere to put it and does nothing.
    // `keep` is typed into NOW: the clock is 15 minutes and the fixture's default idle is
    // 20, so a bare `keep` would itself be due and this case would measure the wrong pane.
    const panes = [pane({ id: 'x', lastKeyboard: quiet, projectName: 'other', visible: true }), pane({ id: 'keep', lastKeyboard: NOW })]
    eq('nowhere to send it: nothing happens', idleOffloadPlan(panes, peers, on, {}, NOW).length, 0)
  }

  check('the switch turns it on to something longer than the pressure sweep waits', IDLE_OFFLOAD_MINUTES > DEFAULT_AUTO_HANDOFF.minIdleMinutes)

  // The value comes off config.json and, since `pf-ctl call config:set` exists, off a
  // script - so TypeScript is not standing between it and this code. Every non-number is
  // OFF, never a threshold arrived at by coercion: `true > 0` is true and `true * 60_000`
  // is one minute, which would turn a switch somebody wrote as a boolean into "move
  // anything quiet for sixty seconds" - the opposite of the conservative default.
  for (const bad of [true, '30', '', null, undefined, NaN, Infinity, -5, 0, {}]) {
    eq(`offloadIdleMinutes ${JSON.stringify(bad) ?? String(bad)} is off, not a threshold`, offloadMinutes({ offloadIdleMinutes: bad }), 0)
  }
  eq('a real number is taken as given', offloadMinutes({ offloadIdleMinutes: 45 }), 45)
  {
    const panes = [pane({ id: 'x', lastKeyboard: NOW - 2 * MIN, visible: true }), pane({ id: 'keep', lastKeyboard: NOW - 2 * MIN })]
    eq(
      'a boolean offloadIdleMinutes moves nothing, rather than everything quiet for a minute',
      idleOffloadPlan(panes, peers, { ...on, offloadIdleMinutes: true }, {}, NOW).length,
      0
    )
  }
}

// --------------------------------------------------------------- the local-pane budget
//
// The rule that does not wait for anything to go wrong. It is allowed to move a pane that
// is on screen and a pane that is mid-turn, so the refusals below are the ones actually
// holding it up - and the control that the OTHER two rules did not quietly inherit any of
// this is the last block.
{
  const budget = { ...ok, over: 3 }
  // Every fixture in this block is EXPENSIVE, because since 2026-08-23 the budget rung
  // only moves a pane that would give the machine something back. The gate itself is the
  // block below; here it is held constant so the ordering and the refusals are still the
  // thing being measured.
  const big = (o = {}) => pane({ memMb: 900, ...o })
  const three = (o = {}) => [big({ id: 'a', ...o }), big({ id: 'b' }), big({ id: 'c' }), big({ id: 'd' })]

  eq('past the budget it moves exactly the overshoot', ids(autoHandoffPlan(three(), budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)).split(',').length, 3)
  eq(
    'and maxPerSweep does not cap it - the number is the overshoot, not a guess',
    autoHandoffPlan(three(), budget, peers, { ...DEFAULT_AUTO_HANDOFF, maxPerSweep: 1 }, {}, NOW).length,
    3
  )
  eq('at the budget it moves nothing', autoHandoffPlan(three(), { ...ok, over: 0 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)

  // On screen is the gate it drops, and the picks are ORDERED: the quiet off-screen pane
  // goes first, then the quiet visible one. A pane with a turn in flight is not picked at
  // all any more (2026-09-04) - it used to be picked last, and arming a countdown on a
  // chat with a prompt running is what that cost.
  {
    const panes = [
      big({ id: 'busy', busy: true, state: 'working' }),
      big({ id: 'seen', visible: true }),
      big({ id: 'quiet' }),
      // The pane being typed in, so it is refused rather than competing for a slot: three
      // eligible panes and an overshoot of three is what makes the ORDER the assertion.
      big({ id: 'me', focused: true })
    ]
    eq('quiet and off-screen first, then on-screen, and never the one mid-turn', ids(autoHandoffPlan(panes, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'quiet,seen')
  }

  // ...and a pane that has only just been typed into is still eligible. The budget is not
  // a statement about idleness, which is the whole difference from the two clocks.
  {
    const panes = [big({ id: 'fresh', lastKeyboard: NOW - 5_000 }), big({ id: 'me', focused: true })]
    eq('a pane quiet for five seconds still counts', ids(autoHandoffPlan(panes, { ...ok, over: 1 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'fresh')
  }

  // Everything that could lose work is still refused, one at a time.
  const refusals = [
    ['the pane you are typing in', { focused: true }],
    ["another device's mirrored pty", { remote: true }],
    ['a pane already on its way', { handingOff: true }],
    ['a pane holding a live question', { state: 'needsYou', asking: true }],
    ['a pane that has not printed yet', { state: 'starting' }],
    ['a pane whose process has ended', { state: 'exited' }]
  ]
  for (const [label, extra] of refusals) {
    const panes = [big({ id: 'x', ...extra }), big({ id: 'keep' })]
    eq(`the budget never moves ${label}`, ids(autoHandoffPlan(panes, { ...ok, over: 2 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
  }

  {
    const panes = [big({ id: 'x' }), big({ id: 'keep' })]
    eq('a pane on cooldown after a failed move is left alone', ids(autoHandoffPlan(panes, { ...ok, over: 2 }, peers, DEFAULT_AUTO_HANDOFF, { x: NOW + MIN }, NOW)), 'keep')
  }

  {
    const panes = [big({ id: 'only' })]
    eq('the window is never emptied, however far past the budget', autoHandoffPlan(panes, { ...ok, over: 5 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)
  }

  {
    // ...and it does not take a slot with it: the other pane still moves, and the window
    // is still not emptied.
    const panes = [big({ id: 'a', projectName: 'elsewhere' }), big({ id: 'keep' })]
    eq('a project the peer does not have stays here', ids(autoHandoffPlan(panes, { ...ok, over: 2 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
    const alone = [big({ id: 'a', projectName: 'elsewhere' })]
    eq('and with nowhere for any of them, nothing moves', autoHandoffPlan(alone, { ...ok, over: 2 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)
  }

  eq('the budget respects the off switch like everything else', autoHandoffPlan(three(), budget, peers, { ...DEFAULT_AUTO_HANDOFF, enabled: false }, {}, NOW).length, 0)

  // The control, and the one that would catch this leaking into the pressure sweep: with
  // no overshoot the old rules are exactly as they were, and a mid-turn pane is refused.
  {
    // Quiet for longer than the clock sweep's own threshold, so the only thing that can
    // keep `busy` out of either answer is the refusal being tested.
    const panes = [
      big({ id: 'busy', busy: true, state: 'working', lastKeyboard: NOW - 40 * MIN }),
      big({ id: 'keep', lastKeyboard: NOW - 40 * MIN })
    ]
    eq('a mid-turn pane is still refused when the budget is not the trigger', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'keep')
    eq('...and by the clock sweep too', ids(idleOffloadPlan(panes, peers, { ...DEFAULT_AUTO_HANDOFF, offloadIdleMinutes: 30 }, {}, NOW)), 'keep')
  }

  // The one failure mode a POLICY has that a pressure reading does not. Two desks each
  // keeping two agents are each right about their own budget, and between them they would
  // pass one pane back and forth for ever - so a pane never goes back where it came from.
  {
    const panes = [big({ id: 'came', arrivedFrom: 'pc' }), big({ id: 'me', focused: true })]
    eq('a pane handed here is never handed straight back', autoHandoffPlan(panes, { ...ok, over: 1 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)

    // ...and the control: it is refused because of WHERE it came from, not because it
    // arrived. A second machine that did not send it can still take it.
    const two = [...peers, { device: 'mini', deviceName: 'Mini', online: true, projects: [{ name: 'proj', path: '/mini/proj' }] }]
    const plan = autoHandoffPlan(panes, { ...ok, over: 1 }, two, DEFAULT_AUTO_HANDOFF, {}, NOW)
    eq('but another machine may still take it', plan.map((p) => p.device).join(','), 'mini')
    eq('and hostFor is where that is decided', hostFor(peers, 'proj', 'pc'), null)
  }

  // A plan that cannot converge. The cap has to be on how many are MOVED, not on how many
  // are looked at: a pane whose project no peer holds is skipped, and if it has already
  // spent a slot the desk moves one instead of three and is over budget again next sweep,
  // for ever. The quietest panes sort first, so "the ones that cannot move are first" is
  // the ordinary case, not a contrived one.
  {
    const panes = [
      big({ id: 'orphan1', projectName: 'nowhere', lastKeyboard: NOW - 90 * MIN }),
      big({ id: 'orphan2', projectName: 'nowhere', lastKeyboard: NOW - 80 * MIN }),
      big({ id: 'a', lastKeyboard: NOW - 70 * MIN }),
      big({ id: 'b', lastKeyboard: NOW - 60 * MIN }),
      big({ id: 'c', lastKeyboard: NOW - 50 * MIN }),
      big({ id: 'me', focused: true })
    ]
    eq('panes no peer can host do not eat the moves', ids(autoHandoffPlan(panes, { ...ok, over: 3 }, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'a,b,c')
    eq('...and the pressure sweep counts the same way', ids(autoHandoffPlan(panes, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'a,b')
  }

  // ------------------------------------------------------------- what it may move at all
  //
  // The budget counts panes and a count is not a cost. Five idle agent panes at ~190 MB
  // apiece are three over a budget of two and are costing this machine nothing anybody can
  // feel - moving one of those is the app rearranging somebody's desk for a number, which
  // is what happened on 2026-08-23 ("randomly 2 sessions moved"). The load-bearing half is
  // the FIRST case: it must be possible to be far over budget and move nothing.
  {
    // The floor moved from 500 MB to 180 on 2026-08-28, because at 500 NO agent pane on a
    // normal desk was ever expensive and this rung had therefore never moved anything -
    // measured here, eight live `claude` panes at 61-247 MB. So a Codex-sized pane is what
    // "cheap" means now, and an ordinary Claude Code pane is what the rung is FOR.
    const cheap = [pane({ id: 'a', memMb: 17 }), pane({ id: 'b', memMb: 16 }), pane({ id: 'c', memMb: 12 })]
    eq('three panes over budget, none of them expensive: nothing moves', autoHandoffPlan(cheap, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)

    const agents = [pane({ id: 'a', memMb: 190 }), pane({ id: 'b', memMb: 247 }), pane({ id: 'c', memMb: 12 })]
    eq('...but an ordinary agent pane IS expensive, which is the whole point of the rung', ids(autoHandoffPlan(agents, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'b,a')

    const unmeasured = [pane({ id: 'a' }), pane({ id: 'b' }), pane({ id: 'c' })]
    eq('and an UNMEASURED pane is not expensive - a hidden window samples nothing', autoHandoffPlan(unmeasured, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW).length, 0)

    const mixed = [pane({ id: 'small', memMb: 60 }), pane({ id: 'heavy', memMb: 1400 }), pane({ id: 'keep', memMb: 100 })]
    eq('the heavy one goes and the small ones stay', ids(autoHandoffPlan(mixed, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'heavy')

    const cpu = [pane({ id: 'hot', memMb: 120, cpuPct: 90 }), pane({ id: 'keep', memMb: 120 })]
    eq('a pane burning a core counts even when it holds little', ids(autoHandoffPlan(cpu, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'hot')

    // Robert's own words: "only when it has like an intense dev server or shell running".
    // A server that has just started holds nothing yet and is exactly the pane to move.
    const dev = [pane({ id: 'server', memMb: 60, job: 'npm run dev' }), pane({ id: 'keep', memMb: 300 })]
    eq('a live dev server outranks every measured pane', ids(autoHandoffPlan(dev, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'server')

    // Dearest first among several that all qualify.
    const order = [
      pane({ id: 'mid', memMb: 800 }),
      pane({ id: 'top', memMb: 2400 }),
      pane({ id: 'low', memMb: 520 }),
      pane({ id: 'me', focused: true })
    ]
    eq('and the dearest goes first', ids(autoHandoffPlan(order, budget, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'top,mid,low')

    // The floor is configurable, and the control that the gate is really what decided.
    const loose = { ...DEFAULT_AUTO_HANDOFF, budgetMinMb: 10 }
    eq('with the floor lowered the same cheap panes DO move', autoHandoffPlan(cheap, budget, peers, loose, {}, NOW).length > 0, true)

    check('expensive() refuses a pane with no reading at all', !expensive({}, DEFAULT_AUTO_HANDOFF))
    check('...and takes a job whatever the numbers say', expensive({ memMb: 1, job: 'vite' }, DEFAULT_AUTO_HANDOFF))
    // config.json is also what `pf-ctl call config:set` writes, so a threshold arrives
    // unvalidated. `Math.max(0, NaN)` is NaN and every `>=` against NaN is false, so a
    // junk value did not fall back - it switched BOTH cost gates off and left the budget
    // rung deciding on `job` alone. Same hardening as keepLocalOf.
    const junk = { ...DEFAULT_AUTO_HANDOFF, budgetMinMb: 'lots', budgetMinCpu: null }
    check(
      'a non-numeric threshold falls back to the default, it does not disable the gate',
      expensive({ memMb: DEFAULT_AUTO_HANDOFF.budgetMinMb + 1 }, junk)
    )
    check(
      '...and a pane under that default is still refused',
      !expensive({ memMb: DEFAULT_AUTO_HANDOFF.budgetMinMb - 1, cpuPct: 0 }, junk)
    )
    check(
      'a NEGATIVE threshold is clamped at 0, not honoured as a floor below zero',
      expensive({ memMb: 0, cpuPct: 0 }, { ...DEFAULT_AUTO_HANDOFF, budgetMinMb: -5 })
    )
    // The floor sits UNDER an ordinary Claude Code pane (measured here 2026-08-28: 61, 64,
    // 153, 166, 174, 177, 231, 247 MB) and above a Codex one (16-17 MB). It was above the
    // agent pane until that date, which is why this rung had never moved anything.
    check(
      'the floor sits under an ordinary agent pane and above a cheap one',
      DEFAULT_AUTO_HANDOFF.budgetMinMb > 20 && DEFAULT_AUTO_HANDOFF.budgetMinMb < 190
    )
  }

  // The PRESSURE sweep is unchanged: when the kernel is objecting, every pane is worth
  // moving and a cheap one is still memory back. The control that the gate above did not
  // leak into the rung it does not belong to.
  {
    const cheap = [pane({ id: 'a', memMb: 190 }), pane({ id: 'keep', memMb: 190, focused: true })]
    eq('pressure still moves a cheap pane', ids(autoHandoffPlan(cheap, over, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)), 'a')
    eq('...and so does the idle clock', ids(idleOffloadPlan(cheap, peers, { ...DEFAULT_AUTO_HANDOFF, offloadIdleMinutes: 10 }, {}, NOW)), 'a')
  }

  check('a busy pane is neither queueable nor movable', !queueable({ state: 'working', asking: false }) && !movable({ state: 'working', asking: false }))
  check('and a question is neither', !queueable({ state: 'needsYou', asking: true }) && !movable({ state: 'needsYou', asking: true }))
  check('the default keeps a couple here', DEFAULT_AUTO_HANDOFF.keepLocal === 2)
}

{
  // The pressure card's offer: which pane, and where. Robert, 2026-08-26 - the card said
  // memory was tight and left him to work out which of eleven panes to act on.
  const panes = [
    pane({ id: 'cheap', memMb: 120 }),
    pane({ id: 'dear', memMb: 1800 }),
    pane({ id: 'keep' })
  ]
  const pick = suggestMove(panes, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)
  eq('the card offers the dearest pane', pick?.id, 'dear')
  eq('...and names the machine it would go to', pick?.deviceName, 'PC')

  // The refusals are the feature here exactly as they are for the sweeps. Each is paired
  // with a plain pane so the last-pane rule never masks the case under test.
  for (const [label, extra] of [
    ['the focused pane', { focused: true }],
    ["another device's mirrored pty", { remote: true }],
    ['a pane already on its way', { handingOff: true }],
    ['a pane holding a live question', { state: 'needsYou', asking: true }]
  ]) {
    const two = [pane({ id: 'x', memMb: 4000, ...extra }), pane({ id: 'keep', memMb: 100 })]
    const got = suggestMove(two, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)
    check(`the card never offers ${label}`, got?.id !== 'x', got)
  }

  // A busy pane is NOT offered either, since 2026-09-04: the queue used to make this
  // wider than `movable`, and a card naming a pane with a prompt running is the same
  // mistake one step earlier.
  const busy = [pane({ id: 'busy', state: 'working', memMb: 4000 }), pane({ id: 'keep' })]
  check(
    'the card never offers a pane mid-turn',
    suggestMove(busy, peers, DEFAULT_AUTO_HANDOFF, {}, NOW)?.id !== 'busy'
  )

  // The window is never emptied here either.
  eq('one pane on the desk is never offered', suggestMove([pane({ id: 'only' })], peers, DEFAULT_AUTO_HANDOFF, {}, NOW), null)
  // No peer holds the project, so there is nowhere for it to go.
  eq('nothing to offer when no machine holds the project',
    suggestMove([pane({ id: 'a', projectName: 'other' }), pane({ id: 'b', projectName: 'other' })], peers, DEFAULT_AUTO_HANDOFF, {}, NOW), null)
  // Never back where it came from, or two desks pass one pane between them for ever.
  eq('never back to the machine that sent it',
    suggestMove([pane({ id: 'a', arrivedFrom: 'pc' }), pane({ id: 'b', arrivedFrom: 'pc' })], peers, DEFAULT_AUTO_HANDOFF, {}, NOW), null)
}

{
  // "automated windows need to keep on this laptop though since pc cant do it" - a project
  // this machine alone can run. One list, read by every rung, or the card refuses it and
  // the sweep behind it takes it anyway.
  const cfg = { ...DEFAULT_AUTO_HANDOFF, keepHere: ['Mac-only'] }
  check('a listed project stays', staysHere(cfg, 'Mac-only'))
  // The list is written from a card that prints the project as `place.ts` words it, so a
  // stored name with different case or a stray space must still match.
  check('...however it was cased or spaced', staysHere(cfg, ' mac-ONLY '))
  check('an unlisted project is free to move', !staysHere(cfg, 'proj'))
  check('an empty name is never held', !staysHere(cfg, ''))
  check('an empty list holds nothing', !staysHere(DEFAULT_AUTO_HANDOFF, 'Mac-only'))
  eq('the default holds nothing', DEFAULT_AUTO_HANDOFF.keepHere, [])

  const held = [pane({ id: 'x', projectName: 'Mac-only', memMb: 4000 }), pane({ id: 'keep', memMb: 100 })]
  // It offers the OTHER pane instead of nothing: a card that goes quiet because its first
  // choice is held would read as "there is nothing to do" on a machine that is swapping.
  eq('the card never offers a held project', suggestMove(held, peers, cfg, {}, NOW)?.id, 'keep')
  eq('...and offers nothing at all when the held one is the only candidate',
    suggestMove([pane({ id: 'x', projectName: 'Mac-only' }), pane({ id: 'y', projectName: 'Mac-only' })], peers, cfg, {}, NOW), null)
  // And every automatic rung refuses it too - the card refusing alone would be a promise
  // the sweep behind it breaks a minute later.
  const macPeers = [{ device: 'pc', deviceName: 'PC', online: true, projects: [{ name: 'Mac-only', path: '/pc/m' }] }]
  eq('the budget rung refuses it', budgetPlan(held, macPeers, { ...cfg, budgetMinMb: 1 }, {}, NOW, 1).length, 0)
  eq('the idle clock refuses it',
    idleOffloadPlan(held, macPeers, { ...cfg, offloadIdleMinutes: 1 }, {}, NOW).length, 0)
  eq('the pressure sweep refuses it', autoHandoffPlan(held, over, macPeers, cfg, {}, NOW).length, 0)
  // The control: the same panes, the same peers, with the project NOT held.
  const free = { ...cfg, keepHere: [] }
  check('...and all three move it once it is off the list',
    budgetPlan(held, macPeers, { ...free, budgetMinMb: 1 }, {}, NOW, 1).length === 1 &&
      idleOffloadPlan(held, macPeers, { ...free, offloadIdleMinutes: 1 }, {}, NOW).length === 1 &&
      autoHandoffPlan(held, over, macPeers, free, {}, NOW).length === 1)
}

// Somebody arriving at a pane answers a CLOSE countdown and not a MOVE one. A click was
// also the one cancel that wrote no hold, so the 60s sweep armed the identical countdown
// again and the card came straight back (Robert, 2026-09-04).
assert.equal(endsOnArrival({}), true, 'a close countdown ends when somebody comes to the pane')
assert.equal(endsOnArrival({ move: undefined }), true, 'an unflagged countdown is a close')
assert.equal(
  endsOnArrival({ move: { device: 'pc', deviceName: 'PC' } }),
  false,
  'a move is answered by the card buttons, never by a click on the pane'
)
checks += 3

console.log(`autohandoff: ${checks} checks passed`)
