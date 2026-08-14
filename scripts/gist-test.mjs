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
const { gistOf, gistLine } = await import(pathToFileURL(file).href)

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

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
