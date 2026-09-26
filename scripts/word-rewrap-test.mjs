// A pane that gets narrower breaks the lines above it between words, not through them.
// See src/shared/wordRewrap.ts.
//
// Two halves:
//   1. the rule as pure functions - where a line breaks, how far it hangs, what is cut;
//   2. a real xterm: a reply drawn at 60 columns with hard line ends, pushed into the
//      scrollback, then the pane narrowed to 44 - with a bare terminal as the control,
//      which cuts through words.
//
//   node scripts/word-rewrap-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-word-rewrap-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'rewrap.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/wordRewrap.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const require_ = createRequire(import.meta.url)
const { planWrap, hangingIndent, rewrapOnShrink } = require_(outfile)
const { Terminal } = require_('@xterm/headless')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}
const cells = (s) => [...s]
const cut = (s, plan) => plan.rows.map(([a, b], k) => ' '.repeat(k ? plan.indent : 0) + s.slice(a, b))

// 1. The rule.
await check('a line that fits is one row', () => {
  assert.deepEqual(planWrap(cells('  short line'), 40), { indent: 0, rows: [[0, 12]] })
})
await check('a long line breaks at the last space and hangs under its text', () => {
  const s = '  Cause: the hook types a command whenever a prompt contains a word'
  assert.deepEqual(cut(s, planWrap(cells(s), 30)), [
    '  Cause: the hook types a',
    '  command whenever a prompt',
    '  contains a word'
  ])
})
await check('a list item hangs under its text, not its dash', () => {
  assert.equal(hangingIndent(cells('  - pasted hook errors and output'), 40), 4)
  assert.equal(hangingIndent(cells('  12. numbered'), 40), 6)
  const s = '  - plain uses of agent and pipeline in your sales pipeline'
  assert.deepEqual(cut(s, planWrap(cells(s), 30)), ['  - plain uses of agent and', '    pipeline in your sales', '    pipeline'])
})
await check('empty cells (cursor-jump gaps) count as spaces', () => {
  const c = cells('aaaa bbbb cccc dddd')
  c[4] = ''
  c[9] = ''
  assert.deepEqual(planWrap(c, 12).rows, [[0, 9], [10, 19]])
})
await check('a word longer than the row is cut at the row', () => {
  assert.deepEqual(planWrap(cells('x'.repeat(25)), 10).rows, [[0, 10], [10, 20], [20, 25]])
})
await check('a wide character is never split', () => {
  const c = [...cells('abcdefgh'), '字', null, ...cells('ij')]
  assert.deepEqual(planWrap(c, 9).rows, [[0, 8], [8, 12]])
})
await check('a rule drawn at the old width is cut, not carried', () => {
  assert.deepEqual(planWrap(cells('─'.repeat(60)), 44).rows, [[0, 44]])
})

// 2. A real xterm.
const reply = [
  '⏺ It switched because of a hook that raised effort by mistake.',
  '',
  '  Cause: the hook types a command into the pane whenever a',
  '  prompt contains a workflow-type word (workflow, hook, skill,',
  '  agent, pipeline and similar).',
  '  - pasted hook errors and terminal output that went on and on',
  '─'.repeat(60)
]
const write = (t, s) => new Promise((r) => t.write(s, r))
const scrollback = (t) => {
  const b = t.buffer.active
  const out = []
  for (let i = 0; i < b.baseY; i++) out.push(b.getLine(i).translateToString(true))
  return out
}
const narrowed = async (fixed) => {
  const t = new Terminal({ cols: 60, rows: 6, scrollback: 1000, allowProposedApi: true })
  if (fixed) rewrapOnShrink(t)
  await write(t, reply.join('\r\n') + '\r\n' + 'screen\r\n'.repeat(6))
  t.resize(44, 6)
  return scrollback(t).filter((l) => l.trim())
}
await check('a bare terminal cuts through words (the control)', async () => {
  const rows = await narrowed(false)
  assert.ok(rows.includes('hat went on and on'), rows.join('\n'))
})
await check('narrowed, the scrollback breaks between words and hangs', async () => {
  const rows = await narrowed(true)
  assert.deepEqual(rows, [
    '⏺ It switched because of a hook that raised',
    'effort by mistake.',
    '  Cause: the hook types a command into the',
    '  pane whenever a prompt contains a',
    '  workflow-type word (workflow, hook, skill,',
    '  agent, pipeline and similar).',
    '  - pasted hook errors and terminal output',
    '    that went on and on',
    '─'.repeat(44),
    'screen'
  ])
})
await check('a wrapped list item joins its own continuation, not the next item', async () => {
  const t = new Terminal({ cols: 60, rows: 3, scrollback: 100, allowProposedApi: true })
  rewrapOnShrink(t)
  await write(
    t,
    [
      '  - the first item runs long enough that the CLI ended it here',
      '    and carried on under its own text',
      '  - the second item',
      '  ⎿  a tool result line that is not part of the item above it'
    ].join('\r\n') + '\r\n' + 'x\r\n'.repeat(3)
  )
  t.resize(44, 3)
  assert.deepEqual(scrollback(t).filter((l) => l.trim() && l !== 'x'), [
    '  - the first item runs long enough that the',
    '    CLI ended it here and carried on under',
    '    its own text',
    '  - the second item',
    '  ⎿  a tool result line that is not part of',
    '     the item above it'
  ])
})
await check('rows keep their colours', async () => {
  const t = new Terminal({ cols: 30, rows: 3, scrollback: 100, allowProposedApi: true })
  rewrapOnShrink(t)
  await write(t, 'plain words then \x1b[31mred words at the end\x1b[0m\r\n' + 'x\r\n'.repeat(3))
  t.resize(19, 3)
  const b = t.buffer.active
  const second = b.getLine(1)
  assert.equal(second.translateToString(true), 'red words at the')
  assert.equal(second.getCell(0).getFgColor(), 1)
})
await check('a pane that is scrolled up stays on the same text', async () => {
  const t = new Terminal({ cols: 40, rows: 4, scrollback: 500, allowProposedApi: true })
  rewrapOnShrink(t)
  const long = (i) => `line ${i} has quite a few words in it now`
  await write(t, Array.from({ length: 30 }, (_, i) => long(i)).join('\r\n') + '\r\n')
  t.scrollToLine(10)
  t.resize(30, 4)
  const b = t.buffer.active
  assert.ok(b.viewportY < b.baseY)
  assert.ok(b.getLine(b.viewportY).translateToString(true).startsWith('line '))
})
await check('a full scrollback makes room off its oldest end', async () => {
  const t = new Terminal({ cols: 40, rows: 4, scrollback: 20, allowProposedApi: true })
  rewrapOnShrink(t)
  const long = (i) => `line ${String(i).padStart(2, '0')} has quite a few words in it now`
  await write(t, Array.from({ length: 40 }, (_, i) => long(i)).join('\r\n') + '\r\n')
  t.resize(30, 4)
  const b = t.buffer.active
  assert.ok(b.length <= 24, `length ${b.length}`)
  const rows = scrollback(t)
  const firsts = rows.filter((l) => l.startsWith('line ')).map((l) => +l.slice(5, 7))
  assert.deepEqual(firsts, [...firsts].sort((a, c) => a - c), rows.join('\n'))
})

console.log(`\n${passed} passed`)
