// Rows a Claude Code repaint pushes off the top of the screen without scrolling them.
//
// Claude Code redraws its frame in place: when what is on screen moves down the reply, it
// goes back to the top row and paints every row `m` rows further on, so the top `m` rows are
// painted over instead of scrolled into the scrollback - a hole in the middle of a finished
// reply, in any terminal. Pane s129 lost 14 lines that way on 2026-09-25. See
// src/shared/pushedOffTop.ts.
//
// Three halves:
//   1. the rule as pure functions - which screens prove a shift, and what goes back;
//   2. a hand-made screen through a real xterm: the rows come back above the screen, in
//      order, with a bare terminal as the control, and the refusals (resized mid-frame, a
//      frame that moved nothing, a block that went from the middle);
//   3. the measured frame: scripts/fixtures/claude-shrink-cursor-up.bin (s129, letters
//      masked - see cursor-up-realign-test.mjs) replayed at 130x55 with both of the pane's
//      Claude fixes, as the pane installs them: the 14 lines come back, nothing that was
//      already there is shown twice.
//
//   node scripts/pushed-off-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pushed-off-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const bundle = (entry, name) => {
  const outfile = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile })
  return outfile
}
const require_ = createRequire(import.meta.url)
const { displaced, toKeep, keepPushedOffRows } = require_(bundle('src/shared/pushedOffTop.ts', 'keep.cjs'))
const { realignCursorUp } = require_(bundle('src/shared/cursorUpRealign.ts', 'realign.cjs'))
const { Terminal } = require_('@xterm/headless')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}
const row = (i) => `line ${String(i).padStart(2, '0')} of the finished reply`

// 1. The rule.
const screen = Array.from({ length: 10 }, (_, i) => row(i + 1))
await check('a screen moved up 3 rows proves 3 rows went off the top', () => {
  const after = [...screen.slice(3), 'new a', 'new b', 'new c']
  assert.equal(displaced(screen, after), 3)
})
await check('a screen painted back in place moved nothing', () => {
  assert.equal(displaced(screen, [...screen]), 0)
})
await check('a block that went from the middle is not the top going', () => {
  const after = [...screen.slice(0, 2), ...screen.slice(5), '', '', '']
  assert.equal(displaced(screen, after), 0)
})
await check('fewer than five long rows moved is not proof', () => {
  const short = ['a', 'b', 'c', ...screen.slice(3, 7), 'd', 'e', 'f']
  assert.equal(displaced(short, [...short.slice(3), 'x', 'y', 'z']), 0)
})
await check('what goes back: every row above the shift but text already in the buffer', () => {
  const has = (key) => key === 'line 02 of the finished reply'
  assert.deepEqual(toKeep(['line 01 of the finished reply', 'line 02 of the finished reply', ''], 3, has), [0, 2])
})
await check('rows with nothing on them never go back on their own', () => {
  assert.deepEqual(toKeep(['', '  ', ''], 3, () => false), [])
})

