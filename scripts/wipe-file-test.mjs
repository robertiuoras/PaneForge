// What the pane's wipe check files into the scrollback, and what it must never file.
//
// Claude Code's full repaint and `/clear` are the same bytes (ESC[H, an erase per row), so
// the pane snapshots the screen when one starts and, once the output goes quiet, files the
// rows the redraw did not put back (TerminalPane `wipeSettled`, src/shared/screenLoss.ts).
// Judged against the screen alone, a turn that kept going after the repaint - a Stop hook
// continuation - had scrolled those rows up the ordinary way, so the check called them
// lost and printed them back: pane s19 at 3:31:42pm on 2026-09-27 got a frozen
// `Drizzling… (33s …)` line, both status-line rows and the reply's tail above the reply.
//
// Three halves:
//   1. `rowsToFile` as a pure function - the composer, the rows under it and the working
//      line are never filed;
//   2. a real xterm: a /clear (rows erased in place, a banner drawn) still files the
//      history, and rows that scrolled into the scrollback since the wipe are not filed -
//      with the old screen-only rule as the control, which files them;
//   3. the measured frame: scripts/fixtures/claude-stophook-wipe.bin is s19's log from the
//      full repaint before the reply to the end of the turn (bytes 2136598..2248449), every
//      letter outside an escape sequence masked to x or X and every digit to 0, window
//      titles too (convention: cursor-up-realign-test.mjs). Replayed at s19's 143x55 through
//      the pane's Claude pipeline. The pane reads the screen for its snapshot when the
//      keeper sees the wipe - BEFORE xterm has parsed the chunk carrying it - so a pty read
//      holding the reply's frame and the wipe together snapshots the frame before the reply.
//      The old rule then files 36 rows, 35 of them already in the buffer, one of them the
//      working line; `rowsToFile` files none.
//
//   node scripts/wipe-file-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-wipe-file-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const bundle = (entry, name) => {
  const outfile = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile })
  return outfile
}
const require_ = createRequire(import.meta.url)
const { rowsToFile, WORKING, screenLost, lostRows } = require_(bundle('src/shared/screenLoss.ts', 'loss.cjs'))
const { keepScrollback, keptRows } = require_(bundle('src/shared/keepScrollback.ts', 'keep.cjs'))
const { keepPushedOffRows } = require_(bundle('src/shared/pushedOffTop.ts', 'pushed.cjs'))
const { realignCursorUp } = require_(bundle('src/shared/cursorUpRealign.ts', 'realign.cjs'))
const { Terminal } = require_('@xterm/headless')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}
/** The old rule, as TerminalPane ran it before rowsToFile: the snapshot against the screen. */
const oldRule = (before, screen) => (screenLost(before, screen) ? lostRows(before, screen) : [])

// 1. The rule.
const history = Array.from({ length: 10 }, (_, i) => `answer line ${String(i + 1).padStart(2, '0')} of the finished turn`)
const SPINNER = '✻ Drizzling… (33s · ↓ 2.3k tokens · thinking with xhigh effort)'
const RULE = '─'.repeat(60)
const COMPOSER = '❯ the text somebody is typing'
const STATUS = ['  ◆ Opus 5.5 | paneforge | main | 27% 271.3k', '  5h 23% · wk 23% · $9.45 api (97% cached)']
/** A 20-row Claude screen: history, the working line, the composer and the status rows. */
const claudeScreen = [...history, SPINNER, RULE, COMPOSER, RULE, ...STATUS, '', '', '', '']
const CARET = claudeScreen.indexOf(COMPOSER)

await check('the working line is live UI; a finished turn, a tool line and a collapsed result are history', () => {
  assert.ok(WORKING.test(SPINNER))
  assert.ok(WORKING.test('✳ Drizzling… (running Stop hooks… 0/2 · 33s · ↓ 2.9k tokens · thought for 6s)'))
  assert.ok(!WORKING.test('✻ Cooked for 53s · done 3:31 PM · 1 shell still running'))
  assert.ok(!WORKING.test('⏺ Bash(pf list 2>&1 | grep s24…)'))
  assert.ok(!WORKING.test('     … +4 lines (ctrl+o to expand)'))
})
await check('a cleared screen files the history, never the composer, its status rows or the working line', () => {
  const lost = rowsToFile(claudeScreen, CARET, Array(20).fill(''))
  assert.deepEqual(lost, history)
})
await check('a repaint that put every row back files nothing', () => {
  assert.deepEqual(rowsToFile(claudeScreen, CARET, [...claudeScreen]), [])
})
await check('rows found anywhere after the old screen top are kept, not lost', () => {
  const after = ['earlier', ...history, 'more of the reply', ...Array(19).fill('')]
  assert.deepEqual(rowsToFile(claudeScreen, CARET, after), [])
})

// 2. A real xterm.
const write = (t, s) => new Promise((r) => t.write(s, r))
const bufferLines = (t) => {
  const b = t.buffer.active
  const out = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  return out
}
const screenOf = (t) => bufferLines(t).slice(t.buffer.active.baseY)
/** A terminal showing `claudeScreen` under some earlier output, and the pane's snapshot of it. */
const snapped = async () => {
  const t = new Terminal({ cols: 80, rows: 20, scrollback: 1000, allowProposedApi: true })
  await write(t, 'earlier output\r\n'.repeat(5) + claudeScreen.join('\r\n') + `\x1b[${CARET + 1};3H`)
  const cursor = t.buffer.active.cursorY
  return { t, snap: { rows: screenOf(t), cursor, top: t.registerMarker(-cursor) } }
}
/** What `wipeSettled` hands `rowsToFile`: every line from the old screen's top to the end. */
const afterOf = (t, top) => bufferLines(t).slice(top.isDisposed ? 0 : top.line)

