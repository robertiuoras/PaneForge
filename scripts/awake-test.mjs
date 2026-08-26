// npm run test:awake
//
// Holding a laptop's display awake is a battery cost, so every refusal gets a test: the
// setting being off, the desk being quiet, and the CAP - which by definition takes hours
// to reach and could never be exercised by hand.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-awake-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'awake.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/awake.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { awakeVerdict, awakeBusy, nextBusySince, AwakeKeeper, DEFAULT_MAX_HOLD_MS } =
  createRequire(import.meta.url)(outfile)

const NOW = 1_000_000_000
const working = { runSince: NOW - 5_000, status: 'idle' }
const quiet = { status: 'idle' }
const asking = { status: 'idle', asking: true }
const deadButMarked = { runSince: NOW - 5_000, status: 'exited' }

// --- what counts as working ------------------------------------------------------------
assert.equal(awakeBusy([quiet, quiet]), 0)
assert.equal(awakeBusy([working, quiet]), 1)
// A pane sitting on a question is the reason the system must not go off: the answer is
// wanted from a person, and a black screen is how that question is missed.
assert.equal(awakeBusy([asking]), 1)
// A shell running a foreground build or command (e.g. npm, cargo, python) counts as busy.
const shellJob = { status: 'idle', job: 'cargo' }
assert.equal(awakeBusy([shellJob]), 1)
// Background monitors / watcher tasks outliving the prompt turn count as busy.
const backJob = { status: 'idle', backJobsCount: 2 }
assert.equal(awakeBusy([backJob]), 1)
// Dev servers running for a project count as busy.
const devServer = { status: 'idle', devServersCount: 1 }
assert.equal(awakeBusy([devServer]), 1)
// Status working or starting counts as busy.
const starting = { status: 'starting' }
const activeWorking = { status: 'working' }
assert.equal(awakeBusy([starting]), 1)
assert.equal(awakeBusy([activeWorking]), 1)
// Recent log output or recent keyboard input keeps the screen awake so reading logs does not go dark.
const recentLogs = { status: 'idle', lastOutput: NOW - 60_000 }
assert.equal(awakeBusy([recentLogs], NOW), 1)
const oldLogs = { status: 'idle', lastOutput: NOW - 6 * 60_000 }
assert.equal(awakeBusy([oldLogs], NOW), 0)
const recentKeys = { status: 'idle', lastKeyboard: NOW - 30_000 }
assert.equal(awakeBusy([recentKeys], NOW), 1)
const oldKeys = { status: 'idle', lastKeyboard: NOW - 6 * 60_000 }
assert.equal(awakeBusy([oldKeys], NOW), 0)
// An agent that exited mid-turn keeps the runSince it had. Counting it would hold the
// system for the rest of the session - the same trap updateHold.ts records.
assert.equal(awakeBusy([deadButMarked]), 0)
assert.equal(awakeBusy([{ status: 'exited', job: 'cargo', backJobsCount: 1 }]), 0)

// --- the verdict -------------------------------------------------------------------------
const v = (over) =>
  awakeVerdict({ panes: [working], enabled: true, now: NOW, busySince: NOW - 1_000, ...over })
assert.equal(v({}).hold, true)
assert.equal(v({ enabled: false }).hold, false)
assert.equal(v({ enabled: false }).reason, 'off')
assert.equal(v({ panes: [quiet] }).hold, false)
assert.equal(v({ panes: [quiet] }).reason, 'nothing running')

// The cap: one unbroken busy stretch may not hold the screen forever.
const capped = v({ busySince: NOW - DEFAULT_MAX_HOLD_MS - 1 })
assert.equal(capped.hold, false)
assert.match(capped.reason, /past the cap/)
// One millisecond inside it still holds.
assert.equal(v({ busySince: NOW - DEFAULT_MAX_HOLD_MS + 1 }).hold, true)

// --- the stretch clock -------------------------------------------------------------------
assert.equal(nextBusySince(null, 0, NOW), null)
assert.equal(nextBusySince(null, 2, NOW), NOW)
// A tick that finds work ALREADY running does not restart the clock - that is what makes
// the cap measure the stretch rather than the tick.
assert.equal(nextBusySince(NOW - 60_000, 2, NOW), NOW - 60_000)
assert.equal(nextBusySince(NOW - 60_000, 0, NOW), null)

// --- the keeper ---------------------------------------------------------------------------
function keeper(panes, opts = {}) {
  const events = []
  let now = NOW
  let next = 1
  const k = new AwakeKeeper({
    panes: () => panes,
    enabled: () => opts.enabled !== false,
    start: () => {
      events.push('start')
      return next++
    },
    stop: (id) => events.push(`stop:${id}`),
    now: () => now,
    maxHoldMs: opts.maxHoldMs,
    log: (l) => events.push(`log:${l}`)
  })
  return { k, events, at: (ms) => (now = NOW + ms) }
}

// Idle desk: never starts a blocker at all.
{
  const { k, events } = keeper([quiet])
  k.tick()
  k.tick()
  assert.equal(k.holding(), false)
  assert.equal(events.filter((e) => e === 'start').length, 0)
}

// Busy desk: one blocker, not one per tick.
{
  const panes = [working]
  const { k, events } = keeper(panes)
  k.tick()
  k.tick()
  k.tick()
  assert.equal(k.holding(), true)
  assert.equal(events.filter((e) => e === 'start').length, 1)
  // ...and it lets go when the desk goes quiet, without being told.
  panes[0] = quiet
  k.tick()
  assert.equal(k.holding(), false)
  assert.deepEqual(events.filter((e) => e.startsWith('stop')), ['stop:1'])
}

// The cap releases a wedged pane, and does NOT re-arm while that same stretch runs.
{
  const panes = [working]
  const { k, events, at } = keeper(panes, { maxHoldMs: 60_000 })
  k.tick()
  assert.equal(k.holding(), true)
  at(60_001)
  k.tick()
  assert.equal(k.holding(), false)
  at(120_000)
  k.tick()
  assert.equal(k.holding(), false, 'a capped stretch may not re-arm itself')
  // A real break re-arms it: this is a cap on the stretch, not a one-shot for the session.
  panes[0] = quiet
  k.tick()
  panes[0] = { runSince: NOW + 130_000, status: 'idle' }
  at(130_000)
  k.tick()
  assert.equal(k.holding(), true)
  assert.equal(events.filter((e) => e === 'start').length, 2)
}

// release() lets go whatever the desk looks like, and twice is not an error.
{
  const { k } = keeper([working])
  k.tick()
  k.release()
  k.release()
  assert.equal(k.holding(), false)
}

console.log('awake: ok')
