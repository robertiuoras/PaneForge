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
const { pickAnswer, DEFAULT_AUTO_ANSWER } = await import(
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
// The wiring, at source level: the decision above is worth nothing if nothing calls it,
// and the two guards that keep it from arguing with a widget live in sessions.ts.
// ---------------------------------------------------------------------------
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')

ok('the sweep is wired, waits, and never presses the same question twice', () => {
  assert.match(sessions, /sweepAutoAnswer\(live\)/, 'called from the sweep')
  assert.match(sessions, /Date\.now\(\) - live\.askSince < cfg\.waitMs/, 'the settle window')
  assert.match(sessions, /live\.askSig === live\.autoSig/, 'once per question')
  assert.match(sessions, /live\.autoRun >= cfg\.maxRun/, 'a run has an end')
  // The keys go through `choose`, which re-checks the question before every one of them.
  assert.match(sessions, /this\.choose\(live\.meta\.id, pick\.n\)/)
})

rmSync(out, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
