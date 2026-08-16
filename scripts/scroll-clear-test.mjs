// What survives an agent clearing its own screen.
//
// Two halves, and the second one is the point:
//
//   1. the transformer, as arithmetic - what it rewrites, what it passes through, and that
//      a sequence split across two chunks from the pty is still recognised;
//   2. the RESULT, in a real xterm.js: write a screen, clear it the way Claude Code really
//      does (measured off this machine's pane logs: `CSI 2 J` and `CSI 3 J`, always paired),
//      and assert the old screen is in the scrollback afterwards. Nothing about the
//      rewrite's shape proves that - only the buffer does.
//
//   node scripts/scroll-clear-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-scroll-clear-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'keep.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/keepScrollback.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const require_ = createRequire(import.meta.url)
const { keepScrollback, clearsScreen, mayClearScreen, writtenRows } = require_(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
const keeper = (rows = 24, alt = false) => keepScrollback(() => rows, () => alt)

// --- the rewrite -------------------------------------------------------------------
{
  const k = keeper(3)
  const out = k(`before${CLEAR}after`)
  check('the scrollback wipe is gone', !out.includes('\x1b[3J'), JSON.stringify(out))
  check('and so is the erase it came with', !out.includes('\x1b[2J'), JSON.stringify(out))
  check('everything around it is untouched', out.startsWith('before') && out.endsWith('\x1b[Hafter'))
  eq('one newline per row on screen', (out.match(/\r\n/g) ?? []).length, 3)
  check('the cursor is put back where the clear found it', out.includes('\x1b7') && out.includes('\x1b8'))
}

// A pane that is not clearing anything must come through byte for byte - this sits in
// front of every byte an agent writes.
{
  const k = keeper()
  const noisy = '\x1b[0m\x1b[K\x1b[38;5;174mhello\x1b[39m\r\n\x1b[?25l\x1b[2Cworld'
  eq('ordinary output is not touched', k(noisy), noisy)
}

// vim, less, a menu: they clear constantly, have no scrollback of their own, and pushing
// a frame of redraw into the real one several times a second is the worst case here.
{
  const k = keeper(24, true)
  eq('the alternate screen keeps its own clears', k(`x${CLEAR}y`), `x${CLEAR}y`)
}

// --- split across chunks -----------------------------------------------------------
// The pty hands over whatever the kernel had; a four-byte sequence is routinely torn.
{
  const k = keeper(2)
  const first = k('a\x1b[')
  eq('a partial sequence is held back, not printed', first, 'a')
  const second = k('2J\x1b[3Jb')
  check('and is rewritten once the rest arrives', !second.includes('\x1b[2J') && !second.includes('\x1b[3J'), JSON.stringify(second))
  check('with the text after it intact', second.endsWith('b'))
}
{
  // Torn in the middle of the SECOND sequence, which is the one that is dropped entirely.
  const k = keeper(2)
  eq('the first half of a wipe holds', k('q\x1b[3'), 'q')
  eq('and the wipe disappears when it completes', k('J'), '')
}
{
  // A lone ESC is a real keystroke echoed back, and holding it for a byte that never comes
  // would stall the pane.
  const k = keeper()
  eq('a trailing ESC is held', k('\x1b'), '')
  eq('and released as itself when the next chunk is ordinary', k('OA'), '\x1bOA')
}

// --- the result, in a real terminal --------------------------------------------------
// esbuild the same module the app uses, then drive @xterm/xterm's headless build with it.
{
  let Terminal
  try {
    ;({ Terminal } = require_('@xterm/headless'))
  } catch {
    console.log('scroll clear: SKIPPED the buffer half - @xterm/headless is not installed')
  }
  if (Terminal) {
    const rows = 10
    const write = (t, s) => new Promise((r) => t.write(s, r))
    const term = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
    const k = keepScrollback(() => term.rows, () => term.buffer.active.type === 'alternate')

    for (let i = 1; i <= rows; i++) await write(term, k(`line ${i}\r\n`))
    await write(term, k(CLEAR))
    await write(term, k('a fresh prompt'))

    const all = []
    for (let y = 0; y < term.buffer.active.length; y++) {
      all.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    const text = all.join('\n')
    check('the cleared screen is still in the buffer', text.includes('line 1'), text.slice(0, 200))
    check('all of it, not the tail', text.includes('line 9') && text.includes('line 10'))
    check('and the new prompt is there too', text.includes('a fresh prompt'))
    check(
      'the visible screen is blank apart from the prompt',
      all
        .slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
        .filter((l) => l.trim() && !l.includes('a fresh prompt')).length === 0,
      JSON.stringify(all.slice(term.buffer.active.baseY))
    )

    // The control: without the transformer, `3J` really does destroy it. If this ever
    // stops being true the feature is pointless and this file should say so.
    const bare = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
    for (let i = 1; i <= rows; i++) await write(bare, `line ${i}\r\n`)
    await write(bare, CLEAR)
    const left = []
    for (let y = 0; y < bare.buffer.active.length; y++) {
      left.push(bare.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    check('a plain terminal loses it, which is the bug', !left.join('\n').includes('line 1'))
  }
}

// --- what a clear really looks like now ------------------------------------------------
// Two shapes measured off this machine's pane logs, neither of which can be caught by
// looking at the bytes:
//
//   v2.1.229: an erase-per-row full repaint - and 58 of the 60 in one session log are
//             ordinary repaints, so rewriting them is not an option either;
//   v2.1.233: `ESC[6A` and the banner drawn straight over the last turn. No erase at all.
//
// So `arm()` does the keeping itself, off the submitted line, before the CLI says a word.
const wipe = (rows) => '\x1b[H\x1b[2K' + '\x1b[1B\x1b[2K'.repeat(rows) + '\x1b[1B\x1b[H'
{
  const k = keeper(10)
  eq('an unarmed repaint is passed through untouched', k(wipe(10)), wipe(10))
  eq('and so is a cursor-up overdraw, which is all v2.1.233 sends', k('\x1b[6Ax'), '\x1b[6Ax')
}
{
  const k = keeper(10)
  const away = k.arm()
  check('arming hands the pane a scroll to write', away.startsWith('\x1b[10;1H'), JSON.stringify(away))
  eq('one newline per row on screen', (away.match(/\r\n/g) ?? []).length, 10)
  check('and homes the cursor, so the banner is drawn at the top', away.endsWith('\x1b[1;1H'))
}
{
  // The alternate screen has no scrollback to keep and clears constantly.
  const k = keeper(10, true)
  eq('nothing is scrolled on the alternate screen', k.arm(), '')
}
{
  // The screen is blank by the time the CLI reacts, so its own wipe is left alone: a
  // second scroll would file a screenful of blank rows in front of the turn being kept.
  const k = keeper(10)
  k.arm()
  eq('the CLI’s own repaint after an armed clear is untouched', k(wipe(10)), wipe(10))
  eq('and so is a 2J that follows one', k('\x1b[2Jx'), '\x1b[2Jx')
  eq('while 3J is dropped whatever else is true', k('\x1b[3Jy'), 'y')
}
{
  // Armed and then left alone: the stand-down has to lapse rather than leave an
  // unasked-for clear minutes later destroying the screen.
  let now = 0
  const k = keepScrollback(() => 10, () => false, () => now)
  k.arm()
  now = 10_001
  const out = k('\x1b[2J')
  check('a stale arming lapses and the rewrite is back', out.includes('\x1b[10;1H'), JSON.stringify(out))
}
{
  const k = keeper(10)
  eq('an unarmed pane does not hold cursor traffic back', k('\x1b[H'), '\x1b[H')
}
eq('a slash clear arms it', clearsScreen('/clear'), true)
eq('so does compact', clearsScreen('  /compact  '), true)
eq('and codex’s new', clearsScreen('/new'), true)
eq('an ordinary prompt does not', clearsScreen('clear the cache in redis'), false)
eq('nor does a path that starts with a slash', clearsScreen('/etc/hosts is wrong'), false)

// --- what was typed is not what was sent ----------------------------------------------
// Measured in a real pane against a real Claude Code v2.1.233 on this machine: `/clear`
// typed whole keeps the previous answer (2 marker rows before the clear, 2 after), while
// the same clear picked off the CLI's completion menu after typing `/cle` destroys it
// (2 before, 0 after) - four characters that match nothing, no arm, banner drawn over the
// last turn. So a slash token that is a PREFIX of one of these arms too.
eq('a clear typed whole still arms', mayClearScreen('/clear'), true)
eq('and one picked from the menu after four letters', mayClearScreen('/cle'), true)
eq('and after one', mayClearScreen('/c'), true)
eq('and a bare slash, where every command is on the menu', mayClearScreen('/'), true)
eq('/co arms as /compact’s prefix, wrongly at worst', mayClearScreen('/co'), true)
// The other side of it. A false arm costs a scroll of a screen about to be repainted; a
// miss costs the turn somebody was reading. Neither is a reason to arm on everything.
eq('a whole command that is not one of them does not', mayClearScreen('/code-review'), false)
eq('nor does a different one', mayClearScreen('/doctor'), false)
eq('nor a slash command with an argument', mayClearScreen('/model opus'), false)
eq('nor an ordinary ask', mayClearScreen('can you clear the cache'), false)
eq('nor a path', mayClearScreen('/etc/hosts is wrong'), false)

// --- only the rows that hold something are filed --------------------------------------
// The screen ends blank either way: the rows below the last written one were blank before
// the scroll. Scrolling them anyway is what put a screenful of nothing into the scrollback
// in front of the turn being kept - and a false arm from the prefix rule above would do it
// on an otherwise ordinary command.
{
  const k = keepScrollback(() => 40, () => false, () => 0, () => 6)
  const away = k.arm()
  eq('one newline per WRITTEN row', (away.match(/\r\n/g) ?? []).length, 6)
  check('still from the bottom row', away.startsWith('\x1b[40;1H'), JSON.stringify(away))
  check('and still homed afterwards', away.endsWith('\x1b[1;1H'))
}
{
  const k = keepScrollback(() => 40, () => false, () => 0, () => 0)
  eq('a blank screen files nothing', (k.arm().match(/\r\n/g) ?? []).length, 0)
}
{
  const k = keepScrollback(() => 10, () => false, () => 0, () => 99)
  eq('and a reading taller than the pane is capped at it', (k.arm().match(/\r\n/g) ?? []).length, 10)
}

// --- the erase-per-row wipe, in a real terminal ---------------------------------------
{
  let Terminal
  try {
    ;({ Terminal } = require_('@xterm/headless'))
  } catch {
    /* already reported above */
  }
  if (Terminal) {
    const rows = 10
    const write = (t, s) => new Promise((r) => t.write(s, r))
    const lines = async (t) => {
      const all = []
      for (let y = 0; y < t.buffer.active.length; y++) {
        all.push(t.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      return all.join('\n')
    }

    for (const [name, clear, lost] of [
      // v2.1.229's erase-per-row, and v2.1.233's cursor-up-and-overdraw - which erases
      // nothing, so no rewrite of any kind could ever have caught it.
      // The third entry is the line a PLAIN terminal loses to that clear: the whole
      // screenful for the wipe, and the one row the overdraw lands on for the other.
      ['an erase-per-row wipe', wipe(rows), 'turn 10'],
      // Byte for byte what v2.1.233 sends, copied out of this machine's pane log rather
      // than shortened to the cursor-up that carries the meaning: the two moves before it
      // are what decides which row the banner lands on, and a fixture that drops them is
      // not the shape of the real thing.
      ['a bare cursor-up overdraw', '\x1b[53D\x1b[4B\r\x1b[6A', 'turn 5']
    ]) {
      const term = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
      const k = keepScrollback(() => term.rows, () => term.buffer.active.type === 'alternate')
      for (let i = 1; i <= rows; i++) await write(term, k(`turn ${i}\r\n`))
      await write(term, k.arm())
      await write(term, k(clear))
      await write(term, k('Claude Code v2.1.233'))
      const text = await lines(term)
      check(`${name}: the cleared screen is still in the buffer`, text.includes('turn 1'), text.slice(0, 200))
      check(`${name}: all of it, not the tail`, text.includes('turn 9') && text.includes('turn 10'))
      check(`${name}: and the banner is there`, text.includes('Claude Code v2.1.233'))
      const screen = []
      for (let y = term.buffer.active.baseY; y < term.buffer.active.baseY + rows; y++) {
        screen.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      check(
        `${name}: and nothing of the old turn is left on screen`,
        !screen.join('\n').includes('turn '),
        JSON.stringify(screen)
      )
      check(`${name}: the banner is at the top of it`, screen[0].includes('Claude Code v2.1.233'), JSON.stringify(screen[0]))

      // The control. This is the bug as reported, and the second shape is the one that
      // made the old rewrite a no-op: the last screenful gone, the banner over the top.
      const bare = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
      for (let i = 1; i <= rows; i++) await write(bare, `turn ${i}\r\n`)
      await write(bare, clear)
      await write(bare, 'Claude Code v2.1.233')
      const left = await lines(bare)
      check(`${name}: a plain terminal loses ${lost}, which is the bug`, !left.includes(lost), left.slice(0, 200))
    }
  }
}

// --- the reading the pane really passes, against a real buffer -------------------------
// The stubs above are arithmetic: they cannot catch an off-by-one in the walk that counts
// the written rows, and a walk copied into this file would prove nothing about the one the
// pane ships. So `writtenRows` is exported and driven here against a real xterm, and the
// whole path is exercised the way a person triggers it: `/cle` picked off the CLI's
// completion menu, which is the case that was destroying the screen.
{
  let Terminal
  try {
    ;({ Terminal } = require_('@xterm/headless'))
  } catch {
    /* already reported above */
  }
  if (Terminal) {
    const rows = 10
    const write = (t, s) => new Promise((r) => t.write(s, r))
    const term = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
    const k = keepScrollback(
      () => term.rows,
      () => term.buffer.active.type === 'alternate',
      Date.now,
      () => writtenRows(term)
    )
    eq('a blank screen has nothing written on it', writtenRows(term), 0)
    for (const line of ['turn 1', 'turn 2', 'the answer worth keeping']) await write(term, k(`${line}\r\n`))
    eq('three written rows and the cursor on the fourth', writtenRows(term), 3)

    check('and the menu pick arms', mayClearScreen('/cle'))
    const away = k.arm()
    eq('so three rows are filed, not a screenful', (away.match(/\r\n/g) ?? []).length, 3)
    await write(term, away)
    // v2.1.233's clear, byte for byte, then the banner over whatever it lands on.
    await write(term, k('\x1b[53D\x1b[4B\r\x1b[6A'))
    await write(term, k('Claude Code v2.1.233'))

    const all = []
    for (let y = 0; y < term.buffer.active.length; y++) {
      all.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    check('the answer survived the menu-picked clear', all.join('\n').includes('the answer worth keeping'), JSON.stringify(all))
    const screen = all.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
    check('the screen is the banner and nothing else', !screen.join('\n').includes('turn '), JSON.stringify(screen))
    // The point of counting: what is above the kept turn is the turn before it, not a
    // screenful of blank rows the scroll invented.
    const kept = all.findIndex((l) => l.includes('the answer worth keeping'))
    check('and nothing blank was filed in front of it', all[kept - 1].includes('turn 2'), JSON.stringify(all.slice(0, kept + 1)))

    // The control, on the same shipped walk: exact-match-only would not have armed here,
    // and this is the screen that leaves.
    const bare = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
    for (const line of ['turn 1', 'turn 2', 'the answer worth keeping']) await write(bare, `${line}\r\n`)
    await write(bare, '\x1b[53D\x1b[4B\r\x1b[6A')
    await write(bare, 'Claude Code v2.1.233')
    const left = []
    for (let y = 0; y < bare.buffer.active.length; y++) {
      left.push(bare.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    // Which row the banner lands on is the CLI's arithmetic, not ours - four down and six
    // up from a cursor on row 4 is row 2 here, and the last turn on a full screen. Either
    // way the row is destroyed in place with nothing pushed into the scrollback, and that
    // is the bug: on the armed run above, every one of these rows is still readable.
    check(
      'an unarmed pane loses the row the banner lands on, which is the bug',
      !left.join('\n').includes('turn 2'),
      JSON.stringify(left.slice(0, 6))
    )
    check('and nothing of it reached the scrollback', bare.buffer.active.baseY === 0)
  }
}

console.log(`scroll clear: ${checks} checks passed`)
