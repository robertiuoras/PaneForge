// What the full suite decides around its suites, pinned off the PC.
//
// test-all.mjs hands itself to the PC on any other machine, so its own decisions are kept in
// suite-plan.mjs and checked here: which lane suites may be skipped because the lane scripts
// they run are byte-for-byte what already passed, and how a red suite is told apart as a
// flake (passes on its own) or a real failure (fails again on its own).
//
//   node scripts/suite-plan-test.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dispatcher, fingerprint, planRun, readPasses, readTimes, recordPass, recordTimes, retryAlone, suiteInputs, summary
} from './suite-plan.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-suite-plan-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

// --- the real lane suites name what they run -------------------------------------------
const gate = suiteInputs(root, 'release-gate-test.mjs')
ok(gate.includes('scripts/release-gate-test.mjs'), 'a suite is one of its own inputs', gate)
ok(gate.includes('scripts/lane.mjs'), 'the gate suite spawns lane.mjs by name, so lane.mjs is an input', gate)
ok(gate.includes('scripts/lane-merge.mjs'), 'and what lane.mjs imports is an input too', gate)
const completion = suiteInputs(root, 'lane-completion-test.mjs')
ok(completion.includes('scripts/pf-ctl-lib.mjs'), 'lanecompletion reaches pf-ctl-lib.mjs through pf-ctl.mjs', completion)
ok(gate.every((f) => f.startsWith('scripts/')), 'the gate suite runs nothing outside scripts/', gate)

