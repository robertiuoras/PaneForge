// A cursor-up past the top of the screen, in a Claude Code pane.
//
// Claude Code writes the gap between two words as a cursor jump (`CSI n G`) over a cell it
// believes is blank. After its frame shrinks at the bottom of a full screen it believes the
// screen shows one more line from the top than it does, and its next repaint starts with a
// cursor-up the terminal clamps - so the whole repaint lands a row too high and every gap
// shows the row above: word gaps full of stray letters, copied out of pane s129 on
// 2026-09-25. See src/shared/cursorUpRealign.ts.
//
// Three halves:
//   1. the guard, as arithmetic - which cursor-ups are brought back and which clamp;
//   2. a hand-made screen with a two-line shortfall, so the ORDER the lines come back in
//      is pinned, with a bare terminal as the control;
//   3. the measured frame: scripts/fixtures/claude-shrink-cursor-up.bin is s129's log from
//      Claude Code's last full repaint (ESC[H, 55 row erases, ESC[H) to the end of the frame
//      that tore the line, every letter outside an escape sequence masked to x or X and
//      every digit to 0 - this repo is public, the conversation must not be recoverable,
//      and the bytes' shape (what the test is about) is untouched. Replayed at s129's 130x55 through a real xterm: bare, the torn
//      line comes back (the control that the fixture still reproduces); with the fix, the
//      line Claude Code sent.
//
//   node scripts/cursor-up-realign-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-cursor-up-realign-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'realign.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/cursorUpRealign.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const require_ = createRequire(import.meta.url)
const { realignCursorUp, shortfall } = require_(outfile)
const { Terminal } = require_('@xterm/headless')

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

// 1. The guard.
check('the measured shape: up 54 from row 53 of 55, one blank row under it', () => {
  assert.equal(shortfall(54, 53, 55, 1, 43), 1)
})
check('a cursor-up that fits is left alone', () => {
  assert.equal(shortfall(9, 53, 55, 1, 43), 0)
  assert.equal(shortfall(53, 53, 55, 1, 43), 0)
})
check('ESC[999A as "go to the top" clamps as it always has', () => {
  assert.equal(shortfall(999, 3, 55, 51, 400), 0)
})
check('rows under the cursor that still hold something are never pushed off', () => {
  assert.equal(shortfall(54, 53, 55, 0, 43), 0)
  assert.equal(shortfall(56, 53, 55, 1, 43), 0)
})
check('nothing in the scrollback to bring back: plain clamp', () => {
  assert.equal(shortfall(54, 53, 55, 1, 0), 0)
})
check('a cursor-up from high on the screen is not a shrunk frame: plain clamp', () => {
  // Claude Code's banner after /clear: ESC[4B \r ESC[6A from the top of an emptied screen.
  assert.equal(shortfall(6, 4, 55, 50, 400), 0)
})

const write = (t, data) => new Promise((resolve) => t.write(data, resolve))
const screen = (t) => {
  const b = t.buffer.active
  const out = []
  for (let y = b.baseY; y < b.baseY + t.rows; y++) out.push(b.getLine(y).translateToString(true))
  return out
}
const all = (t) => {
  const b = t.buffer.active
  const out = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true))
  return out
}

// 2. A hand-made two-line shortfall. Six lines on a four-row screen (L1, L2 in the
// scrollback), the bottom two erased walking up - the frame shrank by two - and then the
// CLI moves up three from where it believes it is (the last row) and marks the line.
const hand = async (fix) => {
  const t = new Terminal({ cols: 20, rows: 4, scrollback: 100, allowProposedApi: true })
  if (fix) realignCursorUp(t)
  await write(t, 'L1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6')
  await write(t, '\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[G')
  await write(t, '\x1b[3AX')
  return t
}
{
  const bare = await hand(false)
  const fixed = await hand(true)
  check('control: a bare terminal clamps and marks the wrong line', () => {
    assert.deepEqual(screen(bare), ['X3', 'L4', '', ''])
  })
  check('fixed: the two lines come back in order and the mark lands on L1', () => {
    assert.deepEqual(screen(fixed), ['X1', 'L2', 'L3', 'L4'])
    assert.equal(fixed.buffer.active.cursorY, 0)
  })
  check('fixed: the scrollback still has what it had', () => {
    assert.deepEqual(all(fixed).slice(0, 2), ['L1', 'L2'])
  })
}

