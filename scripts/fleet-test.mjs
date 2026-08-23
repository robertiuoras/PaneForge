// What the Fleet screen decides, without a window.
//
// The Fleet view's whole value is its FIRST ROW: if the pane that needs a person is not
// at the top, the screen is a prettier sidebar and nothing else. So most of what is
// pinned here is ordering and precedence - which state wins when a pane is two things at
// once, and which clock a row counts.
//
//   node scripts/fleet-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-fleet-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'fleet.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/fleet.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { density, fleetOrder, fleetRow, fleetSections, fleetState, fleetWaiting, gitLine, previewFrom } = createRequire(
  import.meta.url
)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

let n = 0
/** A session with only the fields this file reads, so a change elsewhere cannot break it. */
const sess = (over = {}) => ({
  id: `s${++n}`,
  title: 'pane',
  cwd: '/repo',
  agent: 'claude',
  status: 'idle',
  lastOutput: 1000,
  createdAt: 0,
  ...over
})

// ---------------------------------------------------------------------------
// Which state a pane is in

is(fleetState(sess({ status: 'working' })), 'working', 'a printing pane is working')
is(fleetState(sess({ status: 'starting' })), 'starting', 'and one with nothing on screen is starting')
is(fleetState(sess({ status: 'exited' })), 'exited', 'a dead process is dead')
is(
  fleetState(sess({ status: 'idle', engaged: true })),
  'needsYou',
  'a pane that finished what it was asked wants you'
)
is(
  fleetState(sess({ status: 'idle', engaged: false })),
  'ready',
  'a CLI nobody has typed into has FINISHED nothing - it must not read as your move'
)

// Precedence. Each of these is a pane that is genuinely two things at once, and the
// answer is the one a person has to act on.
is(
  fleetState(sess({ status: 'working', stalledSince: 500 })),
  'stalled',
  'a stalled pane is still "working" to the pty, which is exactly what makes it worth saying'
)
is(
  fleetState(sess({ status: 'working', bell: true })),
  'needsYou',
  'a rung bell outranks a live turn: the CLI can ask a question mid-run'
)
is(
  fleetState(sess({ status: 'working', bell: true, stalledSince: 500 })),
  'needsYou',
  'and it outranks a stall too'
)
is(
  fleetState(sess({ status: 'exited', bell: true })),
  'exited',
  'but nothing outranks the process being gone'
)
is(
  fleetState(sess({ status: 'idle', engaged: false, bell: true })),
  'needsYou',
  'a bell means it was asked something after all'
)

// ---------------------------------------------------------------------------
// What the row says, and which clock it counts

is(fleetRow(sess({ status: 'working', runSince: 700 })).since, 700, 'a working row counts its turn')
is(
  fleetRow(sess({ status: 'working' })).since,
  1000,
  'and falls back to the last output rather than showing no clock at all'
)
is(
  fleetRow(sess({ status: 'working', runSince: 700, stalledSince: 900 })).since,
  900,
  'a stalled row counts the SILENCE, not the turn - the turn length is not the complaint'
)
is(
  fleetRow(sess({ status: 'idle', engaged: true })).since,
  1000,
  'a finished row counts how long it has been waiting on you'
)
is(fleetRow(sess({ status: 'idle', engaged: false })).since, undefined, 'an untouched CLI has no clock')
is(fleetRow(sess({ status: 'exited' })).since, undefined, 'and neither has a dead one')

is(fleetRow(sess({ status: 'exited', exitCode: 1 })).label, 'exited (1)', 'a bad exit says so')
is(fleetRow(sess({ status: 'exited', exitCode: 0 })).label, 'exited', 'a clean one does not need a number')

// ---------------------------------------------------------------------------
// Motion is the signal
//
// The rule this screen is built on: two motions, meaning different things, and a
// terminal state that is perfectly still. If everything moved, nothing would.

is(fleetRow(sess({ status: 'working' })).motion, 'pulse', 'the app working pulses')
is(fleetRow(sess({ status: 'starting' })).motion, 'pulse', 'so does one about to')
is(fleetRow(sess({ status: 'idle', engaged: true })).motion, 'call', 'the app waiting on YOU calls')
is(fleetRow(sess({ status: 'working', stalledSince: 1 })).motion, 'call', 'and so does a stall')
is(fleetRow(sess({ status: 'exited' })).motion, 'still', 'a finished pane is perfectly still')
is(fleetRow(sess({ status: 'idle', engaged: false })).motion, 'still', 'and so is one nobody has used')

// ---------------------------------------------------------------------------
// The order, which is the whole feature

{
  const working = sess({ status: 'working', runSince: 10 })
  const ready = sess({ status: 'idle', engaged: false })
  const needs = sess({ status: 'idle', engaged: true, lastOutput: 500 })
  const dead = sess({ status: 'exited' })
  const stalled = sess({ status: 'working', stalledSince: 300 })
  const order = fleetOrder([working, ready, dead, needs, stalled]).map((s) => fleetState(s))
  is(
    order,
    ['needsYou', 'stalled', 'working', 'ready', 'exited'],
    'whoever needs a person is at the top, and the dead are at the bottom'
  )
}

{
  // Two panes in the same state keep the numbering they were handed in. Sorting them by
  // age reads well and is what made the list unpointable: the clock a finished pane
  // counts from is `lastOutput`, so every frame either of them painted swapped the rows.
  const old = sess({ status: 'idle', engaged: true, lastOutput: 100 })
  const recent = sess({ status: 'idle', engaged: true, lastOutput: 900 })
  is(
    fleetOrder([recent, old]).map((s) => s.id),
    [recent.id, old.id],
    'inside one state, the order the sidebar numbers them - never the clock, which moves'
  )
}

