// How often a person had to step in - A7's number, and what may not go into it.
//
// The load-bearing half is the REFUSALS. A count that goes up when the app answers a
// question for you, types a queued prompt, or clears a pane on its own would rise as the
// app got better at working alone, which is the exact opposite of what it is for.

import assert from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-interv-'))
const bundle = join(out, 'interventions.mjs')
buildSync({ entryPoints: ['src/shared/interventions.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bundle })
const { judge, noteLine, interventionWords } = await import(pathToFileURL(bundle).href)

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

const at = (o = {}) => ({ hand: 'desk', submitted: true, bare: false, asking: false, running: false, ...o })

// ---------------------------------------------------------------------------
// What counts.

t('saying what to do next counts', () => {
  const v = judge(at())
  assert.ok(v.counts)
  assert.match(v.why, /what to do next/)
})
t('answering a question the app would not counts', () =>
  assert.match(judge(at({ asking: true })).why, /answered a question/))
t('stepping into a running turn counts', () =>
  assert.match(judge(at({ running: true })).why, /turn that was running/))
t('the phone is the same person as the desk', () => assert.ok(judge(at({ hand: 'phone' })).counts))
t('a question outranks a running turn in the words', () =>
  assert.match(judge(at({ asking: true, running: true })).why, /answered a question/))

// ---------------------------------------------------------------------------
// What does not. These are the reason the number means anything.

t('an app write never counts, whatever else was true', () => {
  for (const extra of [{}, { asking: true }, { running: true }, { asking: true, running: true }])
    assert.strictEqual(judge(at({ hand: 'app', ...extra })).counts, false)
  assert.match(judge(at({ hand: 'app' })).why, /the app did it/)
})
t('typing without sending is not a separate intervention', () =>
  assert.match(judge(at({ submitted: false })).why, /typed but not sent/))
t('a bare return sent nothing, so it asked nothing', () =>
  assert.match(judge(at({ bare: true })).why, /bare return/))
t('an app write is refused BEFORE the submitted and bare checks', () => {
  // Order matters: an auto-answered question arrives as a real submit on a pane that IS
  // asking, so any check ahead of the hand would count it.
  assert.strictEqual(judge(at({ hand: 'app', asking: true, submitted: true })).counts, false)
})

// ---------------------------------------------------------------------------
// The log line and the words.

t('a log line is one tab-separated row ending in a newline', () => {
  const line = noteLine({ at: 1756800000000, session: 's4', project: 'PaneForge', why: 'you answered a question the app would not', count: 3 })
  assert.ok(line.endsWith('\n'))
  const cols = line.trimEnd().split('\t')
  assert.strictEqual(cols.length, 5)
  assert.strictEqual(cols[1], 's4')
  assert.strictEqual(cols[3], '3')
  assert.match(cols[0], /^\d{4}-\d{2}-\d{2}T/)
})
t('zero gets its own sentence, because "0 times" reads as a missing number', () =>
  assert.strictEqual(interventionWords(0), 'you have not had to step in'))
t('one is singular', () => assert.strictEqual(interventionWords(1), 'you stepped in once'))
t('more than one is counted', () => assert.strictEqual(interventionWords(4), 'you stepped in 4 times'))
t('a pane nobody has measured says nothing at all', () =>
  assert.strictEqual(interventionWords(undefined), ''))

// ---------------------------------------------------------------------------
// A whole pane, the shape the milestone's target is stated in.

t('a pane that ran a feature with one question answered by the app costs 0', () => {
  const moments = [
    at({ hand: 'app' }), // the launch prompt
    at({ hand: 'app', asking: true }), // a question the app answered
    at({ submitted: false }) // somebody started typing and stopped
  ]
  assert.strictEqual(moments.filter((m) => judge(m).counts).length, 0)
})
t('the same pane costs 2 when a person answers and then re-steers', () => {
  const moments = [at({ hand: 'app' }), at({ asking: true }), at({ running: true })]
  assert.strictEqual(moments.filter((m) => judge(m).counts).length, 2)
})

console.log(`\n${pass} checks passed`)
