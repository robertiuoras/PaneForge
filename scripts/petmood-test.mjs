// What the pet's face is allowed to say about the desk.
//
// Every mood here is a claim about somebody's machine - "a pane is asking you something",
// "nothing has happened for two minutes" - and the two ways a claim like that goes wrong
// are being late and being jumpy. So the weight is on the boundaries: the hold that stops
// a mood strobing, the one mood that is allowed to jump the hold, a cheer that has to end
// on its own, and a quiet desk that must not fall asleep while one pane is still being
// typed into.
//
//   node scripts/petmood-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-petmood-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'petmood.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/petMood.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { petMood, nextMoodAt, firstMood, CHEER_MS, NAP_AFTER_MS, MIN_HOLD_MS } =
  createRequire(import.meta.url)(outfile)

let n = 0
const ok = (what) => {
  n++
  console.log('  ok  ' + what)
}

/** One pane, with only the four readings this module is allowed to look at. */
const pane = (id, over = {}) => ({
  id,
  pane: 1,
  name: 'PaneForge',
  state: 'ready',
  memMb: 200,
  idleMs: 0,
  remote: false,
  asking: false,
  ...over
})

const T = 1_000_000

// ---- every mood, from a state that has been sitting there long enough to be replaced ---
const settled = (mood, over = {}) => ({
  mood,
  since: T - 10 * MIN_HOLD_MS,
  wasWorking: new Set(),
  ...over
})

assert.equal(petMood([], T, settled('idle')).mood, 'idle')
assert.equal(petMood([pane('a')], T, settled('idle')).mood, 'idle')
ok('an empty desk, and a desk doing nothing, are both idle')

assert.equal(petMood([pane('a', { asking: true })], T, settled('idle')).mood, 'alert')
ok('a live question is alert')

assert.equal(petMood([pane('a', { state: 'working' })], T, settled('idle')).mood, 'work')
ok('something printing is work')

// A question outranks work: a desk where one pane prints while another waits on a person
// is a desk whose one urgent reading is the person.
assert.equal(
  petMood([pane('a', { state: 'working' }), pane('b', { asking: true })], T, settled('idle')).mood,
  'alert'
)
ok('a question outranks a printing pane')

// ---- cheer: the difference between two readings, not a state any pane carries ----------
const wasA = settled('work', { wasWorking: new Set(['a']) })
const finished = petMood([pane('a', { state: 'needsYou' })], T, wasA)
assert.equal(finished.mood, 'cheer')
assert.equal(finished.cheerUntil, T + CHEER_MS)
ok('a pane that was working and is now waiting for you is a cheer')

assert.equal(petMood([pane('a', { state: 'ready' })], T, wasA).mood, 'cheer')
ok('...and finishing into ready counts too')

// It has to END. Held to the deadline, gone the moment it passes.
const late = petMood([pane('a', { state: 'needsYou' })], T + CHEER_MS - 1, finished)
assert.equal(late.mood, 'cheer')
const over = petMood([pane('a', { state: 'needsYou' })], T + CHEER_MS + 1, finished)
assert.equal(over.mood, 'idle')
assert.equal(over.cheerUntil, undefined)
ok(`a cheer expires after ${CHEER_MS}ms and clears its own deadline`)

// A pane that was never working has not finished anything - the same list read twice must
// not cheer a second time, which is what would happen if this keyed on state alone.
const again = petMood([pane('a', { state: 'needsYou' })], T + CHEER_MS + 2, over)
assert.equal(again.mood, 'idle')
ok('a finished pane read again does not cheer again')

// ---- nap: the newest idle reading on the desk, not the oldest --------------------------
const oldPane = pane('a', { idleMs: NAP_AFTER_MS + 5000 })
assert.equal(petMood([oldPane], T, settled('idle')).mood, 'nap')
ok(`nothing touched for ${NAP_AFTER_MS / 60000} minutes is a nap`)

assert.equal(petMood([oldPane, pane('b', { idleMs: 1000 })], T, settled('idle')).mood, 'idle')
ok('one pane somebody is still typing into keeps the whole desk awake')

