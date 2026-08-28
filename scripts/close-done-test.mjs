// A pane automation opened for one job, closing itself once the job is really over.
//
// The weight is in the negatives, as usual, and for a sharper reason than most: this is
// the only rule in the app that CLOSES a pane with nobody watching and no countdown in
// front of it. Everything it refuses is work that would be lost - a turn still running, a
// question nobody answered, a build an agent left in the background - and the last of
// those is why "the turn ended" is not the reading: that answer comes off a process table
// sampled every four seconds, so a pane closing on its turn's own edge takes the build.
//
// The last block is a SOURCE assertion: a decision nothing calls closes nothing.
//
//   node scripts/close-done-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-close-done-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'closeWhenDone.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/closeWhenDone.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { doneEnough, CLOSE_DONE_QUIET_MS } = require(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}

const NOW = 1_000_000_000
const QUIET = CLOSE_DONE_QUIET_MS
const done = { printed: NOW - 60_000, status: 'idle' }

// ---------------------------------------------------------------- what closes
ok(doneEnough(done, QUIET, NOW), 'a pane that printed, finished and went quiet closes itself')
ok(doneEnough({ ...done, busyUntil: NOW - 1 }, QUIET, NOW), 'a footer that has already expired is not busy')
is(CLOSE_DONE_QUIET_MS, 8_000, 'two process-table samples plus the sweep, and it is a named number')

// ------------------------------------------------------------ what does not
is(doneEnough(done, QUIET - 1, NOW), false, 'not one millisecond before the quiet window is up')
is(doneEnough({ ...done, printed: undefined }, QUIET, NOW), false, 'a pane that has printed nothing has not started, let alone finished')
is(doneEnough({ ...done, runSince: NOW - 1000 }, QUIET, NOW), false, 'never mid-turn')
is(doneEnough({ ...done, busyUntil: NOW + 1000 }, QUIET, NOW), false, "...nor while the CLI's own footer still says so")
is(doneEnough({ ...done, ask: { title: 'Which?' } }, QUIET, NOW), false, 'never a pane holding a question - the answer would be thrown away')
is(doneEnough({ ...done, job: 'npm' }, QUIET, NOW), false, 'never while a command is running in front of the tty')
is(doneEnough({ ...done, backJob: 'npm' }, QUIET, NOW), false, 'never while the agent left something running in the background')
is(doneEnough({ ...done, status: 'exited' }, QUIET, NOW), false, 'an ended pane has nothing to close')
is(doneEnough({ ...done, asleep: NOW - 1000 }, QUIET, NOW), false, 'and a SLEEPING pane is being kept, not finished')

// ------------------------------------------------------------- the wiring
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
ok(/if \(live\.req\.closeWhenDone\) this\.sweepCloseWhenDone\(live, now, quiet\)/.test(sessions), 'the idle sweep asks, every second')
ok(/doneEnough\(\{ \.\.\.meta, busyUntil: live\.busyUntil \}, quiet, now\)/.test(sessions), '...through this rule, with the footer reading it alone holds')
// Told BEFORE the kill: `kill()` deletes the session, and the request naming who to tell
// goes with it.
const body = sessions.slice(sessions.indexOf('private sweepCloseWhenDone'), sessions.indexOf('/** Start a countdown that was queued'))
ok(body.indexOf('queuePrompt') < body.indexOf('this.kill(meta.id)'), 'the opener is told before the pane is killed')
ok(/PF_PANE: id/.test(sessions), 'every pane knows which pane it is, so `pf` can name the opener')

const ctl = readFileSync(join(root, 'scripts/pf-ctl.mjs'), 'utf8')
ok(/--close-when-done/.test(ctl), 'pf open takes the flag')
ok(/process\.env\.PF_PANE/.test(ctl), '...and reports back to the pane that ran it, unasked')

rmSync(work, { recursive: true, force: true })
console.log(`close-done: ${checks} checks passed`)
