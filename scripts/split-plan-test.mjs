/**
 * Reading a plan out of whatever a headless CLI printed.
 *
 * The weight is in the refusals: a split is the one feature here that opens PANES off a
 * model's answer, so an answer that is not a plan must come back as nothing, and a plan
 * that had to drop a task must SAY which. Nothing in this file needs a window, a network
 * or an agent.
 *
 * Run: npm run test:splitplan
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-split-'))
const file = join(out, 'splitPlan.mjs')
buildSync({
  entryPoints: ['src/shared/splitPlan.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: file
})
const { parseSplit, splitInstruction, splitWords, paneBrief, liftDone, MAX_TASKS, maxTasks } =
  await import(pathToFileURL(file).href)

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}

const plan = (tasks) => JSON.stringify({ tasks })

// --- the ordinary answer ---------------------------------------------------------------
const two = parseSplit(
  plan([
    { title: 'Fix the installer', prompt: 'Fix the NSIS guard in build/installer.nsh', project: 'PaneForge' },
    { title: 'Rework the sidebar', prompt: 'Group the sidebar by state', project: '' }
  ])
)
ok('two tasks read', two.tasks.length === 2)
ok('project kept when named', two.tasks[0].project === 'PaneForge')
ok('empty project is absent, not ""', two.tasks[1].project === undefined)
ok('nothing dropped', two.dropped.length === 0)

// --- prose around the JSON, which every CLI adds ----------------------------------------
const fenced = parseSplit(
  'Here you go:\n```json\n' + plan([{ title: 'One', prompt: 'do the one thing' }]) + '\n```\nHope that helps.'
)
ok('a fenced answer still parses', fenced?.tasks[0].prompt === 'do the one thing')

// A brace inside a string must not end the object early - this is the case a naive
// indexOf('}') gets wrong, and it gets it wrong by TRUNCATING a valid plan.
const braces = parseSplit(plan([{ title: 'Braces', prompt: 'replace {a} with {b}' }]))
ok('a brace inside a string does not end the object', braces?.tasks[0].prompt === 'replace {a} with {b}')

// A stray brace in prose BEFORE the real object must not swallow the scan - measured
// against a live `claude -p` answer that wrote the shape in a sentence first.
const strayed = parseSplit(
  'The shape is {tasks: [...]} and here it is:\n' + plan([{ title: 'Real', prompt: 'the real one' }])
)
ok('a stray brace in prose is skipped', strayed?.tasks[0].prompt === 'the real one')

// --- the refusals ----------------------------------------------------------------------
ok('prose with no object is null', parseSplit('I cannot help with that.') === null)
ok('broken JSON is null', parseSplit('{"tasks": [') === null)
ok('an object that is not a plan is null', parseSplit('{"answer":"no"}') === null)
ok('tasks that is not an array is null', parseSplit('{"tasks":"two"}') === null)
// An empty list is a FAILED answer, not "this is one job": a real one-job answer is one
// task. The two must never share a shape.
ok('an empty list is null', parseSplit(plan([])) === null)
ok('a task with no prompt is not a task', parseSplit(plan([{ title: 'Empty', prompt: '  ' }])) === null)

const mixed = parseSplit(plan([{ title: 'Real', prompt: 'do it' }, { title: 'Hollow', prompt: '' }]))
ok('a hollow task does not take the good one with it', mixed.tasks.length === 1)
ok('...and it is named in dropped', mixed.dropped.includes('Hollow'))

// --- the cap is reported, never silent -------------------------------------------------
const many = parseSplit(
  plan(Array.from({ length: MAX_TASKS + 2 }, (_, i) => ({ title: `T${i}`, prompt: `job ${i}` })))
)
ok('never more than the cap', many.tasks.length === MAX_TASKS)
ok('everything over the cap is named', many.dropped.length === 2)
ok('the words say what was left out', splitWords(many).includes('Left out'))

// A missing title falls back to the prompt rather than to nothing - a row with no label is
// a row nobody can judge before pressing.
const untitled = parseSplit(plan([{ prompt: 'a brief with no title of its own' }]))
ok('a missing title borrows the prompt', untitled.tasks[0].title.startsWith('a brief'))

// --- what the words say ----------------------------------------------------------------
const one = parseSplit(plan([{ title: 'Only', prompt: 'one job' }]))
ok('one task is stated as one job, not as a failure', splitWords(one).includes('one job'))
ok('several tasks are counted', splitWords(two).startsWith('2 parts'))

// --- the instruction has to carry the two things a pane cannot recover from -------------
const instruction = splitInstruction('do a and b', 3)
ok('the ceiling is in the instruction', instruction.includes('At most 3'))
ok('standing alone is in the instruction', instruction.includes('stand alone'))
ok('adding work is refused in the instruction', instruction.includes('ADD NO WORK'))
ok('the ask itself is in the instruction', instruction.includes('do a and b'))


// The brief is forged (`shared/promptForge.ts`), so it carries the two things it never
// carried before: a block saying what a finished answer is, and - when this machine has
// the library - one example of a good ask of this kind.
ok('the brief says what done means', instruction.includes('Done means:'))
ok('the done block is the last thing on the page', instruction.trimEnd().endsWith('at most six words'))
const withExample = splitInstruction('do a and b', 3, {
  id: 'multi-item-opener',
  guidance: ['each item finished on its own'],
  examples: ['AN EXAMPLE ASK']
})
ok('an exemplar is carried when one is handed in', withExample.includes('AN EXAMPLE ASK'))
ok('the example sits above the done block', withExample.indexOf('AN EXAMPLE ASK') < withExample.indexOf('Done means:'))
// The feature exists for LONG asks; the pane-typing ceiling must not truncate one.
const long = 'x'.repeat(20000)
ok('a 20k-char ask survives the brief whole', splitInstruction(long, 4).includes(long))

// ---------------------------------------------------------------------------
// The brief a pane is opened with. `parseSplit` keeps the model's text; this is the step
// after it, and it is the one that guarantees a definition of done.

const brief = paneBrief({ title: 'T', prompt: 'Group the sidebar by state', project: 'PaneForge' })
ok('a pane brief says what done means', brief.includes('Done means:'))
ok('a pane brief keeps the model\'s own words', brief.includes('Group the sidebar by state'))
ok('a named project becomes the anchor', brief.includes('the PaneForge repo'))
ok('the other panes are fenced off', brief.includes('other panes and other checkouts'))
ok('a brief with no project draws no anchor', !paneBrief({ title: 'T', prompt: 'do it' }).includes('Start from:'))

// Idempotent: forging a forged brief must not stack a second done block.
const twice = paneBrief({ title: 'T', prompt: brief })
ok('forging a forged brief adds no second done block', twice.split('Done means:').length === 2)
ok('forging twice keeps the words', twice.includes('Group the sidebar by state'))

const modelWroteOne = paneBrief({
  title: 'T',
  prompt: 'Do the thing.\n\nDone means:\n- the suite is green\n- the page loads'
})
ok('a model that wrote its own done block keeps those lines', modelWroteOne.includes('- the suite is green'))
ok('and gets exactly one done block', modelWroteOne.split('Done means:').length === 2)

// A heading in the middle of prose is not a block.
ok(
  'Done means: inside a sentence is left alone',
  liftDone('Done means: whatever you decide, then keep going').done.length === 0
)
ok('a block with a prose line under it is not a block', liftDone('x\n\nDone means:\n- a\nand also b').done.length === 0)

// maxTasks: the pool-size-aware cap that replaces the hardcoded MAX_TASKS at the call site.
ok('a pool of one still gets the queue allowance', maxTasks(1) === 1 + 8)
ok('a bigger pool adds to the same allowance', maxTasks(4) === 4 + 8)
ok('the total never passes 12', maxTasks(20) === 12)
ok('a smaller queue allowance is honoured', maxTasks(4, 2) === 6)
ok('pool size floors at one', maxTasks(0) === 1 + 8)

console.log(`split-plan: ${n} assertions passed`)
