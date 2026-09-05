// What a reopened pane inherits, and the turn a restart cut in half.
//
// Two bugs measured on this desk 2026-08-21, both from the same hole: `snapshot()` wrote
// the pane's FOLDER, agent and transcript ids and none of what the person knows about the
// pane. Straight after the app installed an update and reopened nine panes, every restored
// row read `engaged: false`, `runSince: null`, `lastRunMs: undefined` - which the sidebar
// draws as no clock at all and the grey "ready - type to start" dot on a live conversation.
// And a pane the restart caught mid-turn came back at an empty composer, because `--resume`
// restores the conversation and not the answer that was being written.
//
// The weight here is in the negatives. Continuing a turn TYPES INTO somebody's agent
// unasked, and the source assertions exist because a test that only exercises the pure
// function stays green while the line that calls it is deleted.
//
//   node scripts/restore-turn-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-restore-turn-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'restoreTurn.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/restoreTurn.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { restoredClock, continueAfterRestore, restoreAsleep, deskToWrite } = createRequire(import.meta.url)(outfile)

let n = 0
const ok = (what, cond) => {
  assert.ok(cond, what)
  n++
}

const NOW = 1_760_000_000_000
const HOUR = 3600_000

// ---------------------------------------------------------------- the clock
{
  const c = restoredClock({}, NOW)
  ok('a brand new pane opens now', c.openedAt === NOW)
  ok('...with no previous turn to report', c.lastRunMs === undefined)
  ok('...and is not engaged - nobody has asked it anything', c.engaged === false)
}
{
  // The bug: this is the shape every one of the nine restored panes had.
  const c = restoredClock({ openedAt: NOW - 9 * HOUR, lastRunMs: 61_377, engaged: true }, NOW)
  ok('a restored pane keeps the hour it really opened', c.openedAt === NOW - 9 * HOUR)
  ok('...keeps its last turn, so the row has a number', c.lastRunMs === 61_377)
  ok('...and stays engaged, which is the green dot', c.engaged === true)
}
{
  const c = restoredClock({ prompt: 'do the thing' }, NOW)
  ok('a launch prompt engages a pane, as it always did', c.engaged === true)
}
{
  const c = restoredClock({ wasWorking: true }, NOW)
  ok('a pane caught mid-turn is engaged even if the flag was not written', c.engaged === true)
}

// ------------------------------------------------- continuing the cut turn
ok('mid-turn is continued', continueAfterRestore({ wasWorking: true }, true) === true)

// The negatives. Each of these types into a live agent if it goes wrong.
ok(
  'a pane that was NOT mid-turn is left alone - typing at it starts a turn nobody asked for',
  continueAfterRestore({ wasWorking: false }, true) === false
)
ok('a pane with no recorded state (an older desk.json) is left alone', continueAfterRestore({}, true) === false)
ok(
  'a pane launched WITH a prompt is left alone - two things in one composer is one inside the other',
  continueAfterRestore({ wasWorking: true, prompt: 'build X' }, true) === false
)
ok(
  'with "finish a turn that was cut off" switched off, the app types nothing here either',
  continueAfterRestore({ wasWorking: true }, false) === false
)

// ------------------------------------------------- which panes come back running
// The whole point is that MOST of them do not: eight agent CLIs in one tick is the
// restore lag (measured 4.1-14.3s to a composer against 1.4s for one alone), and a
// sleeping pane keeps its card, its place and its screen for nothing.
ok('the pane being looked at comes back running', restoreAsleep({}, 0, true) === false)
ok('every other pane comes back asleep', restoreAsleep({}, 1, true) === true)
ok('...however many there are', restoreAsleep({}, 7, true) === true)
// The refusals, which are the feature: a pane asleep must not be one with work in it.
ok(
  'a pane the restart caught mid-turn is woken, because the turn is about to be finished',
  restoreAsleep({ wasWorking: true }, 3, true) === false
)
ok(
  '...and sleeps again when finishing a cut-off turn is switched off, since nothing will run',
  restoreAsleep({ wasWorking: true }, 3, false) === true
)
ok(
  'a pane launched with a prompt is woken - it was opened to do that work',
  restoreAsleep({ prompt: 'build X' }, 2, true) === false
)
ok(
  'and being engaged is NOT work in flight - a finished conversation sleeps',
  restoreAsleep({ engaged: true }, 2, true) === true
)

// ------------------------------------------------------- the wiring itself
// A green pure test over a function nothing calls is the exact shape of false confidence
// this repo keeps getting bitten by, so the call sites are asserted as source.
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')

