// Closing somebody's pane to get memory back, and every case where it must not.
//
// This is the most destructive thing the app does on its own, so - as with recover-test -
// the refusals are the file and the happy path is a handful of lines. The one that matters
// most is `needsYou`: an agent that asked a question and is waiting for an answer looks
// exactly like an idle pane, and closing it is the difference between tidying up and
// throwing somebody's work away.
//
//   node scripts/reclaim-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-reclaim-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'reclaim.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/reclaim.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { reclaimPlan, idleClosePlan, reclaimedMb, DEFAULT_RECLAIM } = createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const NOW = 1_000_000_000
const HOUR = 3_600_000
const over = { level: 'over', usedMb: 2530, nextPaneMb: 197, roomFor: null, trim: true, offload: false, advice: '' }
const tight = { ...over, level: 'tight', roomFor: 0 }
const ok = { ...over, level: 'ok', roomFor: 4, trim: false }

const pane = (o) => ({
  id: 'p',
  state: 'ready',
  lastKeyboard: NOW - 3 * HOUR,
  focused: false,
  visible: false,
  remote: false,
  ...o
})
const ids = (plan) => plan.map((p) => p.id).join(',')

{
  // The whole point: a machine the kernel says is out of memory, holding finished panes
  // nobody has looked at for hours.
  const panes = [
    pane({ id: 'a', lastOutput: NOW - 5 * HOUR }),
    pane({ id: 'b', lastOutput: NOW - 2 * HOUR }),
    pane({ id: 'c', focused: true, lastOutput: NOW })
  ]
  eq('the oldest quiet panes go first', ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 'a,b')
  eq('and it says what that bought', reclaimedMb(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 380)
  eq(
    'a tight machine reclaims too',
    ids(reclaimPlan(panes, tight, DEFAULT_RECLAIM, NOW)),
    'a,b'
  )
  eq('at most maxPerSweep at a time', reclaimPlan(panes, over, { ...DEFAULT_RECLAIM, maxPerSweep: 1 }, NOW).length, 1)
}

{
  // The trigger is pressure, never a clock. This is the line between reclaiming and
  // tidying up after somebody who did not ask to be tidied up after.
  const old = [pane({ id: 'a', lastOutput: NOW - 40 * HOUR }), pane({ id: 'b' })]
  eq('a healthy machine closes nothing, however old the pane', reclaimPlan(old, ok, DEFAULT_RECLAIM, NOW).length, 0)
  eq('off is off', reclaimPlan(old, over, { ...DEFAULT_RECLAIM, enabled: false }, NOW).length, 0)
}

{
  // Never somebody's business. `needsYou` is the load-bearing one - it is quiet BECAUSE it
  // is waiting for a person, so every "is it idle" test in the app says yes about it.
  for (const state of ['needsYou', 'working', 'starting', 'stalled']) {
    const panes = [pane({ id: 'x', state }), pane({ id: 'keep' })]
    eq(`never closes a pane that is ${state}`, ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 'keep')
  }
}

{
  const panes = [
    pane({ id: 'focused', focused: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'visible', visible: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'mirror', remote: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'keep' })
  ]
  eq(
    'never the pane being read, one on screen, or another device s pty',
    ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)),
    'keep'
  )
}

{
  // Idle time is a tie-break, not the trigger - but it is still a floor.
  const fresh = [pane({ id: 'a', lastKeyboard: NOW - 10 * 60_000 }), pane({ id: 'b', lastKeyboard: NOW })]
  eq('a pane quiet for ten minutes is not stale', reclaimPlan(fresh, over, DEFAULT_RECLAIM, NOW).length, 0)
  const justOver = [pane({ id: 'a', lastKeyboard: NOW - 16 * 60_000 }), pane({ id: 'b' })]
  check('one just past fifteen minutes is', reclaimPlan(justOver, over, DEFAULT_RECLAIM, NOW).length > 0)
}

