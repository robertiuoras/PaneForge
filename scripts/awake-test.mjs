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
const holdOut = join(work, 'hold.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/caffeinateHold.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: holdOut })
const { CaffeinateHolds } = createRequire(import.meta.url)(holdOut)
const { awakeVerdict, awakeBusy, awakeDisplayBusy, nextBusySince, AwakeKeeper, DEFAULT_MAX_HOLD_MS } =
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

// The display/system split (2026-08-27). Work running keeps the MACHINE awake; only a
// question on screen or a recent keypress keeps the SCREEN lit, because the screen staying
// on at an empty desk was the battery drain that prompted this.
{
  const lit = (panes) => awakeVerdict({ panes, enabled: true, now: NOW, busySince: NOW - 1000 })
  for (const [name, pane] of [
    ['an agent mid-turn', working],
    ['a shell job', shellJob],
    ['a background job', backJob],
    ['a dev server', devServer],
    ['recent log output', recentLogs],
    ['a starting pane', starting]
  ]) {
    const verdict = lit([pane])
    assert.equal(verdict.hold, true, `${name} holds the system`)
    assert.equal(verdict.holdDisplay, false, `${name} must NOT hold the screen`)
  }
  assert.equal(lit([asking]).holdDisplay, true, 'a question on screen holds the screen')
  assert.equal(lit([recentKeys]).holdDisplay, true, 'a recent keypress holds the screen')
  assert.equal(lit([oldKeys]).holdDisplay, false, 'a 6-minute-old keypress does not')
  assert.equal(
    lit([{ ...asking, status: 'exited' }]).holdDisplay,
    false,
    'a dead pane holds nothing'
  )
  // The refusals cover the screen too - never a lit screen with hold false.
  assert.equal(awakeVerdict({ panes: [asking], enabled: false, now: NOW, busySince: null }).holdDisplay, false)
  assert.equal(awakeVerdict({ panes: [quiet], enabled: true, now: NOW, busySince: null }).holdDisplay, false)
  assert.equal(
    awakeVerdict({ panes: [asking], enabled: true, now: NOW, busySince: NOW - DEFAULT_MAX_HOLD_MS - 1 }).holdDisplay,
    false,
    'past the cap the screen goes off too'
  )
  // A shut lid with no external screen: the machine keeps working, the panel goes dark.
  // `pmset -a disablesleep 1` makes the kernel ignore the lid, backlight included, so
  // without this an OLED runs at full brightness all night behind a closed MacBook. The
  // CONTROL is the same desk with the lid up, which must still hold the screen - a fix
  // that blanked it either way would pass a bare "holdDisplay went false" check.
  const shut = (panes) =>
    awakeVerdict({ panes, enabled: true, now: NOW, busySince: NOW - 1000, screenUnseen: true })
  assert.equal(lit([asking]).holdDisplay, true, 'CONTROL: lid up, a question still lights it')
  assert.equal(shut([asking]).holdDisplay, false, 'lid shut, the screen may sleep')
  assert.equal(shut([recentKeys]).holdDisplay, false, 'a keypress before the lid shut does not hold it')
  assert.equal(shut([asking]).hold, true, 'the MACHINE is still held awake behind a shut lid')
  assert.match(shut([asking]).reason, /lid shut/, 'and the log line says why')
  // An unread lid - the probe failed, or this is not a Mac - is the behaviour we shipped.
  assert.equal(
    awakeVerdict({ panes: [asking], enabled: true, now: NOW, busySince: null, screenUnseen: false })
      .holdDisplay,
    true,
    'a reading that failed must never blank a screen somebody is reading'
  )
  assert.equal(shut([quiet]).hold, false, 'a shut lid does not hold a quiet desk awake')

  assert.equal(awakeDisplayBusy([asking, working, recentKeys], NOW), 2)
  assert.equal(awakeBusy([asking, working, recentKeys], NOW), 3)
}

// --- caffeinate bookkeeping: a late 'exit' from the OLD child must not orphan the NEW one ---
{
  const live = new Set()
  const procs = []
  const spawnFake = (flag, watch) => {
    const handlers = {}
    const p = {
      pid: 1000 + procs.length,
      flag,
      watch,
      on: (ev, cb) => { handlers[ev] = cb },
      // A real SIGTERM is delivered now but the 'exit' EVENT arrives later: the test fires it by hand.
      kill: () => { live.delete(p) },
      fireExit: () => handlers.exit?.(0)
    }
    live.add(p)
    procs.push(p)
    return p
  }
  const lines = []
  const holds = new CaffeinateHolds(spawnFake, 4242, (l) => lines.push(l))
  holds.start('system')
  holds.start('system') // a second start while one is held is a no-op
  assert.equal(live.size, 1)
  assert.equal(procs[0].watch, 4242)
  assert.equal(procs[0].flag, '-i')
  holds.stop('system')
  holds.start('system') // the NEW child
  procs[0].fireExit() // the OLD child's exit event lands late
  assert.equal(holds.tracked(), 1, 'a late exit of the old child must not clear the new slot')
  holds.start('system') // the next tick: must NOT spawn a third
  assert.equal(procs.length, 2, 'no extra caffeinate spawned')
  assert.equal(live.size, 1, 'exactly one live process')
  holds.stop('system')
  assert.equal(live.size, 0, 'and it can be stopped, nothing left over')
  assert.equal(holds.tracked(), 0)
  // 25 stop+start cycles each with a late exit: still one live, one tracked.
  for (let i = 0; i < 25; i++) {
    const old = procs[procs.length - 1]
    holds.start('system')
    const cur = procs[procs.length - 1]
    holds.stop('system')
    holds.start('display')
    old.fireExit()
    cur.fireExit()
    holds.stop('display')
  }
  holds.start('system')
  holds.start('display')
  assert.equal(live.size, 2)
  assert.equal(holds.tracked(), 2)
  holds.stopAll()
  assert.equal(live.size, 0)
  assert.ok(lines.some((l) => /started PID/.test(l)) && lines.some((l) => /stopping/.test(l)) && lines.some((l) => /exited/.test(l)))
}

console.log('awake: ok')