assert.equal(petMood([pane('a', { idleMs: NAP_AFTER_MS - 1 })], T, settled('idle')).mood, 'idle')
assert.equal(petMood([pane('a', { idleMs: NAP_AFTER_MS })], T, settled('idle')).mood, 'nap')
ok('the quiet period is a boundary, not a guess')

// Quiet is not the only condition: a pane can be printing without anybody touching it.
assert.equal(
  petMood([pane('a', { idleMs: NAP_AFTER_MS * 3, state: 'working' })], T, settled('idle')).mood,
  'work'
)
assert.equal(
  petMood([pane('a', { idleMs: NAP_AFTER_MS * 3, asking: true })], T, settled('idle')).mood,
  'alert'
)
ok('a long-quiet pane that is working, or asking, does not sleep')

// ---- hysteresis: a mood holds, and exactly one thing may jump it -----------------------
const fresh = { mood: 'idle', since: T, wasWorking: new Set() }
assert.equal(petMood([pane('a', { state: 'working' })], T + MIN_HOLD_MS - 1, fresh).mood, 'idle')
assert.equal(petMood([pane('a', { state: 'working' })], T + MIN_HOLD_MS, fresh).mood, 'work')
ok(`a mood holds ${MIN_HOLD_MS}ms before another may replace it`)

assert.equal(petMood([pane('a', { asking: true })], T + 1, fresh).mood, 'alert')
ok('a question jumps the hold - it is the one reading somebody is blocked by')

// The clock starts when the mood is ENTERED, and a reading that changes nothing must not
// restart it - otherwise a busy desk holds the first mood for ever.
const entered = petMood([pane('a', { state: 'working' })], T + MIN_HOLD_MS, fresh)
assert.equal(entered.since, T + MIN_HOLD_MS)
const same = petMood([pane('a', { state: 'working' })], T + MIN_HOLD_MS + 10, entered)
assert.equal(same.since, entered.since)
ok('the hold is measured from the moment the mood was entered')

// ---- where a press goes ---------------------------------------------------------------
// `idleMs` on an asking pane is the time since it printed, which is the time since it put
// the question up - so the largest one has been waiting longest.
const two = petMood(
  [pane('a', { asking: true, idleMs: 4000 }), pane('b', { asking: true, idleMs: 90_000 })],
  T,
  settled('idle')
)
assert.equal(two.mood, 'alert')
assert.equal(two.goto, 'b')
ok('with several asking, the press goes to the one that has waited longest')

assert.equal(petMood([pane('a', { state: 'working' })], T, settled('idle')).goto, undefined)
ok('no pane to go to in any other mood')

// ---- the one timer --------------------------------------------------------------------
assert.equal(nextMoodAt([], T, settled('idle')), null)
assert.equal(nextMoodAt([oldPane], T, settled('nap')), null)
ok('a desk that cannot change on its own arms no timer')

assert.equal(
  nextMoodAt([pane('a', { idleMs: NAP_AFTER_MS - 30_000 })], T, settled('idle')),
  T + 30_000
)
ok('a quiet desk arms one timer at the moment it would fall asleep')

assert.equal(nextMoodAt([pane('a', { state: 'needsYou' })], T, finished), T + CHEER_MS)
ok('a cheer arms one timer at its own end')

assert.equal(nextMoodAt([pane('a', { state: 'working' })], T + 100, fresh), T + MIN_HOLD_MS)
ok('a change the hold is refusing arms one timer at the end of the hold')

// Nothing here is allowed to sleep while a question is up, so nothing is waiting for.
assert.equal(nextMoodAt([pane('a', { asking: true })], T, settled('alert')), null)
ok('a question arms nothing - it ends when it is answered, not on a clock')

assert.deepEqual(firstMood(T), { mood: 'idle', since: T, wasWorking: new Set() })
ok('a window starts with nothing seen and nothing to say')

console.log(`\nok: ${n} checks - the pet's face is a reading of the desk and holds still enough to read`)
