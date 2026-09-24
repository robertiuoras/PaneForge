// A finished pane leaves the sidebar by itself, ten minutes later - shared/exitedSweep.ts.
//
// The trap this whole feature exists to avoid: a SLEEPING pane also wears
// `status: 'exited'` (`sleep()` in main/sessions.ts), and the app deliberately keeps that
// card so a click can wake it. The load-bearing assertions here are the refusals: asleep
// never, mirror/remote never, a question on screen never, mid-handoff never, touched
// since it died holds the clock, and a restart/wake resetting `exitedAt` is not counted.
//
// Run: npm run test:exitedsweep

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-exitedsweep-'))
const outfile = join(work, 'exitedsweep.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/exitedSweep.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { EXITED_REMOVE_MS, ASLEEP_REMOVE_MS, asleepSweep, exitedSweep, clearFinishedNow, finishedCount } =
  createRequire(import.meta.url)(outfile)

let pass = 0
function check(name, cond) {
  if (cond) {
    pass++
  } else {
    console.error(`FAIL: ${name}`)
    process.exitCode = 1
  }
}

const NOW = 1_000_000_000_000

function dead(overrides = {}) {
  return {
    id: 'p1',
    status: 'exited',
    exitedAt: NOW - EXITED_REMOVE_MS - 1000,
    ...overrides
  }
}

// A dead pane at 9:59 is kept.
{
  const p = dead({ exitedAt: NOW - (EXITED_REMOVE_MS - 60_000) })
  const out = exitedSweep([p], NOW)
  check('9:59 kept', out.length === 0)
}

// The same pane at 10:00 is removed.
{
  const p = dead({ exitedAt: NOW - EXITED_REMOVE_MS })
  const out = exitedSweep([p], NOW)
  check('10:00 removed', out.length === 1 && out[0].id === 'p1')
}

// Well past ten minutes is removed too.
{
  const out = exitedSweep([dead()], NOW)
  check('past ten minutes removed', out.length === 1)
}

// Asleep is never removed, however old, however far past the clock - THE guard.
{
  const p = dead({ asleep: NOW - 3_600_000 })
  const out = exitedSweep([p], NOW)
  check('asleep never', out.length === 0)
  check('asleep never (clearFinishedNow either)', clearFinishedNow([p]).length === 0)
}
{
  // asleep can also be a boolean-ish truthy timestamp of 0 is falsy - confirm a real
  // sleep stamp (nonzero) is what is being read, matching `Session.asleep: number`.
  const p = dead({ asleep: 1 })
  check('asleep=1 never', exitedSweep([p], NOW).length === 0)
}

// A mirror/remote pane is never touched - it is not this desk's to kill.
{
  const p = dead({ remote: true })
  check('remote never', exitedSweep([p], NOW).length === 0)
  check('remote never (clear button either)', clearFinishedNow([p]).length === 0)
}

// A question on screen holds the pane open.
{
  const p = dead({ ask: { id: 'x' } })
  check('question never', exitedSweep([p], NOW).length === 0)
}

// Mid-handoff to another machine holds the pane open.
{
  const p = dead({ handingOff: true })
  check('handoff never', exitedSweep([p], NOW).length === 0)
}

// Touched (typed/clicked) after it died holds the clock - not removed even well past ten
// minutes, because the person came back to it.
{
  const p = dead({ lastKeyboard: NOW - 1000 })
  check('recently touched held', exitedSweep([p], NOW).length === 0)
}
// Touched BEFORE it died does not hold it - that keystroke is what ended the run.
{
  const p = dead({ lastKeyboard: NOW - EXITED_REMOVE_MS - 5000 })
  check('touched before death does not hold it', exitedSweep([p], NOW).length === 1)
}

// A restart/wake resets `exitedAt` to undefined (main/sessions.ts) - a pane with no
// `exitedAt` is never counted as a finished dead pane, so a restarted pane's OLD death
// is never inherited.
{
  const p = dead({ exitedAt: undefined })
  check('restart not counted (no exitedAt)', exitedSweep([p], NOW).length === 0)
  check('restart not counted (clear button either)', clearFinishedNow([p]).length === 0)
}

// A pane still running (status !== 'exited') is never touched by either path.
{
  const p = dead({ status: 'working' })
  check('running pane never', exitedSweep([p], NOW).length === 0)
  check('running pane never (clear button either)', clearFinishedNow([p]).length === 0)
}

// clearFinishedNow removes a finished pane regardless of age - the button does not wait.
{
  const p = dead({ exitedAt: NOW - 5000 })
  check('clear button removes fresh-dead pane', clearFinishedNow([p]).length === 1)
  check('automatic sweep does not (too fresh)', exitedSweep([p], NOW).length === 0)
}

// clearFinishedNow honours the same refusals as the sweep.
{
  const p = dead({ asleep: NOW })
  check('clear button refuses asleep too', clearFinishedNow([p]).length === 0)
}

// finishedCount matches clearFinishedNow's length - what the button's label reads.
{
  const panes = [dead({ id: 'a' }), dead({ id: 'b', asleep: NOW }), dead({ id: 'c', remote: true })]
  check('finishedCount matches', finishedCount(panes) === 1)
}

// --- asleepSweep: a sleeping pane nobody touched leaves the card list too (2026-09-24) ---
{
  const T = 10_000_000
  const old = T - ASLEEP_REMOVE_MS - 1
  const nap = (over) => ({ id: 'z', status: 'exited', asleep: old, lastKeyboard: old - 5000, ...over })
  check('an untouched pane asleep 30+ min leaves', asleepSweep([nap({})], T).length === 1)
  check('asleep under 30 min stays', asleepSweep([nap({ asleep: T - 60_000 })], T).length === 0)
  check('Keep open stays', asleepSweep([nap({ keepOpen: true })], T).length === 0)
  check('touched since it fell asleep stays', asleepSweep([nap({ lastKeyboard: old + 1000 })], T).length === 0)
  check('a remote pane is not ours to remove', asleepSweep([nap({ remote: true })], T).length === 0)
  check('a question on screen stays', asleepSweep([nap({ ask: { q: 'x' } })], T).length === 0)
  check('an awake pane is not this rule', asleepSweep([nap({ asleep: undefined, status: 'idle' })], T).length === 0)
  check('the dead-pane sweep still never takes a sleeping one', exitedSweep([nap({ exitedAt: 1 })], T).length === 0)
}

console.log(`exited-sweep-test: ${pass} passed`)
if (process.exitCode) process.exit(process.exitCode)