ok('snapshot() writes when the pane really opened', /openedAt: s\.meta\.openedAt \?\? s\.meta\.createdAt/.test(sessions))
ok('snapshot() writes the last turn length', /lastRunMs: s\.meta\.lastRunMs/.test(sessions))
ok('snapshot() writes whether the pane was engaged', /engaged: s\.meta\.engaged/.test(sessions))
ok(
  'snapshot() reads mid-turn off runSince, the only honest reading of it',
  /wasWorking: Boolean\(s\.meta\.runSince\)/.test(sessions)
)
ok('start() takes its clock from restoredClock', /restoredClock\(req, Date\.now\(\)\)/.test(sessions))
ok('start() uses that openedAt', /openedAt: clock\.openedAt/.test(sessions))
ok('start() uses that lastRunMs', /lastRunMs: clock\.lastRunMs/.test(sessions))
ok('start() uses that engaged', /engaged: clock\.engaged/.test(sessions))
ok('start() asks continueAfterRestore', /continueAfterRestore\(req, /.test(sessions))
ok(
  'the continue goes through queuePrompt, which waits for an idle composer',
  /this\.queuePrompt\(id, text, RESTORE_CONTINUE_MS\)/.test(sessions)
)
ok('and the flag is cleared, so a manual restart later does not continue an old turn', /req\.wasWorking = false/.test(sessions))

ok('start() can make a pane with no process at all', /proc: born \? null : this\.spawn\(/.test(sessions))
ok(
  'a born-asleep pane wears the two fields every guard in the app already reads',
  /meta\.status = 'exited'\s*\n\s*meta\.asleep = Date\.now\(\)/.test(sessions)
)
ok('and nothing is attached to it, so no run is recorded', /if \(born\) \{/.test(sessions))
ok(
  'waking clears the flag, so a later restart does not put the pane back to sleep',
  /live\.req = \{ \.\.\.live\.req, asleep: undefined \}/.test(sessions)
)
ok('a pane slept on purpose comes back asleep', /asleep: Boolean\(s\.meta\.asleep\)/.test(sessions))

const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok('the restore asks restoreAsleep, per pane, in order', /restoreAsleep\(req, i, recoverOn\)/.test(index))
// "Keep this pane open" is a promise about a pane, and a restored pane is a NEW session
// with a new id - so the promise is carried across by the one field that names the pane
// being replaced. Without this the pin was renderer state and every restart dropped it.
ok('the pin list is read from config at restore', /getConfig\(\)\.pinnedPanes \?\? \[\]/.test(index))
ok(
  '...and each pin follows its pane onto the new id, through scrollbackId',
  /wasPinned\.has\(req\.scrollbackId\)\) nowPinned\.push\(meta\.id\)/.test(index)
)
ok(
  '...and is merged with pins changed while restore was waiting',
  /setConfig\(\{ pinnedPanes: mergedPins \}\)/.test(index)
)

const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
ok('the desk reads its pins off the config it is handed', /config\.pinnedPanes \?\? \[\]/.test(app))
ok('and every press writes them back', /patchConfig\(\{ pinnedPanes: Object\.keys\(next\) \}\)/.test(app))

const info = readFileSync(join(root, 'src/renderer/src/components/SessionInfo.tsx'), 'utf8')
ok('"Open for" counts from when the pane opened, not from this process', /s\.openedAt \?\? s\.createdAt/.test(info))

// An empty desk is not written while the offer is up and nothing has been opened since -
// and IS written once a pane has been used, because on the PC the offer stood unanswered
// for hours, a pane opened over it was closed, and desk.json kept listing it (2026-09-03).
// The 2026-09-03 loss: eleven offered panes, a pane opened over the offer, one autosave.
const offered = [{ cwd: '/a' }, { cwd: '/b' }]
const opened = [{ cwd: '/c' }]
ok('offer up, nothing opened yet: the file keeps the offered panes', deskToWrite(offered, []).length === 2)
ok('offer up, a pane opened over it: offered panes first, then the live one',
  JSON.stringify(deskToWrite(offered, opened)) === JSON.stringify([...offered, ...opened]))
ok('offer up, that pane closed again: the offered panes still stand', deskToWrite(offered, []).length === 2)
ok('no offer: the live desk is written as it is, empty included', deskToWrite(null, []).length === 0)
ok('no offer: live panes pass through untouched', deskToWrite(null, opened) === opened)

rmSync(work, { recursive: true, force: true })
console.log(`restore-turn: ${n} checks passed`)
