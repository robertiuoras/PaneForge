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
const { keepScrollback, clearsScreen, mayClearScreen, writtenRows, keptRows, ruleRow, composerTop } = require_(outfile)

// The other half of the answer: what the pane does once a wipe has been reported.
const lossFile = outfile.replace(/keep\.bundle\.cjs$/, 'loss.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/screenLoss.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: lossFile
})
const { screenLost, fileRows } = require_(lossFile)

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

// The whole answer in a real terminal, with NOTHING armed - the shape a Clear button, a
// phone, or a CLI compacting itself produces. The clear is byte for byte what Claude Code
// v2.1.235 sends, captured 2026-08-19 from a live `claude` in a real pty: a home, every
// row erased walking down, a home, the banner. What runs here is what the pane runs: the
// keeper reports, `screenLost` judges the settled screen, `fileRows` writes it back.
{
  let Terminal
  try {
    ;({ Terminal } = require_('@xterm/headless'))
  } catch {
    console.log('scroll clear: SKIPPED the unarmed-wipe half - @xterm/headless is not installed')
  }
  if (Terminal) {
    const write = (t, d) => new Promise((r) => t.write(d, r))
    const rows = 12
    const real = '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(rows) + '\x1b[H'
    const banner = '   Claude Code v2.1.235'
    // One short of a screenful and no trailing newline: nothing has scrolled by itself, so
    // every one of these rows is on the live screen and reaches the scrollback only if the
    // pane puts it there. A seed that scrolls makes the control below pass for free.
    const seed = async (t, k) => {
      for (let i = 1; i < rows; i++) {
        const line = `turn ${i}` + (i === rows - 1 ? '' : '\r\n')
        await write(t, k ? k(line) : line)
      }
    }
    const screenOf = (t) => {
      const out = []
      for (let y = t.buffer.active.baseY; y < t.buffer.active.baseY + t.rows; y++) {
        out.push(t.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      return out
    }
    const readAll = (t) => {
      const all = []
      for (let y = 0; y < t.buffer.active.length; y++) {
        all.push(t.buffer.active.getLine(y)?.translateToString(true) ?? '')
      }
      return all.join('\n')
    }

    // What the pane does, in the order it does it.
    const run = async (clear, draw) => {
      const term = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
      let snap = null
      const k = keepScrollback(
        () => term.rows,
        () => term.buffer.active.type === 'alternate',
        Date.now,
        () => keptRows(term),
        () => {
          if (!snap) snap = screenOf(term)
        }
      )
      await seed(term, k)
      await write(term, k(clear))
      await write(term, k(draw))
      const filed = snap && screenLost(snap, screenOf(term))
      if (filed) await write(term, fileRows(snap, term.rows))
      return { term, snap, filed }
    }

    const cleared = await run(real, banner)
    check('a clear is judged a loss and filed', cleared.filed === true)
    const text = readAll(cleared.term)
    check('an unarmed v2.1.235 clear keeps the screen it wiped', text.includes('turn 1'), text.slice(0, 200))
    check('all of it', text.includes('turn 10') && text.includes('turn 11'))
    const screen = screenOf(cleared.term)
    check('with nothing of the old screen left on it', !screen.join('\n').includes('turn '), JSON.stringify(screen))

    // The control: this is the bug, and without it the case above can pass by accident.
    const bare = new Terminal({ rows, cols: 40, scrollback: 1000, allowProposedApi: true })
    await seed(bare, null)
    await write(bare, real)
    await write(bare, banner)
    check('a plain terminal loses it, which is the report', !readAll(bare).includes('turn 1'))

    // And the case that decides whether any of this is worth having: the same bytes when
    // the CLI is only redrawing the frame it already had. Nothing may be filed, or the
    // scrollback fills with copies of the screen.
    const repainted = await run(real, ['turn 1', 'turn 2', 'turn 3', 'turn 4'].join('\r\n'))
    check('a full repaint of the same frame files nothing', repainted.filed === false)
    const again = readAll(repainted.term)
    eq('and leaves one copy of the screen, not two', (again.match(/turn 1\b/g) ?? []).length, 1)
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
// ...and then v2.1.235 sent a third shape, measured 2026-08-19 off a live `claude` in a
// real pty: `ESC[H` and then every row on the screen erased in place walking down. Three
// releases, three byte patterns.
//
// What they share is a SHAPE - the cursor sent to the top of the screen with an ERASE as
// the first thing that happens there - and the keeper reads that. It does NOT act on it:
// measured over this machine's pane logs, one Claude Code pane sent that exact shape 152
// times in 8.4 MB and most were ordinary mid-turn repaints, which lose nothing because the
// same frame is drawn straight back. Filing those would stuff the scrollback with
// duplicate frames, which is the reported bug arrived at from the other side. So a wipe is
// REPORTED, the pane remembers the screen, and `screenLost` decides once the redraw has
// settled - see `src/shared/screenLoss.ts`.
const wipes = (rows, chunks) => {
  let n = 0
  const k = keepScrollback(() => rows, () => false, () => 0, () => rows, () => n++)
  for (const c of chunks) k(c)
  return n
}
{
  eq('a wipe that starts at the top of the screen is reported', wipes(10, [wipe(10)]), 1)
  eq('once, however many rows it erases', wipes(10, [wipe(40)]), 1)
  eq('and torn across chunks it is still one wipe', wipes(10, ['\x1b[H', '\x1b[2K\x1b[1B\x1b[2K']), 1)
  const k = keepScrollback(() => 10, () => false, () => 0, () => 10, () => {})
  eq('the bytes themselves are passed through untouched', k(wipe(10)), wipe(10))
}
{
  // The negatives are the whole reason this is keyed on home-then-erase rather than on an
  // erase: 58 of 60 erase-per-row repaints in one session log were redraws of a composer
  // standing where it is, with no home in front of them.
  eq('an erase-per-row repaint with no home says nothing', wipes(10, ['\x1b[2K\x1b[1B\x1b[2K']), 0)
  eq('nor does a home that WRITES before it erases', wipes(10, ['\x1b[Hhello\x1b[2K']), 0)
  eq('nor a home that has moved off the top row again', wipes(10, ['\x1b[H\x1b[4B\x1b[2K']), 0)
  eq('nor a cursor-up overdraw, which is all v2.1.233 sends', wipes(10, ['\x1b[6Ax']), 0)
  eq('nor colour and cursor traffic on its own', wipes(10, ['\x1b[0m\x1b[?25l\x1b[38;5;174mx']), 0)
}
{
  // A clear the pane armed off the keystrokes has already filed the screen, colours and
  // all. Hearing about the CLI's own wipe a beat later would file it twice.
  let n = 0
  const k = keepScrollback(() => 10, () => false, () => 0, () => 10, () => n++)
  k.arm()
  k(wipe(10))
  eq('an armed clear does not report the wipe that follows it', n, 0)
}
{
  // What the pane does with the report, in the shared function it really calls.
  const before = ['❯ how do I log an error?', 'You can use the logger in', 'src/log.ts, like this:', '']
  eq(
    'a redraw that puts the same rows back lost nothing',
    screenLost(before, ['❯ how do I log an error?', 'You can use the logger in', 'src/log.ts, like this:', 'thinking… 4s']),
    false
  )
  eq('a banner on a blank screen lost the screen', screenLost(before, ['   Claude Code v2.1.235', '', '❯ ']), true)
  eq('a screen with nothing on it cannot lose anything', screenLost(['', '  ', ''], ['   Claude Code v2.1.235']), false)
  const bytes = fileRows(['first row of the answer', 'second row', '', ''], 10)
  // Two rows printed (one newline between them) and then one scroll each to file them.
  eq('trailing blank rows are not filed', (bytes.match(/\r\n/g) ?? []).length, 3)
  check('and what is filed is what was on the screen', bytes.includes('first row of the answer'))
  eq('and a blank screen files nothing at all', fileRows(['', ' '], 10), '')
}

{
  const k = keeper(10)
  const away = k.arm()
  check('arming hands the pane a scroll to write', away.startsWith('\x1b[10;1H'), JSON.stringify(away))
  eq('one newline per row on screen', (away.match(/\r\n/g) ?? []).length, 10)
  check('and homes the cursor, so the banner is drawn at the top', away.endsWith('\x1b[1;1H\x1b[J'))
  // A scroll of N rows moves the WHOLE screen up by N, so the rows it did not file - the
  // composer, its hint line - are still on screen, at the top, where the banner is about
  // to be drawn through them. Erasing from the home position down is what stops that; it
  // touches no scrollback, so what was just filed is safe.
  check('and erases what the scroll left on screen', away.includes('\x1b[J'))
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
  check('and still homed and cleared afterwards', away.endsWith('\x1b[1;1H\x1b[J'))
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


// --- the composer is UI, not history --------------------------------------------------
// At the moment a clear is submitted the composer is still drawing the line that was
// submitted, so filing the whole written screen kept `/clear` TWICE: once as the box that
// held it, and once as the CLI's own echo of it on the fresh screen. Measured in a live
// pane before this - six `❯ /clear` rows in the scrollback for three clears, which is
// "it shows duplicated /clear message".
eq('a rule row is frame and nothing else', ruleRow('─────────────'), true)
eq('a boxed rule counts too', ruleRow('╭──────────────╮'), true)
eq('a short separator does not', ruleRow('───'), false)
eq('nor a row with words on it', ruleRow('── the answer ──'), false)
eq('nor a blank row', ruleRow('   '), false)
{
  // A markdown separator in an ANSWER, with the caret nowhere near it: the pair of rules
  // this looks for must have the caret BETWEEN them, or a `---` in an answer would swallow
  // every row under it.
  const rows = ['turn 1', '────────────────', 'still the answer', '']
  const fake = {
    rows: 4,
    buffer: { active: { baseY: 0, cursorY: 3, getLine: (y) => ({ translateToString: () => rows[y] ?? '' }) } }
  }
  eq('a separator alone is not a composer', composerTop(fake, 3), null)
  eq('so the whole written screen is filed', keptRows(fake), 3)
}
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
      () => keptRows(term)
    )
    // A screen the shape Claude Code 2.1.234 really draws: the turn, then a composer ruled
    // top and bottom with the submitted line still in it, then its hint line.
    await write(term, k('turn 1\r\n'))
    await write(term, k('the answer worth keeping\r\n'))
    await write(term, k('────────────────────────\r\n'))
    await write(term, k('❯ /clear\r\n'))
    await write(term, k('────────────────────────\r\n'))
    await write(term, k('⏵⏵ bypass permissions on'))
    // The caret sits in the composer at submit time, which is what makes those two rules a
    // box rather than two separators.
    await write(term, k('\x1b[4;10H'))
    eq('six rows are written', writtenRows(term), 6)
    eq('but only the two above the composer are history', keptRows(term), 2)

    const away = k.arm()
    eq('so two rows are filed, not six', (away.match(/\r\n/g) ?? []).length, 2)
    await write(term, away)
    // The CLI then echoes the command itself on the fresh screen, as it always does.
    await write(term, k('❯ /clear\r\n'))

    const all = []
    for (let y = 0; y < term.buffer.active.length; y++) {
      all.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    }
    const clears = all.filter((l) => l.trim() === '❯ /clear').length
    eq('the command appears once, not twice', clears, 1)
    check('and the answer is still kept', all.join('\n').includes('the answer worth keeping'), JSON.stringify(all))

    // The rows the scroll did NOT file are the ones that were left drawn on screen, at the
    // top, for the banner to be painted through: a half-erased composer reading
    // `────|`, `❯ h 10%pass permissions on …`. Nothing of the old composer may survive the
    // arm - it is live UI the CLI redraws, not history.
    const screen = all.slice(term.buffer.active.baseY, term.buffer.active.baseY + rows)
    check(
      'and no scrap of the old composer is left on screen',
      !screen.join('\n').includes('bypass permissions'),
      JSON.stringify(screen)
    )
  }
}

console.log(`scroll clear: ${checks} checks passed`)
