#!/usr/bin/env node
// What `shared/changedNothing.ts` may and may not say about a finished turn.
//
// The assertions that matter are the REFUSALS. Saying "changed no files" about a turn
// that did change something is a bug somebody argues with once; saying it because a
// reading FAILED is a bug that quietly tells a person their agent wasted half an hour, on
// no evidence at all. So most of this file is about the second kind.
//
// Pure node, no window, no git, no CLI: the readings are strings, which is the whole
// reason `Shot` is opaque above the reader that builds it.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-changed-nothing-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'changedNothing.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/changedNothing.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { MIN_TURN_MS, changedNothing, changedNothingWords, changedNothingWhy } = createRequire(
  import.meta.url
)(out)

let n = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  n++
}

const LONG = MIN_TURN_MS + 1000
/** A turn that really did nothing: two readings taken, identical, long enough to matter. */
const empty = (over = {}) => ({
  before: 'abc123\n',
  after: 'abc123\n',
  startedAt: 1000,
  endedAt: 1000 + LONG,
  agent: true,
  ...over
})

// --- the one thing it says ------------------------------------------------------------

ok(changedNothing(empty()) === true, 'two identical readings over a long agent turn is the finding')
ok(changedNothingWords(empty()) === 'changed no files', 'the words are the reader’s, not git’s')

// --- work that landed ------------------------------------------------------------------

ok(
  changedNothing(empty({ after: 'abc123\n M src/x.ts\n' })) === false,
  'an edited file is a change'
)
ok(
  changedNothing(empty({ after: 'def456\n' })) === false,
  'a turn whose only product was a commit changed something - the readings carry HEAD'
)
ok(
  changedNothing(empty({ after: 'abc123\n?? notes/new.md\n' })) === false,
  'a brand new untracked file is a change'
)

// --- a failed reading is never a finding ------------------------------------------------

ok(changedNothing(empty({ before: undefined })) === false, 'no reading at the start says nothing')
ok(changedNothing(empty({ after: undefined })) === false, 'no reading at the end says nothing')
ok(changedNothing(empty({ before: '', after: '' })) === false, 'two FAILED readings agree, and must still say nothing')
ok(
  changedNothingWords(empty({ before: '', after: '' })) === null,
  'the words follow the refusal, so nothing can draw a chip off an empty reading'
)

// --- panes this is not about ------------------------------------------------------------

ok(changedNothing(empty({ agent: false })) === false, 'a shell pane changing no file is the ordinary case')
ok(changedNothing(empty({ mirror: true })) === false, 'a mirror judges nothing')
ok(changedNothing(empty({ asking: true })) === false, 'a pane on a question has paused a turn, not finished one')

// --- an answer is not a wasted turn -----------------------------------------------------

ok(
  changedNothing(empty({ endedAt: 1000 + MIN_TURN_MS - 1 })) === false,
  'a turn under the floor is an answer, and answers change no files by design'
)
ok(
  changedNothing(empty({ endedAt: 1000 + MIN_TURN_MS })) === true,
  'the floor itself counts, so the boundary has one answer and not two'
)
ok(changedNothing(empty({ startedAt: undefined })) === false, 'a turn with no start cannot be measured')
ok(changedNothing(empty({ endedAt: undefined })) === false, 'a turn with no end cannot be measured')

// --- the sentence -----------------------------------------------------------------------

const why = changedNothingWhy('PaneForge copy 2')
ok(why.includes('PaneForge copy 2'), 'the sentence names the project, because eight panes are open')
ok(!/\b(diff|git|working tree|staged|commit)\b/i.test(why), 'no machinery words reach the screen')
ok(!/\b(diff|git|staged)\b/i.test(changedNothingWords(empty())), 'nor the chip')
ok(changedNothingWhy().length > 0, 'an unknown project leaves the sentence general, never wrong')

// --- the floor is a real number, not a placeholder ---------------------------------------

ok(MIN_TURN_MS >= 10_000 && MIN_TURN_MS <= 120_000, 'the floor is in the range a turn is measured in')

console.log(`changednothing: ${n} checks passed`)
