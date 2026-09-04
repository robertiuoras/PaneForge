// A pane opened on a NAMED device, for any CLI/model, many at once.
//
// `placeNewPane`'s device branch is the decision half: given a name, is that device usable
// right now. It never falls back to this machine - see `Placement.refused` - because
// "start it on the PC" that silently opened on the Mac instead is the exact failure mode
// every other refusal in this file is written to avoid.
//
//   node scripts/device-open-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-device-open-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'offloadfirst.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/offloadFirst.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { placeNewPane, PEER_FULL_PANES, PEER_HARD_PANES } = require(out)

let checks = 0
let failed = 0
const is = (actual, expected, what) => {
  checks++
  if (actual !== expected) {
    failed++
    console.error(`  FAIL ${what}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const ok = (cond, what) => is(!!cond, true, what)

const at = (over) => ({
  shareable: true,
  prompt: 'add a unit test for the date parser and make it pass',
  cwd: '/Users/robert/Projects/taskdriver',
  peerAlive: true,
  peerBusyPanes: 0,
  pressure: 'normal',
  mode: 'auto',
  ...over
})

// --- device online and holding the project: goes there ----------------------------------

{
  const p = placeNewPane(at({ device: 'The PC', deviceOnline: true, deviceHasProject: true }))
  is(p.where, 'remote', 'device online + has project -> remote')
  is(p.refused, undefined, 'no refusal when it worked')
  ok(p.reason.includes('The PC'), 'reason names the device')
}

// --- offline: refused by name, never falls back to local ---------------------------------

{
  const p = placeNewPane(at({ device: 'The PC', deviceOnline: false, deviceHasProject: true }))
  is(p.where, 'local', 'offline device: where reads local for callers that only check that')
  ok(typeof p.refused === 'string', 'offline device sets refused')
  ok(p.refused.includes('The PC'), 'refusal names the device')
  ok(/not online/.test(p.refused), 'refusal says why')
}

// --- online but lacks the project: refused, not guessed onto -----------------------------

{
  const p = placeNewPane(at({ device: 'The PC', deviceOnline: true, deviceHasProject: false }))
  ok(typeof p.refused === 'string', 'online-but-no-project sets refused')
  ok(/does not have this project/.test(p.refused), 'refusal names the actual reason')
}

// --- unconfirmed (undefined) reads as no, same caution as `shareable` --------------------

{
  const p = placeNewPane(at({ device: 'The PC', deviceOnline: true, deviceHasProject: undefined }))
  ok(typeof p.refused === 'string', 'unconfirmed project membership refuses, never guesses yes')
}

// --- a device beats `where` - an explicit local pick still loses to a named device --------

{
  const p = placeNewPane(at({ where: 'local', device: 'The PC', deviceOnline: true, deviceHasProject: true }))
  is(p.where, 'remote', 'device beats where=local')
}

// --- soft cap (PEER_FULL_PANES) does not stop an explicit device pick --------------------

{
  const p = placeNewPane(
    at({ device: 'The PC', deviceOnline: true, deviceHasProject: true, peerBusyPanes: PEER_FULL_PANES + 5 })
  )
  is(p.where, 'remote', 'an explicit device pick goes past the soft cap')
}

// --- hard cap still stops it, refused rather than silently piling on ---------------------

{
  const p = placeNewPane(
    at({ device: 'The PC', deviceOnline: true, deviceHasProject: true, peerBusyPanes: PEER_HARD_PANES })
  )
  ok(typeof p.refused === 'string', 'the hard cap refuses rather than piling on')
  ok(/already running/.test(p.refused), 'refusal says the machine is already running that many')
}

// --- no device named: today's behaviour, unchanged ----------------------------------------

{
  const p = placeNewPane(at({}))
  is(p.refused, undefined, 'no device named -> no refusal, ordinary auto/where behaviour')
}

for (const c of [
  { device: 'The PC', deviceOnline: true, deviceHasProject: true },
  { device: 'The PC', deviceOnline: false, deviceHasProject: true },
  { device: 'The PC', deviceOnline: true, deviceHasProject: false }
]) {
  const p = placeNewPane(at(c))
  ok(!/\b(lane|worktree|trunk|checkout|origin|repo|commit)\b/i.test(p.reason), `plain words: "${p.reason}"`)
}

// --- pf-ctl.mjs: `open-many` reads a plan file and never touches a live app --------------

{
  // pf-ctl.mjs has a top-level `await main()` guarded by `isMain`, which makes it an async
  // module graph - `require()` refuses that (ERR_REQUIRE_ASYNC_MODULE) even though `isMain`
  // is false here. `import()` is the awaitable form and does not run `main()`: `isMain`
  // compares `import.meta.url` to `process.argv[1]`, which is THIS test file, not pf-ctl.mjs.
  const { readOpenManyPlan } = await import(pathToFileURL(pfCtlExports()).href)
  const planPath = join(work, 'plan.json')
  writeFileSync(
    planPath,
    JSON.stringify([
      { cwd: '/Users/robert/Projects/a', prompt: 'do a thing', on: 'The PC' },
      { cwd: '/Users/robert/Projects/b', task: 'BL-4', agent: 'claude', model: 'opus' }
    ])
  )
  const plan = readOpenManyPlan(planPath)
  is(plan.length, 2, 'reads both rows out of the plan file')
  is(plan[0].device, 'The PC', '"on" maps to the device field')
  is(plan[1].task, 'BL-4', 'a task-briefed row keeps its task id')
}

function pfCtlExports() {
  // pf-ctl.mjs is a script, not a module with exports today - `readOpenManyPlan` and the
  // arg-parsing helpers are exported alongside it so this suite (and any other caller) can
  // check the parsing without a running app. See the export block at the end of pf-ctl.mjs.
  return join(root, 'scripts', 'pf-ctl.mjs')
}

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`device-open: ${failed} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`device-open: ${checks} checks passed`)
