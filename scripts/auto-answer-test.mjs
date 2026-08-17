#!/usr/bin/env node
// Answering an agent's question without a person.
//
// The positives are cheap and the negatives are the whole test. Pressing "Yes" on a
// permission prompt is a formality; pressing "Yes, and don't ask again" answers every
// future question of that shape, pressing "No, tell Claude what to do differently" leaves
// the CLI holding an empty composer, and pressing one of four design options is the app
// deciding the work. Each of those is a different kind of damage and each has a case here.
//
// The fixtures are the option shapes these CLIs really draw - Claude Code's permission
// prompt, its resume prompt, and an AskUserQuestion with four real answers - reduced to
// what `readAsk` hands on. `npm run test:choices` owns the reading; this owns the choosing.

import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const out = mkdtempSync(join(tmpdir(), 'pf-autoanswer-'))
await build({
  entryPoints: [join(root, 'src/shared/autoAnswer.ts')],
  outfile: join(out, 'autoAnswer.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { pickAnswer, dueForAuto, askKeyOf, PRESS_COOLDOWN_MS, DEFAULT_AUTO_ANSWER } = await import(
  pathToFileURL(join(out, 'autoAnswer.mjs')).href
)

let n = 0
const ok = (what, fn) => {
  fn()
  n++
  console.log(`  ok  ${what}`)
}

const ask = (selected, ...labels) => ({
  question: 'q',
  selected,
  options: labels.map((label, i) => ({ n: i + 1, label }))
})
const ON = { ...DEFAULT_AUTO_ANSWER, enabled: true }
const ANY = { ...ON, anyQuestion: true }

// ---------------------------------------------------------------------------
// The everyday one: a permission prompt, answered.
// ---------------------------------------------------------------------------
const PERMISSION = ask(
  1,
  'Yes',
  "Yes, and don't ask again for Edit commands in /Users/robert/Projects/PaneForge",
  'No, and tell Claude what to do differently (esc)'
)

ok('a permission prompt picks the plain Yes', () => {
  const pick = pickAnswer(PERMISSION, ON)
  assert.equal(pick?.n, 1)
  assert.match(pick.why, /Yes/)
})

ok('the widening option is never the one picked', () => {
  // Not merely "not first": it must never be reachable, whatever the arrow is on and
  // whichever mode is set. It is the one press that cannot be undone by noticing.
  for (const cfg of [ON, ANY]) {
    for (const sel of [1, 2, 3]) {
      const pick = pickAnswer({ ...PERMISSION, selected: sel }, cfg)
      assert.notEqual(pick?.n, 2, `mode=${cfg.anyQuestion} sel=${sel}`)
    }
  }
})

ok('every wording of "and stop asking me" is refused, not just this desk\'s', () => {
  // Matching the two strings Claude Code prints today makes the guard a note about one
  // CLI's release. These are the same sentence and every one of them must be unreachable.
  for (const label of [
    "Yes, and don't ask me again",
    "Yes, and don't ever ask again",
    'Yes, and never ask again',
    'Yes, and do not ask me again for this folder',
    'Yes, and stop asking about this again',
    'Yes, allow always'
  ]) {
    const a = ask(1, label, 'No')
    assert.equal(pickAnswer(a, ON), null, label)
    assert.equal(pickAnswer(a, ANY), null, `${label} (anyQuestion)`)
  }
})

ok('a prompt whose only yes widens permission is left alone', () => {
  const a = ask(1, 'Yes, allow always', 'No')
  assert.equal(pickAnswer(a, ON), null)
  // Even borrowing the CLI's default: the default IS the widening option here.
  assert.equal(pickAnswer(a, ANY), null)
})

ok('the resume prompt continues', () => {
  const pick = pickAnswer(ask(1, 'Continue this conversation', 'Start a new one'), ON)
  assert.equal(pick?.n, 1)
})

// ---------------------------------------------------------------------------
// The refusals.
// ---------------------------------------------------------------------------
ok('off answers nothing', () => {
  assert.equal(pickAnswer(PERMISSION, DEFAULT_AUTO_ANSWER), null)
  assert.equal(DEFAULT_AUTO_ANSWER.enabled, false, 'it ships off')
  assert.equal(DEFAULT_AUTO_ANSWER.anyQuestion, false)
})

ok('a design question waits for a person', () => {
  const design = ask(
    1,
    'Taskbar icon',
    'Alt-Tab entry',
    'Task Manager list',
    'Tray / system clock area'
  )
  assert.equal(pickAnswer(design, ON), null)
  // ...unless the wider setting is on, and then it is the CLI's own arrow, not a guess.
  const pick = pickAnswer({ ...design, selected: 3 }, ANY)
  assert.equal(pick?.n, 3)
  assert.match(pick.why, /default/)
})

ok('two yes-shaped answers are a choice, not an obvious one', () => {
  assert.equal(pickAnswer(ask(1, 'Yes, rebase', 'Yes, merge', 'Cancel'), ON), null)
})

ok('a default that stops and asks for a sentence is not taken', () => {
  // Picking it turns a pane that was merely waiting into one that is waiting AND has
  // lost the question it was waiting on.
  const a = ask(3, 'Yes', 'Yes, and always', 'No, tell Claude what to do differently')
  assert.equal(pickAnswer(a, ANY)?.n, 1, 'the plain yes still wins over the arrow')
  const noYes = ask(2, 'Keep the current plan', 'No, tell Claude what to do differently')
  assert.equal(pickAnswer(noYes, ANY), null)
})

ok('"no" leading an answer is never read as yes', () => {
  assert.equal(pickAnswer(ask(1, 'No - I already said yes to that', 'Stop'), ON), null)
})

ok('an empty question answers nothing', () => {
  assert.equal(pickAnswer({ question: '', selected: 1, options: [] }, ANY), null)
})

// ---------------------------------------------------------------------------
// The timing. Every case here is a way the app ends up arguing with a widget, and each
// one is cheap to state and expensive to find in a live pane.
// ---------------------------------------------------------------------------
const T = 1_000_000
const state = (over = {}) => ({
  askKey: 'k1',
  askSince: T,
  autoKey: '',
  autoAt: 0,
  autoRun: 0,
  ...over
})

ok('a question is answered once it has settled, and not before', () => {
  assert.equal(dueForAuto(state(), ON, T + ON.waitMs - 1), false)
  assert.equal(dueForAuto(state(), ON, T + ON.waitMs), true)
  assert.equal(dueForAuto(state(), DEFAULT_AUTO_ANSWER, T + 60_000), false, 'off is off')
})

ok('the arrow moving restarts the wait', () => {
  // The pane restarts askSince on any frame change, arrow included: somebody moving the
  // selection at the desk must not have the press land from where they moved away.
  const moved = state({ askSince: T + 900 })
  assert.equal(dueForAuto(moved, ON, T + 1200), false)
  assert.equal(dueForAuto(moved, ON, T + 900 + ON.waitMs), true)
})

ok('the same question is never pressed twice', () => {
  assert.equal(dueForAuto(state({ autoKey: 'k1', autoAt: T }), ON, T + 600_000), false)
  // A different question on the same pane is a new question, cooldown permitting.
  assert.equal(
    dueForAuto(state({ askKey: 'k2', autoKey: 'k1', autoAt: T }), ON, T + 600_000),
    true
  )
})

ok('a press is not followed by another while its own keys are still landing', () => {
  // This is the race the arrow-inclusive signature used to open: our own arrows change
  // the frame, which restarts the settle clock, which lets a second sequence interleave.
  const mid = state({ askKey: 'k2', askSince: T, autoKey: 'k1', autoAt: T })
  assert.equal(dueForAuto(mid, ON, T + PRESS_COOLDOWN_MS - 1), false)
  assert.equal(dueForAuto(mid, ON, T + PRESS_COOLDOWN_MS), true)
})

ok('a pane may not do this for ever', () => {
  const spent = state({ autoRun: ON.maxRun })
  assert.equal(dueForAuto(spent, ON, T + 600_000), false)
  assert.equal(dueForAuto({ ...spent, autoRun: ON.maxRun - 1 }, ON, T + 600_000), true)
})

ok('no question, nothing to answer', () => {
  assert.equal(dueForAuto(state({ askKey: '' }), ON, T + 600_000), false)
  assert.equal(dueForAuto(state({ askSince: 0 }), ON, T + 600_000), false)
})

ok('the identity of a question leaves the arrow out', () => {
  const a = ask(1, 'Yes', 'No')
  const b = ask(2, 'Yes', 'No')
  assert.equal(askKeyOf(a), askKeyOf(b), 'the arrow moved; the question did not')
  assert.notEqual(askKeyOf(a), askKeyOf(ask(1, 'Yes', 'Maybe')))
  assert.equal(askKeyOf(null), '')
})

// ---------------------------------------------------------------------------
// The wiring, at source level: the decision above is worth nothing if nothing calls it,
// and the two guards that keep it from arguing with a widget live in sessions.ts.
// ---------------------------------------------------------------------------
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')

ok('the sweep is wired and the decision above is the one it asks', () => {
  assert.match(sessions, /sweepAutoAnswer\(live\)/, 'called from the sweep')
  assert.match(sessions, /dueForAuto\(live, cfg, Date\.now\(\)\)/, 'the timing is the tested one')
  // The keys go through `choose`, which re-checks the question before every one of them.
  assert.match(sessions, /this\.choose\(live\.meta\.id, pick\.n\)/)
})

ok('the state the guards read is actually written', () => {
  // A guard is half of a rule. Checking only the comparison lets the assignment that
  // makes it true be deleted, at which point every question is answered over and over
  // and this file still passes - which is the shape of green that costs the most.
  assert.match(sessions, /live\.autoKey = live\.askKey/, 'the pressed question is recorded')
  assert.match(sessions, /live\.autoAt = Date\.now\(\)/, 'and when')
  assert.match(sessions, /live\.autoRun\+\+/, 'and the run counter moves')
  assert.match(sessions, /s\.askKey = askKeyOf\(ask\)/, 'the identity is kept per frame')
  assert.match(sessions, /s\.askSince = sig \? now : 0/, 'and the settle clock')
})

ok('the run counter is given back by work resuming, not by a repaint', () => {
  // A chooser mid-repaint reads as no question for a frame, so resetting on "no question"
  // hands the budget back several times during ONE question and maxRun bounds nothing.
  const reset = sessions.slice(sessions.indexOf('s.askKey = askKeyOf(ask)'))
  const busyGate = reset.indexOf('if (busy) {')
  const counter = reset.indexOf('s.autoRun = 0')
  assert.ok(busyGate >= 0 && counter > busyGate && counter - busyGate < 800, 'reset sits under `if (busy)`')
})

rmSync(out, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