await check('/clear: rows erased in place and a banner drawn - the history is filed', async () => {
  const { t, snap } = await snapped()
  assert.equal(snap.cursor, CARET)
  await write(t, '\x1b[H' + '\x1b[2K\x1b[1B'.repeat(20) + '\x1b[H' + ' ▐▛███▜▌   Claude Code v2.1.283\r\n ▝▜█████▛▘  Opus 5.5\r\n\r\n' + RULE + '\r\n❯ \r\n' + RULE)
  const lost = rowsToFile(snap.rows, snap.cursor, afterOf(t, snap.top))
  assert.deepEqual(lost, history)
  t.dispose()
})
await check('a turn that kept going scrolled the rows up: nothing is filed (the old rule filed them)', async () => {
  const { t, snap } = await snapped()
  // Claude clears from its working line down and carries on: the reply scrolls up the
  // ordinary way, the working line and status rows under it have ticked on.
  const more = Array.from({ length: 25 }, (_, i) => `the reply carries on, line ${i + 1}`)
  const ticked = ['✻ Drizzling… (53s · ↓ 2.9k tokens · thought for 6s)', RULE, COMPOSER, RULE, '  ◆ Opus 5.5 | paneforge | main | 28% 280.1k', '  5h 24% · wk 23% · $9.61 api (97% cached)']
  await write(t, `\x1b[${history.length + 1};1H\x1b[J` + more.join('\r\n') + '\r\n' + ticked.join('\r\n'))
  const after = afterOf(t, snap.top)
  assert.ok(history.every((r) => after.includes(r)), 'the history is in the buffer, above the screen')
  assert.deepEqual(rowsToFile(snap.rows, snap.cursor, after), [])
  const old = oldRule(snap.rows, screenOf(t))
  assert.deepEqual(old, [...history, SPINNER, ...STATUS], 'control: the old rule files them, the working line and status rows too')
  t.dispose()
})

// 3. The measured frame.
const fixture = readFileSync(join(root, 'scripts/fixtures/claude-stophook-wipe.bin'))
/**
 * Replay the fixture a frame at a time (Claude ends each by showing the caret) through the
 * pane's Claude pipeline, and take the pane's snapshot at the wipe. `lagged`: the frame
 * before the wipe arrives in the same pty read, so the snapshot reads the screen before it.
 */
const replay = async (lagged) => {
  const t = new Terminal({ cols: 143, rows: 55, scrollback: 5000, allowProposedApi: true })
  const shown = Buffer.from('\x1b[?25h')
  const frames = []
  for (let at = 0; at < fixture.length; ) {
    const end = fixture.indexOf(shown, at + 1)
    const next = end < 0 ? fixture.length : end + shown.length
    frames.push(fixture.subarray(at, next))
    at = next
  }
  // The fixture opens with a full repaint of a blank terminal - nothing to judge. The wipe
  // under test is the next one: the repaint after the first reply.
  const wipe = Buffer.from('\x1b[H\x1b[2K\x1b[1B')
  const at = frames.findIndex((f, i) => i > 0 && f.includes(wipe))
  assert.ok(at > 1, 'the fixture holds the wipe')
  if (lagged) frames.splice(at - 1, 2, Buffer.concat([frames[at - 1], frames[at]]))
  let frame = 0
  let snap = null
  // The order TerminalPane installs them in.
  keepPushedOffRows(t, () => (snap = null))
  realignCursorUp(t)
  // A frame is ~100ms of Claude's spinner; the keeper's 10s standdown needs a clock.
  const keep = keepScrollback(() => t.rows, () => false, () => frame * 100, () => keptRows(t), () => {
    if (frame === 0 || snap) return
    const cursor = t.buffer.active.cursorY
    snap = { rows: screenOf(t), cursor, top: t.registerMarker(-cursor) }
  })
  for (; frame < frames.length; frame++) await write(t, keep(frames[frame].toString('utf8')))
  assert.ok(snap, 'the wipe was seen')
  const all = new Set(bufferLines(t).map((l) => l.trim()))
  const out = {
    old: oldRule(snap.rows, screenOf(t)),
    now: rowsToFile(snap.rows, snap.cursor, afterOf(t, snap.top)),
    inBuffer: (rows) => rows.filter((r) => all.has(r.trim())).length
  }
  t.dispose()
  return out
}
const lagged = await replay(true)
await check('the old rule files 36 rows at the end of the turn, 35 of them already in the buffer', () => {
  assert.equal(lagged.old.length, 36)
  assert.equal(lagged.inBuffer(lagged.old), 35)
})
await check('...and one of them is the frozen working line', () => {
  assert.equal(lagged.old.filter((r) => WORKING.test(r)).length, 1)
})
await check('rowsToFile files nothing', () => {
  assert.deepEqual(lagged.now, [])
})
await check('control: a snapshot read in step with the bytes files nothing under either rule', async () => {
  const exact = await replay(false)
  assert.deepEqual(exact.old, [])
  assert.deepEqual(exact.now, [])
})

console.log(`\n${passed} passed`)