{
  // An app that empties its own window under memory pressure has removed the reason the
  // window is open, not solved the problem.
  const one = [pane({ id: 'only', lastOutput: NOW - 9 * HOUR })]
  eq('never the last pane', reclaimPlan(one, over, DEFAULT_RECLAIM, NOW).length, 0)
  const two = [pane({ id: 'a', lastOutput: NOW - 9 * HOUR }), pane({ id: 'b', lastOutput: NOW - 8 * HOUR })]
  eq('one of two is fine', ids(reclaimPlan(two, over, DEFAULT_RECLAIM, NOW)), 'a')
}

{
  // An exited pane's process is already gone, so closing it returns a buffer and not an
  // agent. Worth doing, not worth claiming credit for.
  const gone = [pane({ id: 'dead', state: 'exited', lastOutput: NOW - 9 * HOUR }), pane({ id: 'keep' })]
  const plan = reclaimPlan(gone, over, DEFAULT_RECLAIM, NOW)
  eq('an exited pane is closeable', plan[0].id, 'dead')
  eq('but frees no agent', reclaimedMb([plan[0]]), 0)
}

{
  // The clock, for a machine with nobody at it. Off by default is the load-bearing half:
  // the desk somebody is sitting at must behave exactly as it did before this existed.
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 120 }
  const panes = [
    pane({ id: 'a', lastKeyboard: NOW - 5 * HOUR }),
    pane({ id: 'b', lastKeyboard: NOW - 3 * HOUR }),
    pane({ id: 'fresh', lastKeyboard: NOW - 30 * 60_000 })
  ]
  eq('off unless somebody sets a number', idleClosePlan(panes, DEFAULT_RECLAIM, NOW).length, 0)
  eq('and off when reclaim itself is off', idleClosePlan(panes, { ...CLOCKED, enabled: false }, NOW).length, 0)
  eq('oldest quiet first, and only past the clock', ids(idleClosePlan(panes, CLOCKED, NOW)), 'a,b')
  eq('a pane inside the window is left alone', ids(idleClosePlan([panes[2], pane({ id: 'k', lastKeyboard: NOW })], CLOCKED, NOW)), '')

  // Every refusal the pressure sweep makes, this makes too - except `visible`, which is
  // the one it cannot keep: on a desk nobody is sitting at, every pane in the grid is "on
  // screen", and keeping it would mean the feature can never fire on the machine it was
  // built for.
  for (const state of ['needsYou', 'working', 'starting', 'stalled']) {
    const p = [pane({ id: 'x', state, lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'keep', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })]
    check(
      `the clock never closes a pane that is ${state}`,
      !idleClosePlan(p, CLOCKED, NOW).some((r) => r.id === 'x'),
      ids(idleClosePlan(p, CLOCKED, NOW))
    )
  }
  const guarded = [
    pane({ id: 'focused', focused: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'mirror', remote: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'seen', visible: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'pad', lastKeyboard: NOW })
  ]
  eq(
    'never the focused pane and never another device s pty - but a drawn one nobody has typed into for hours IS closed',
    ids(idleClosePlan(guarded, CLOCKED, NOW)),
    'seen'
  )
  eq('never the last pane', idleClosePlan([pane({ id: 'only', lastKeyboard: NOW - 9 * HOUR })], CLOCKED, NOW).length, 0)
  eq(
    'at most maxPerSweep at a time',
    idleClosePlan(
      [pane({ id: 'a', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'b', lastKeyboard: NOW - 8 * HOUR }), pane({ id: 'c', lastKeyboard: NOW - 7 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })],
      { ...CLOCKED, maxPerSweep: 1 },
      NOW
    ).length,
    1
  )
  // A config written by an older build has no such field at all, and reading `undefined`
  // as "close everything that is older than never" would be the worst possible default.
  const legacy = { enabled: true, minIdleMinutes: 15, maxPerSweep: 2 }
  eq('a config from before this feature closes nothing', idleClosePlan(panes, legacy, NOW).length, 0)
}

console.log(`reclaim: ${checks} checks passed`)
