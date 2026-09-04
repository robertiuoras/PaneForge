/**
 * Which sleeping panes to wake, and which running ones to sleep, as the machine's own
 * pressure reading changes - shared/wakePlan.ts. Pure arithmetic, no Electron, no window.
 *
 * Run: npm run test:wakeplan
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-wakeplan-'))
const file = join(out, 'wakePlan.mjs')
buildSync({
  entryPoints: ['src/shared/wakePlan.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: file
})
const { wakePlan, pressureSleepPlan, roomFor } = await import(pathToFileURL(file).href)

let n = 0
function ok(label, cond) {
  n++
  assert.ok(cond, label)
}

// wakePlan --------------------------------------------------------------

ok(
  'wakes nothing under warn',
  wakePlan(
    [{ id: 'a', asleep: 1, asleepReason: 'pressure', createdAt: 0 }],
    { pressure: 'warn' },
    1000
  ).length === 0
)

ok(
  'wakes nothing under critical',
  wakePlan(
    [{ id: 'a', asleep: 1, asleepReason: 'pressure', createdAt: 0 }],
    { pressure: 'critical' },
    1000
  ).length === 0
)

ok(
  'never wakes a manual sleeper',
  wakePlan([{ id: 'a', asleep: 1, asleepReason: 'manual', createdAt: 0 }], {
    pressure: 'normal'
  }).length === 0
)

ok(
  'never wakes an idle sleeper',
  wakePlan([{ id: 'a', asleep: 1, asleepReason: 'idle', createdAt: 0 }], {
    pressure: 'normal'
  }).length === 0
)

{
  const panes = [
    { id: 'newest', asleep: 300, asleepReason: 'pressure', createdAt: 0 },
    { id: 'oldest', asleep: 100, asleepReason: 'pressure', createdAt: 0 }
  ]
  const plan = wakePlan(panes, { pressure: 'normal' })
  ok('oldest sleeper first', plan[0] === 'oldest')
}

{
  const panes = [
    { id: 'q2', asleep: 0, asleepReason: 'queued', createdAt: 200 },
    { id: 'q1', asleep: 0, asleepReason: 'queued', createdAt: 100 }
  ]
  const plan = wakePlan(panes, { pressure: 'normal' })
  ok('queued panes wake in creation order', plan[0] === 'q1' && plan[1] === 'q2')
}

{
  const panes = Array.from({ length: 5 }, (_, i) => ({
    id: `p${i}`,
    asleep: i,
    asleepReason: 'pressure',
    createdAt: 0
  }))
  const plan = wakePlan(panes, { pressure: 'normal', maxPerSweep: 2 })
  ok('maxPerSweep caps the wake batch', plan.length === 2)
}

// pressureSleepPlan -------------------------------------------------------

ok(
  'never sleeps a busy pane under critical',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready', busy: true }], 'critical', 1000)
    .length === 0
)

ok(
  'never sleeps an asking pane under critical',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready', asking: true }], 'critical', 1000)
    .length === 0
)

ok(
  'never sleeps a pane with a job under critical',
  pressureSleepPlan(
    [{ id: 'a', createdAt: 0, status: 'ready', job: 'npm run dev' }],
    'critical',
    1000
  ).length === 0
)

ok(
  'never sleeps a mirror under critical',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready', mirror: true }], 'critical', 1000)
    .length === 0
)

ok(
  'sleeps an idle pane under critical',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready' }], 'critical', 1000).length === 1
)

ok(
  'sleeps nothing under normal',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready' }], 'normal', 1000).length === 0
)

ok(
  'warn sleeps nothing before the quiet window has held',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready' }], 'warn', 1000, {
    warnSince: 900,
    warnQuietMs: 60_000
  }).length === 0
)

ok(
  'warn sleeps once the quiet window has held',
  pressureSleepPlan([{ id: 'a', createdAt: 0, status: 'ready' }], 'warn', 70_000, {
    warnSince: 0,
    warnQuietMs: 60_000
  }).length === 1
)

{
  const panes = [
    { id: 'p0', createdAt: 0, status: 'ready' },
    { id: 'p1', createdAt: 1, status: 'ready' },
    { id: 'p2', createdAt: 2, status: 'ready' }
  ]
  const plan = pressureSleepPlan(panes, 'critical', 1000, { maxPerSweep: 2 })
  ok('maxPerSweep caps the sleep batch', plan.length === 2)
}

// roomFor -------------------------------------------------------------

ok('no room under warn regardless of free memory', roomFor('warn', 10_000) === 0)
ok('no room under critical regardless of free memory', roomFor('critical', 10_000) === 0)
ok('room is free memory over one session cost', roomFor('normal', 380) === 2)
ok('room floors at zero', roomFor('normal', 0) === 0)

console.log(`wakeplan: ${n} assertions passed`)
