/**
 * The one line History puts under a closed session, and the cookie that decides whether a
 * phone has to be approved twice.
 *
 * Both are here because both are the same kind of promise: something the app claims it
 * remembers. Nothing in this file needs a window, a network or an agent.
 *
 * Run: npm run test:gist
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-gist-'))
const file = join(out, 'gist.mjs')
buildSync({
  entryPoints: ['src/shared/gist.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: file
})
const { gistOf, gistLine, noteAskInto, summaryOf, summaryFull, MAX_CHAPTERS } = await import(
  pathToFileURL(file).href
)

let failed = 0
const ok = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

console.log('gistOf')
ok('an ordinary ask is itself', () => {
  assert.equal(gistOf('fix the devices panel so it saves'), 'fix the devices panel so it saves')
})
ok('a multi-line ask collapses to one line', () => {
  assert.equal(gistOf('fix the devices panel\nand the history notes'), 'fix the devices panel')
})
ok('leading blank lines are not the answer', () => {
  assert.equal(gistOf('\n\n  make the phone stay signed in  '), 'make the phone stay signed in')
})
ok('trailing punctuation goes; the words do not', () => {
  assert.equal(gistOf('why is the tunnel down?'), 'why is the tunnel down?')
  assert.equal(gistOf('fix this.'), 'fix this')
})
ok('a slash command is a fine answer to "what was this"', () => {
  assert.equal(gistOf('/clear'), '/clear')
})
ok('a pasted stack trace picks the sentence, not the first frame', () => {
  const pasted = [
    '    at Object.<anonymous> (/x/y.js:1:1)',
    'TypeError: cannot read x',
    'this keeps happening when I open a pane'
  ].join('\n')
  assert.equal(gistOf(pasted), 'this keeps happening when I open a pane')
})
ok('a paste with no sentence in it still says something', () => {
  // Better a first line than an empty row: the row exists to be recognised, and "" is
  // indistinguishable from a session nobody ever typed in.
  assert.equal(gistOf('@@ -1,4 +1,9 @@\n+const x = 1'), '@@ -1,4 +1,9 @@')
})
ok('a long ask is cut with an ellipsis rather than clipped mid-word by CSS alone', () => {
  const long = 'please ' + 'refactor the entire renderer '.repeat(20)
  const g = gistOf(long)
  assert.ok(g.length <= 160, `${g.length} chars`)
  assert.ok(g.endsWith('…'))
})
ok('nothing typed is nothing said - never a guess', () => {
  assert.equal(gistOf(''), '')
  assert.equal(gistOf('   \n  '), '')
})

console.log('gistLine')
ok('one ask reads as itself', () => {
  assert.equal(gistLine('fix devices', 1), 'fix devices')
})
ok('a session with forty asks says so - it is a different session to return to', () => {
  assert.equal(gistLine('fix devices', 40), 'fix devices  ·  +39 more asks')
})
ok('one more ask is singular', () => {
  assert.equal(gistLine('fix devices', 2), 'fix devices  ·  +1 more ask')
})
ok('no note means no line at all, not a bare counter', () => {
  assert.equal(gistLine(undefined, 12), '')
})

// ---------------------------------------------------------------------------
// What a WHOLE session was about: the opening ask, plus the first ask after each clear.
// The negatives are the weight here - a chapter list that fills up with `/clear` and
// `/model` says less than the one line it replaced.

const fold = (...prompts) => prompts.reduce((n, p) => noteAskInto(n, p), {})

console.log('noteAskInto')
ok('one ask is one chapter', () => {
  const n = fold('fix the tunnel')
  assert.deepEqual(n.chapters, ['fix the tunnel'])
  assert.equal(n.asks, 1)
})
ok('a follow-up is not a chapter - it is inside the one already open', () => {
  const n = fold('fix the tunnel', 'now the other file', 'and the tests')
  assert.deepEqual(n.chapters, ['fix the tunnel'])
  assert.equal(n.asks, 3)
})
ok('a clear opens the next chapter, and is not itself one', () => {
  const n = fold('fix the tunnel', 'now the other file', '/clear', 'write the release notes')
  assert.deepEqual(n.chapters, ['fix the tunnel', 'write the release notes'])
  // Three asks, not four: a clear is a thing done TO the pane, not work asked of it.
  assert.equal(n.asks, 3)
})
ok('a clear picked from the CLI menu counts too', () => {
  // `/cle` submits `/clear` off the completion menu - the same trap keepScrollback has.
  const n = fold('fix the tunnel', '/cle', 'write the release notes')
  assert.deepEqual(n.chapters, ['fix the tunnel', 'write the release notes'])
})
ok('two clears in a row do not open two chapters', () => {
  const n = fold('fix the tunnel', '/clear', '/clear', 'write the notes')
  assert.deepEqual(n.chapters, ['fix the tunnel', 'write the notes'])
})
ok('another slash command heads nothing and is not counted as work', () => {
  const n = fold('fix the tunnel', '/clear', '/model opus', 'write the notes')
  assert.deepEqual(n.chapters, ['fix the tunnel', 'write the notes'])
  assert.equal(n.asks, 2)
})
ok('a session that only ever ran commands still has its first line', () => {
  const n = fold('/doctor')
  assert.equal(n.gist, '/doctor')
  assert.equal(summaryOf(n), '/doctor')
})
ok('the same ask repeated after a clear is not a second chapter', () => {
  const n = fold('run the suite', '/clear', 'run the suite')
  assert.deepEqual(n.chapters, ['run the suite'])
})
ok('past the cap the text stops and the COUNT does not', () => {
  const prompts = []
  for (let i = 0; i < MAX_CHAPTERS + 3; i++) prompts.push(`job number ${i}`, '/clear')
  const n = fold(...prompts)
  assert.equal(n.chapters.length, MAX_CHAPTERS)
  assert.equal(n.dropped, 3)
})
ok('an empty prompt is not an ask', () => {
  assert.deepEqual(fold('   \n '), {})
})

console.log('summaryOf')
ok('one chapter reads as the ask itself', () => {
  assert.equal(summaryOf(fold('fix the tunnel')), 'fix the tunnel')
})
ok('several chapters share the row', () => {
  const n = fold('fix the tunnel', '/clear', 'write the notes')
  assert.equal(summaryOf(n), 'fix the tunnel  ·  write the notes  ·  +1 more ask')
  assert.equal(n.asks, 2)
})
ok('past three the rest are counted, not shown', () => {
  const n = fold('one thing', '/clear', 'two thing', '/clear', 'three thing', '/clear', 'four thing')
  const line = summaryOf(n)
  assert.ok(line.startsWith('one thing  ·  two thing  ·  three thing'), line)
  assert.ok(line.includes('+1 more topic'), line)
  assert.ok(!line.includes('four thing'), line)
})
ok('a row with no chapters falls back to the first line', () => {
  assert.equal(summaryOf({ gist: '/doctor', asks: 1 }), '/doctor')
})
ok('nothing recorded is no line at all, not a bare counter', () => {
  assert.equal(summaryOf({ asks: 9 }), '')
})
ok('a long chapter is clipped only when it is sharing the row', () => {
  const long = 'a'.repeat(120)
  assert.equal(summaryOf({ chapters: [long], asks: 1 }), long)
  assert.ok(summaryOf({ chapters: [long, 'b'], asks: 2 }).includes('…'))
})

console.log('summaryFull')
ok('every chapter, numbered, one per line', () => {
  const n = fold('fix the tunnel', '/clear', 'write the notes')
  assert.equal(summaryFull(n), '1. fix the tunnel\n2. write the notes')
})
ok('dropped chapters are admitted rather than hidden', () => {
  assert.ok(summaryFull({ chapters: ['a'], dropped: 4 }).includes('4 more'))
})

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