// 2. A real xterm.
const write = (t, s) => new Promise((r) => t.write(s, r))
const lines = (t) => {
  const b = t.buffer.active
  const out = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true))
  return out
}
/** A full 10-row screen of a finished reply, then a repaint from the top that moved it up 3. */
const repaint = '\x1b[H' + [...screen.slice(3), 'the next part', 'of the reply', 'appears here'].map((s) => `\x1b[2K${s}`).join('\r\n') + '\x1b[?25h'
let heard = 0
const fresh = async (keep, scrollback = 100) => {
  const t = new Terminal({ cols: 60, rows: 10, scrollback, allowProposedApi: true })
  if (keep) keepPushedOffRows(t, () => heard++)
  await write(t, 'earlier output\r\n' + screen.join('\r\n'))
  return t
}
await check('bare: the three rows painted over are gone', async () => {
  const t = await fresh(false)
  await write(t, repaint)
  assert.equal(lines(t).filter((l) => /line 0[123] /.test(l)).length, 0)
  t.dispose()
})
await check('kept: they are back above the screen, in order, once each, and the pane hears it', async () => {
  const t = await fresh(true)
  heard = 0
  await write(t, repaint)
  assert.equal(heard, 1)
  const all = lines(t)
  assert.deepEqual(all.slice(0, 4), ['earlier output', row(1), row(2), row(3)])
  assert.equal(all.slice(4).join('\n'), [...screen.slice(3), 'the next part', 'of the reply', 'appears here'].join('\n'))
  assert.equal(t.buffer.active.baseY, 4)
  t.dispose()
})
await check('a full scrollback drops its oldest lines to make room, and the screen stays put', async () => {
  const t = await fresh(true, 2)
  await write(t, repaint)
  const all = lines(t)
  assert.equal(all.length, 12)
  assert.deepEqual(all.slice(0, 2), [row(2), row(3)])
  assert.equal(all.slice(2).join('\n'), [...screen.slice(3), 'the next part', 'of the reply', 'appears here'].join('\n'))
  assert.equal(t.buffer.active.baseY, 2)
  t.dispose()
})
await check('the scroll the pane writes for /clear, and the banner after it, add nothing', async () => {
  const { keepScrollback, keptRows } = require_(bundle('src/shared/keepScrollback.ts', 'keep-scrollback.cjs'))
  const run = async (keep) => {
    const t = await fresh(keep)
    const keeper = keepScrollback(() => t.rows, () => t.buffer.active.type === 'alternate', Date.now, () => keptRows(t))
    await write(t, keeper.arm() + '\x1b[4B\r\x1b[6A' + ' Claude Code banner line one\r\n banner line two, the model\r\n banner line three, the folder' + '\x1b[?25h')
    const out = lines(t)
    t.dispose()
    return out
  }
  assert.deepEqual(await run(true), await run(false))
})
await check('a pane resized mid-frame keeps nothing', async () => {
  const t = await fresh(true)
  await write(t, repaint.slice(0, 20))
  t.resize(60, 10)
  t.resize(61, 10)
  t.resize(60, 10)
  await write(t, repaint.slice(20))
  assert.equal(lines(t).filter((l) => /line 0[123] /.test(l)).length, 0)
  t.dispose()
})
await check('a repaint that moved nothing adds nothing', async () => {
  const t = await fresh(true)
  const before = lines(t).length
  await write(t, '\x1b[H' + screen.map((s) => `\x1b[2K${s}`).join('\r\n') + '\x1b[?25h')
  assert.equal(lines(t).length, before)
  t.dispose()
})

// 3. The measured frame.
const fixture = readFileSync(join(root, 'scripts/fixtures/claude-shrink-cursor-up.bin'))
const replay = async (keep) => {
  const t = new Terminal({ cols: 130, rows: 55, scrollback: 5000, allowProposedApi: true })
  // The order TerminalPane installs them in: the realign must run first, so it goes last.
  if (keep) keepPushedOffRows(t, () => {})
  realignCursorUp(t)
  await write(t, fixture)
  const out = lines(t)
  t.dispose()
  return out
}
// "The Toolstash sorter", masked: the first of the 14 lines the repaint painted over.
const FIRST = '  - Xxx Xxxxxxxxx xxxxxx '
const without = await replay(false)
const kept = await replay(true)
await check('control: without it the first painted-over line is nowhere', () => {
  assert.equal(without.filter((l) => l.startsWith(FIRST)).length, 0)
})
await check('with it the 14 lines are back, and it is 14', () => {
  assert.equal(kept.filter((l) => l.startsWith(FIRST)).length, 1)
  assert.equal(kept.length - without.length, 14)
})
await check('nothing that was already in the buffer shows twice', () => {
  const tally = (list) => list.filter((l) => l.trim().length >= 12).reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map())
  const a = tally(without)
  for (const [line, n] of tally(kept)) if (a.has(line)) assert.equal(n, a.get(line), line)
})

console.log(`\n${passed} passed`)