// --- a fixture repo whose suite names one script that imports another -------------------
const repo = join(work, 'repo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
const put = (name, text) => writeFileSync(join(repo, 'scripts', name), text)
put('a-test.mjs', "import { spawnSync } from 'node:child_process'\nspawnSync(process.execPath, [join(here, 'b.mjs')])\n")
put('b.mjs', "import { c } from './c.mjs'\nconsole.log(c)\n")
put('c.mjs', 'export const c = 1\n')
put('d.mjs', 'export const d = 1\n')
put('built-test.mjs', "import { buildSync } from 'esbuild'\nbuildSync({ entryPoints: ['src/main/x.ts'] })\n")

const inputs = suiteInputs(repo, 'a-test.mjs')
ok(JSON.stringify(inputs) === JSON.stringify(['scripts/a-test.mjs', 'scripts/b.mjs', 'scripts/c.mjs']),
  'inputs are the suite, the script it names, and that script\'s imports - nothing else', inputs)
const fp0 = fingerprint(repo, inputs)
put('d.mjs', 'export const d = 2\n')
ok(fingerprint(repo, inputs) === fp0, 'a file the suite never runs does not change its fingerprint')
put('c.mjs', 'export const c = 2\n')
const fp1 = fingerprint(repo, inputs)
ok(fp1 !== fp0, 'a change two imports deep does')
put('c.mjs', 'export const c = 2\r\n')
ok(fingerprint(repo, inputs) === fp1, 'line endings alone do not (a Windows checkout of the same bytes)')

let threw = ''
try { suiteInputs(repo, 'built-test.mjs') } catch (e) { threw = e.message }
ok(/builds/.test(threw), 'a suite that bundles app code at run time has inputs nobody can list, so it is refused', threw)

// --- the record of passes -----------------------------------------------------------------
const passes = join(work, 'cache', 'suite-passes.json')
ok(JSON.stringify(readPasses(passes)) === '{}', 'no record yet reads as no passes')
recordPass(passes, 'gate', 'f1')
ok(readPasses(passes).gate?.some((p) => p.fp === 'f1'), 'a recorded pass is read back')
writeFileSync(passes, '{not json')
ok(JSON.stringify(readPasses(passes)) === '{}', 'a torn record reads as no passes, never as a throw')
for (let i = 0; i < 40; i++) recordPass(passes, 'gate', `f${i}`)
ok(readPasses(passes).gate.length <= 20, 'the record keeps the recent passes, not every one ever', readPasses(passes).gate.length)
ok(readPasses(passes).gate.some((p) => p.fp === 'f39'), 'and the newest is among them')

// --- which suites run ----------------------------------------------------------------------
const entries = [['quick', 'quick-test.mjs'], ['gate', 'gate-test.mjs'], ['broken', 'broken-test.mjs']]
const fpOf = (file) => {
  if (file === 'broken-test.mjs') throw new Error('cannot read')
  return 'same'
}
const cacheable = new Set(['gate', 'broken'])
const seen = { gate: [{ fp: 'same', at: 1 }], broken: [{ fp: 'same', at: 1 }] }
let plan = planRun(entries, { cacheable, full: false, passes: seen, fingerprintOf: fpOf })
ok(JSON.stringify(plan.run.map(([n]) => n)) === '["quick","broken"]', 'a lane suite whose inputs already passed is not run', plan.run)
ok(JSON.stringify(plan.skipped) === '["gate"]', 'and it is named as skipped', plan.skipped)
ok(plan.fps.get('gate') === 'same' && !plan.fps.has('broken'), 'a suite whose inputs cannot be read always runs, with nothing to record')
plan = planRun(entries, { cacheable, full: false, passes: { gate: [{ fp: 'other', at: 1 }] }, fingerprintOf: fpOf })
ok(plan.run.some(([n]) => n === 'gate'), 'changed lane scripts run the lane suite')
plan = planRun(entries, { cacheable, full: true, passes: seen, fingerprintOf: fpOf })
ok(plan.run.length === 3 && plan.skipped.length === 0, 'a full run (a release) runs every suite')
ok(plan.fps.get('gate') === 'same', 'and still fingerprints them, so its passes are recorded')

// --- a red suite, run again on its own --------------------------------------------------
const calls = []
const second = { flaky: true, real: false }
const verdict = await retryAlone(
  [{ name: 'flaky', file: 'flaky-test.mjs' }, { name: 'real', file: 'real-test.mjs' }],
  async (entry) => {
    calls.push(entry.name)
    return { name: entry.name, ok: second[entry.name], secs: '1.0', out: entry.name === 'real' ? 'FAIL still broken' : '' }
  }
)
ok(JSON.stringify(calls) === '["flaky","real"]', 'every red suite runs once more, one at a time', calls)
ok(JSON.stringify(verdict.flaky) === '["flaky"]', 'a suite that passes on its own is a flake', verdict)
ok(verdict.real.length === 1 && verdict.real[0].name === 'real' && /still broken/.test(verdict.real[0].out),
  'a suite that fails again on its own is real, with its second output kept', verdict)

// --- which suite a free worker takes next -------------------------------------------------
const drain = (take, worker) => { const got = []; for (let i = take(worker); i >= 0; i = take(worker)) got.push(i); return got }
const listed = ['a', 'b', 'c', 'slow', 'd', 'slowest', 'e']
const secs = { a: 1, b: 2, c: 1, slow: 200, d: 3, slowest: 600, e: 31 }
let take = dispatcher(listed, {}, 8)
ok(JSON.stringify(drain(take, 0)) === '[0,1,2,3,4,5,6]', 'with no times known the pool takes the listed order, as it always did')
take = dispatcher(listed, secs, 8)
ok(JSON.stringify([take(0), take(1), take(2)]) === '[5,3,6]', 'the long workers start the slowest suites first, longest first')
ok(take(6) === 0 && take(7) === 1, 'the last two workers take the cheap suites in listed order')
take = dispatcher(listed, secs, 8)
ok(JSON.stringify(drain(take, 7)) === '[0,1,2,4,5,3,6]', 'a cheap worker with no cheap suites left helps with the long ones, longest first')
take = dispatcher(listed, secs, 2)
ok(take(0) === 5 && take(1) === 0, 'two workers: one starts the slowest, one keeps the cheap order')
take = dispatcher(listed, secs, 1)
ok(JSON.stringify(drain(take, 0)) === '[5,3,6,0,1,2,4]', 'one worker still starts the slowest first, then the rest in listed order')
take = dispatcher(listed, { ...secs, newsuite: 900 }, 8)
ok(take(0) === 5, 'a time for a suite that is not in this run changes nothing')
take = dispatcher(['x', 'y', 'z'], { x: 50, y: 50, z: 50 }, 8)
ok(JSON.stringify(drain(take, 0)) === '[0,1,2]', 'equally slow suites keep their listed order')

const timesPath = join(work, 'times', 'suite-times.json')
ok(JSON.stringify(readTimes(timesPath)) === '{}', 'no times file reads as nothing known')
recordTimes(timesPath, { a: 1.5, slow: 200 })
recordTimes(timesPath, { slow: 180 })
ok(JSON.stringify(readTimes(timesPath)) === '{"a":1.5,"slow":180}', 'a new time replaces the old one and keeps the rest', readTimes(timesPath))
writeFileSync(timesPath, '{"a": 1.5, "slow": ')
ok(JSON.stringify(readTimes(timesPath)) === '{}', 'a torn times file reads as nothing known, never a throw')
writeFileSync(timesPath, '{"a": "fast", "b": -1, "c": 4}')
ok(JSON.stringify(readTimes(timesPath)) === '{"c":4}', 'only real durations are trusted', readTimes(timesPath))

// --- the last lines, which other tools read -------------------------------------------------
let lines = summary({ total: 300, secs: '120.5', real: [], flaky: ['promptsubmit'], skipped: ['gate', 'lanecleared'] })
ok(/^\d+ tests passed in [\d.]+s$/.test(lines[0]), 'a run whose only reds were flakes still says it passed, in the shape the gate reads', lines)
ok(lines[0] === '298 tests passed in 120.5s', 'and counts only what ran', lines)
ok(lines.some((l) => /flaky/.test(l) && /promptsubmit/.test(l)), 'the flake is named, never silently dropped', lines)
ok(lines.some((l) => /2 lane suites/.test(l) && /gate, lanecleared/.test(l)), 'the skipped lane suites are named', lines)
lines = summary({ total: 300, secs: '120.5', real: ['gate'], flaky: ['promptsubmit'], skipped: [] })
ok(lines[0] === '1 of 300 failed in 120.5s: gate', 'a real failure is the verdict, and only real ones are counted', lines)
ok(lines.some((l) => /flaky/.test(l) && /promptsubmit/.test(l)), 'with the flakes beside it', lines)

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
