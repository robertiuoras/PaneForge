// Which panes may be put to sleep, and - much more of this file - which may not.
//
// Sleeping ends a real process, so every refusal here is something that would be LOST
// rather than paused. The conversation is deliberately not one of them: it is on disk and
// `--resume` brings it back, which is the whole reason a sleeping pane is cheap.
//
// The last block is a SOURCE assertion, and it is the load-bearing half. A sleeping pane
// wears `status: 'exited'` so that every existing "has this pane a live process" guard
// keeps working - and `exited` is in `reclaim.ts`'s own CLOSEABLE set, so without an
// explicit refusal both sweeps would close the very pane sleeping exists to keep, buying
// nothing at all for it (there is no agent left in a sleeping pane to reclaim).
//
//   node scripts/sleep-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-sleep-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'sleep.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/sleep.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { canSleep, keptWords, sleepRefusal, sleepWords } = require(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const idle = { status: 'idle' }

// ---------------------------------------------------------------------------
// What may sleep

ok(canSleep(idle), 'a quiet pane is exactly what this is for')
ok(canSleep({ status: 'working', lastOutput: 1 }), 'printing is not the reading - a TURN is')
ok(canSleep({ ...idle, job: '' }), 'an empty job is no job')
ok(canSleep({ ...idle, asleep: 0 }), 'never slept is not asleep')

// The two `reclaim.ts` refuses and this one must not, or the feature is unreachable on a
// desk showing every pane at once: sleeping is a press on that pane's own menu.
ok(canSleep({ ...idle, focused: true, visible: true }), 'the pane whose menu is open may sleep')

// ---------------------------------------------------------------------------
// ...and what may not

is(canSleep({ ...idle, busy: true }), false, 'a turn is running')
is(canSleep({ ...idle, asking: true }), false, 'the pane is owed an answer')
is(canSleep({ ...idle, job: 'npm' }), false, 'a shell pane running a command')
is(canSleep({ ...idle, backJob: 'node' }), false, 'a background job the turn left behind')
is(canSleep({ ...idle, mirror: true }), false, "another machine's pty is not ours to end")
is(canSleep({ status: 'exited' }), false, 'an ended run has nothing left to give back')
is(canSleep({ ...idle, asleep: 1 }), false, 'and one already asleep has given it')

// ---------------------------------------------------------------------------
// Why, in words - a greyed row that does not say which of the six it is says nothing

is(sleepRefusal(idle), '', 'no refusal, no sentence')
ok(/mid-turn/.test(sleepRefusal({ ...idle, busy: true })), 'busy says so')
ok(/waiting for an answer/.test(sleepRefusal({ ...idle, asking: true })), 'a question says so')
ok(/npm/.test(sleepRefusal({ ...idle, job: 'npm' })), 'the job is named')
ok(/another machine/.test(sleepRefusal({ ...idle, mirror: true })), 'a mirror says whose it is')
// The order matters: an asking pane that is also busy is asked about first, because the
// answer is owed to a person and the turn is not.
ok(
  /waiting for an answer/.test(sleepRefusal({ ...idle, asking: true, busy: true })),
  'the person-owed reason wins over the machine one'
)

// ---------------------------------------------------------------------------
// The words on the chip. A minute clock, because nothing finer is drawn - see AsleepChip.

const t = 1_700_000_000_000
is(sleepWords(t, t + 5_000), 'asleep', 'under a minute says nothing about the seconds')
is(sleepWords(t, t + 90_000), 'asleep 1m', 'a minute')
is(sleepWords(t, t + 59 * 60_000), 'asleep 59m', 'up to an hour')
is(sleepWords(t, t + 61 * 60_000), 'asleep 1h 01m', 'and hours are padded, for tabular figures')
is(sleepWords(t, t - 5_000), 'asleep', 'a clock behind the record never goes negative')

// ---------------------------------------------------------------------------
// The refusals that are not in this file, asserted where they live

const reclaim = readFileSync(join(root, 'src/shared/reclaim.ts'), 'utf8')
ok(/asleep\?: number/.test(reclaim), 'reclaim reads the sleeping flag')
is(
  (reclaim.match(/!p\.asleep &&/g) ?? []).length,
  2,
  'BOTH sweeps refuse it - the pressure one and the idle clock'
)

const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
ok(/if \(meta\.asleep\) return/.test(sessions), 'the exit handler does not stamp a code on a sleep')
ok(
  /\.filter\(\(s\) => s\.meta\.status !== 'exited' \|\| Boolean\(s\.meta\.asleep\)\)/.test(sessions),
  'and a sleeping pane is in the snapshot, or a restart loses the card it exists to keep'
)
// Waking must not write a terminal reset: the screen the pane went to sleep with is still
// in the renderer's xterm buffer, and that is what "it should show layout perfectly" is.
const wake = sessions.slice(sessions.indexOf('  wake(id: string)'), sessions.indexOf('   * A pane\'s folder no longer exists'))
ok(wake.length > 200, 'found wake()')
is(/RESET/.test(wake), false, 'waking writes no reset - the old screen IS the screen')

// ---------------------------------------------------------------------------
// The pin, on a card that is already saying something

// `kept open` above `asleep 2h 36m` was two readings that disagree: the word people take
// out of `open` is "still running", and a slept pane is exactly not that (reported
// 2026-08-30). The pin still means something there - both sweeps refuse a pinned pane, so
// the CARD never goes - so only the word narrows.
is(keptWords(false), 'kept open', 'a running pinned pane says what the pin does')
is(keptWords(true), 'kept', 'a sleeping one does not claim to be open')
ok(!keptWords(true).includes('open'), 'the contradiction itself is the assertion')

const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
ok(/\{keptWords\(Boolean\(s\.asleep\)\)\}/.test(app), 'the card asks keptWords rather than spelling it')
is(
  /^\s+kept open$/m.test(app),
  false,
  'and no literal `kept open` is left behind to go stale beside it'
)

console.log(`sleep: ${checks} checks passed`)