// The pane's own /clear: it scrolls the turn into the scrollback and empties the screen
// (shared/keepScrollback.ts `arm()`), then Claude Code draws its banner with a cursor-up
// from row 4. Bringing rows back there would put the kept turn on the cleared screen.
{
  const t = new Terminal({ cols: 30, rows: 6, scrollback: 100, allowProposedApi: true })
  realignCursorUp(t)
  await write(t, 'turn 1\r\nturn 2\r\nthe answer worth keeping\r\n\r\n\r\n\r\n\r\n\r\n\r\n\x1b[1;1H\x1b[J')
  await write(t, '\x1b[4B\r\x1b[6ABANNER')
  check('the /clear banner lands on an empty screen, the kept turn stays in the scrollback', () => {
    assert.deepEqual(screen(t), ['BANNER', '', '', '', '', ''])
    assert.ok(all(t).includes('the answer worth keeping'))
  })
}

// 3. The measured frame.
const fixture = readFileSync(join(root, 'scripts/fixtures/claude-shrink-cursor-up.bin'))
const replay = async (fix) => {
  const t = new Terminal({ cols: 130, rows: 55, scrollback: 5000, allowProposedApi: true })
  if (fix) realignCursorUp(t)
  await write(t, fixture)
  return all(t)
}
// Masked the same way as the fixture. The torn line has letters where the sent one has
// the spaces between words.
const SENT_OFFER =
  '  - Xx xxxxx xxx xxxxx xxxx: x xxxxxx-xxxx XX xxxxxxxxxxxx xxx xxxxxxx xx xxxxx $000 x xxxxx. Xx 00 xxxxx x xxxxx Xxxxx xxxxx'
const SENT_COST =
  "  - Xxxx: Xxxxx'x Xxxxx xxxx xx $0.00 xxx xxxxxx xxxx xx xxxxxxxx xxx (xxxxx.xx/xxxxxxx), xx x 0-xxxxxx xxxx xxxx xxx xxxx xx"
const SENT_NEXT =
  "  - X xxxxxx'x xxxx xxx Xxxxxx xxxxx xxxxxxx xxx xxxxxxx xxxx xxxxx xx x xxxxxxx."
const TORN_OFFER =
  '  - Xx xxxxx xxx xxxxx xxxx:xxxxxxxxx-xxxxxXX xxxxxxxxxxxx.xxx xxxxxxx xx xxxxx $000 x xxxxx. Xx 00 xxxxx x xxxxx Xxxxx xxxxx'
{
  const bare = await replay(false)
  const fixed = await replay(true)
  check('control: the fixture still tears the line in a bare terminal', () => {
    assert.ok(bare.includes(TORN_OFFER), 'the torn line is missing - the fixture no longer reproduces')
    assert.ok(!bare.includes(SENT_OFFER))
  })
  check('fixed: the line reads as Claude Code sent it', () => {
    assert.ok(fixed.includes(SENT_OFFER), fixed.find((l) => l.startsWith('  - Xx xxxxx xxx')) ?? '(no line)')
    assert.ok(!fixed.includes(TORN_OFFER))
  })
  check('fixed: the line above it too', () => {
    assert.ok(fixed.includes(SENT_COST), fixed.find((l) => l.startsWith('  - Xxxx: Xxxxx')) ?? '(no line)')
  })
  check('fixed: the rest of the repaint reads as sent, not only the reported line', () => {
    assert.ok(fixed.includes(SENT_NEXT), fixed.find((l) => l.startsWith('  - X xxxxxx')) ?? '(no line)')
  })
  // What the pane showed until Claude Code's next full repaint: every row of this one that
  // a bare terminal draws and the fixed one does not: 31 in the masked fixture, 32 in the real log.
  const kept = new Map()
  for (const l of fixed) kept.set(l, (kept.get(l) ?? 0) + 1)
  let torn = 0
  for (const l of bare) {
    const n = kept.get(l) ?? 0
    if (n) kept.set(l, n - 1)
    else torn++
  }
  check(`control: the bare repaint left ${torn} torn rows on screen`, () => {
    assert.ok(torn >= 2)
  })
}

console.log(`\n${passed} passed`)