{
  // The control for the case above: a pane whose clock moves must not move the row. Same
  // two panes, one of them having just printed, and the order is unchanged.
  const a = sess({ status: 'working', runSince: 10, lastOutput: 10 })
  const b = sess({ status: 'working', runSince: 20, lastOutput: 20 })
  const before = fleetOrder([a, b]).map((s) => s.id)
  b.lastOutput = 9999
  b.runSince = 9999
  is(fleetOrder([a, b]).map((s) => s.id), before, 'a pane printing does not reshuffle the list')
}

{
  // Nothing to sort by must not reshuffle the screen under the mouse.
  const a = sess({ status: 'idle', engaged: false })
  const b = sess({ status: 'idle', engaged: false })
  const c = sess({ status: 'idle', engaged: false })
  is(
    fleetOrder([b, c, a]).map((s) => s.id),
    [b.id, c.id, a.id],
    'panes with no clock keep the order they were opened in'
  )
}

is(fleetOrder([]), [], 'no panes is not an error')

is(
  fleetWaiting([
    sess({ status: 'working' }),
    sess({ status: 'idle', engaged: true }),
    sess({ status: 'working', stalledSince: 1 }),
    sess({ status: 'exited' })
  ]),
  2,
  'the badge counts a stall as wanting you, because it does'
)
is(fleetWaiting([sess({ status: 'working' })]), 0, 'and a busy pane is not an interruption')

// ---------------------------------------------------------------------------
// Diff density
//
// The reason this is log-scaled rather than linear, in one assertion: beside a 3,000-line
// refactor, a 40-line change has to still be visible.

is(density(0, 0), { weight: 0, added: 0, removed: 0, total: 0 }, 'nothing changed draws nothing')
ok(density(40, 0).weight > 0.35, `40 lines is clearly visible (${density(40, 0).weight.toFixed(2)})`)
ok(density(3000, 0).weight === 1, 'and a huge one is full width rather than off the end')
ok(
  density(3000, 0).weight / density(40, 0).weight < 3,
  'the big one is not 75x the small one, which is what linear would draw'
)
{
  const d = density(30, 10)
  ok(Math.abs(d.added - 0.75) < 1e-9, 'the split is the real proportion of added lines')
  ok(Math.abs(d.added + d.removed - 1) < 1e-9, 'and the two ends fill the bar')
  is(d.total, 40, 'total is what it says')
}
ok(density(1, 0).weight > 0, 'one changed line is not rounded away to nothing')

// ---------------------------------------------------------------------------
// The git line

is(gitLine(null), null, 'a folder that is not a repo says nothing rather than "clean"')
is(gitLine(undefined), null, 'and so does one git has not answered for yet')
is(
  gitLine({ branch: 'main', ahead: 0, behind: 0, dirty: 0, staged: 0, detached: false }),
  'clean',
  'a repo with nothing in it says so'
)
is(
  gitLine({ branch: 'main', ahead: 2, behind: 1, dirty: 7, staged: 3, detached: false }),
  '7 changed · 2 to push · 1 to pull',
  'and one with something says all of it, in words'
)

// ---------------------------------------------------------------------------
// Sections: the screen in groups, so reading stops at the first boundary

{
  const mk = (id, over) => ({ id, status: 'idle', engaged: false, ...over })
  const needs = mk('n', { engaged: true })
  const work = mk('w', { status: 'working' })
  const ready = mk('r', {})
  const dead = mk('x', { status: 'exited' })
  const secs = fleetSections([ready, dead, work, needs])
  is(
    secs.map((g) => g.key),
    ['yourMove', 'running', 'idle', 'ended'],
    'sections come urgent-first, whatever order the panes opened in'
  )
  is(
    secs.map((g) => g.sessions.map((s) => s.id)),
    [['n'], ['w'], ['r'], ['x']],
    'and each pane sits under its own heading'
  )
  const some = fleetSections([work, ready])
  is(some.map((g) => g.key), ['running', 'idle'], 'a section with nobody in it is not drawn')
  is(fleetSections([]), [], 'no panes, no headings')
  ok(
    fleetSections([mk('a', { status: 'working', stalledSince: 5 })])[0].key === 'yourMove',
    'a stalled pane files under Your move, not Running'
  )
}

// ---------------------------------------------------------------------------
// The preview line: what the pane last said, minus the furniture

is(previewFrom(['npm test', '43 checks passed', '']), '43 checks passed', 'the last line with words wins')
is(
  previewFrom(['Do you want to proceed?', '╭──────────────╮', '│ ❯ 1. Yes     │', '╰──────────────╯']),
  '❯ 1. Yes',
  'a drawn input box is read through its frame, not skipped as one'
)
is(previewFrom(['error: thing broke', '───────────', '  ', '']), 'error: thing broke', 'rules and blanks are furniture')
is(previewFrom(['❯', '', ' ']), null, 'a bare prompt char is not a preview')
is(previewFrom([]), null, 'an empty buffer says nothing')
is(previewFrom(['   spaced   out   words  ']), 'spaced out words', 'runs of spaces collapse - the row is one line tall')
{
  const long = 'x'.repeat(400)
  const p = previewFrom([long])
  ok(p.length <= 160 && p.endsWith('…'), 'a huge line is cut, with the cut said out loud')
}
is(previewFrom(['✻ Thinking…', '⠋ ⠙ ⠹']), '✻ Thinking…', 'a spinner row is furniture but a labelled one is words')

console.log(`\n${checks} checks - all good`)
