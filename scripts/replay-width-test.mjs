// A reopened pane's history, replayed at the width it was PAINTED at.
//
// Three halves, and the middle one is the point:
//
//   1. the arithmetic - when a staged replay is worth doing at all, the width it stages
//      at (the wider of what was recorded and what the bytes PAINT), the rows it carries,
//      and the cases where it must refuse (nothing wider than the pane already is, a
//      width too small to be a real pane, a terminal with no width yet);
//   2. the RESULT, in a real xterm, over a REAL frame off this machine's own pane log: a
//      Claude Code answer drawn in absolute column moves out to `CSI 143 G`, because the
//      pane was 159 columns wide. The control is the shipped behaviour before this - the
//      same bytes written into an 85-column terminal - and it must FAIL, or the test
//      proves nothing;
//   3. the wiring, by source: a shared decision nothing calls is a green test over a dead
//      function, and this one is invisible until somebody reopens a pane after an update.
//
//   node scripts/replay-width-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-replay-width-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'replay.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/replayWidth.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const require_ = createRequire(import.meta.url)
const { splitReplay, paintedWidth, RESTORE_MARK_TEXT } = require_(outfile)
const { Terminal } = require_('@xterm/headless')

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// ---------------------------------------------------------------- 1. the arithmetic

const MARK = `\x1b[0m\r\n\x1b[2m${RESTORE_MARK_TEXT}\x1b[0m\r\n`
const buf = `old screen${MARK}new output`

check('splits at the restore mark', splitReplay(buf, 159, 85)?.before.endsWith(RESTORE_MARK_TEXT))
check('what came after is the new pane own output', splitReplay(buf, 159, 85)?.after.endsWith('new output'))
eq('and it carries the width to write the first half at', splitReplay(buf, 159, 85)?.cols, 159)

// The refusals. Each one of these staging anyway is a pane drawn at the wrong width on
// purpose, which is the bug arriving from the other side.
eq('no recorded width: nothing to stage', splitReplay(buf, undefined, 85), null)
eq('a width that already matches: nothing to gain', splitReplay(buf, 85, 85), null)
eq('a width too small to be a real pane', splitReplay(buf, 4, 85), null)
eq('a terminal with no width yet', splitReplay(buf, 159, 0), null)
eq('empty buffer', splitReplay('', 159, 85), null)
// A buffer with no restore mark in it is ALL old: the mark is written by the restore and
// the ring buffer can drop it, so refusing here was refusing the pane most in need of it.
eq('no restore mark: everything is old', splitReplay('only new output', 159, 85)?.before, 'only new output')
eq('...and nothing is new', splitReplay('only new output', 159, 85)?.after, '')
// A log tail can carry a mark from an EARLIER restart. Everything before the newest one
// is old output either way, so the split goes at the last, never the first.
const twice = `first${MARK}second${MARK}newest`
check('two marks: the split is at the newest', splitReplay(twice, 159, 85)?.after.endsWith('newest'))
check('...and the second one is kept on the old-width side', splitReplay(twice, 159, 85)?.before.includes('second'))

// ------------------------------------------------------- 2. the result, in a real xterm

/**
 * One line of a real answer, off `history/s18-mt2y0c48.log` on this machine. Claude Code
 * draws it as absolute column moves out to column 143 because that pane was 159 columns
 * wide - not as text with spaces in it, which is why a narrower terminal cannot simply
 * wrap it.
 */
const FRAME =
  '\x1b[7ACause:\x1b[10G\x1b[1mTLS/JA3 fingerprinting, not User-Agent.\x1b[50G\x1b[22mProbed\x1b[57Gthe\x1b[61G12\x1b[64Gworst\x1b[70Gdomains\x1b[78G—\x1b[80GChrome\x1b[87GUA\x1b[90Gheader\x1b[97Gscored\x1b[104G\x1b[1m3/12\x1b[22m,\x1b[110Greal\x1b[115GChrome\x1b[122GTLS\x1b[126Ghandshake\x1b[136Gscored\x1b[143G\x1b[1m8/12\x1b[22m.'
const SENTENCE = 'Chrome UA header scored 3/12, real Chrome TLS handshake scored 8/12.'
// The frame is followed by a newline, as it is on disk and as the restore mark guarantees.
// It matters: measured here, xterm re-wraps every line ABOVE the cursor when it shrinks and
// TRUNCATES the one the cursor is sitting on - so a fixture ending mid-line would lose its
// tail to the resize and blame the replay for it.
const REPLAY = FRAME + '\r\n'

// On the BYTE, not on the look of it. A fixture that lost its escapes in an edit hands the
// terminal the letters `[143G`, which it draws - and every assertion below then passes for
// the wrong reason.
eq('the fixture really carries escape bytes', FRAME.charCodeAt(0), 27)
check('and a column move past 85, which is the whole problem', FRAME.includes('\x1b[143G'))

function render(bytes, writeCols, finalCols) {
  const t = new Terminal({ cols: writeCols, rows: 40, allowProposedApi: true, scrollback: 2000 })
  return new Promise((res) => {
    t.write(bytes, () => {
      if (finalCols !== writeCols) t.resize(finalCols, 40)
      const b = t.buffer.active
      // Logical lines, not rows. A row xterm wrapped is the SAME line, so it is taken at
      // full width and joined with no separator - putting a newline there would insert a
      // space into the middle of a word and fail the assertion for a reason that has
      // nothing to do with the replay.
      let out = ''
      for (let y = 0; y < b.length; y++) {
        const line = b.getLine(y)
        if (!line) continue
        if (b.getLine(y + 1)?.isWrapped) out += line.translateToString(false)
        else out += line.translateToString(true) + '\n'
      }
      res(out.replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim())
    })
  })
}

// The control. This is what shipped: the tail written straight into a pane fitted to the
// window it reopened in. If this ever passes, the test above is measuring nothing.
check('CONTROL - written at 85, the sentence is destroyed', !(await render(REPLAY, 85, 85)).includes(SENTENCE))
// ...and the fix: painted at the width it was painted at, then handed back to the pane's
// real shape. xterm re-wraps what is already in its buffer, so the 159-column line becomes
// two 85-column rows with every word still in order.
check('written at 159 and resized to 85, it reads back whole', (await render(REPLAY, 159, 85)).includes(SENTENCE))
// The same terminal never resized, as the upper bound on what staging can be worth.
check('and at 159 throughout, unchanged', (await render(REPLAY, 159, 159)).includes(SENTENCE))

// ------------------------------------------------------------------- 3. the wiring

const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
const types = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')

check('the pane asks splitReplay before it replays', pane.includes('splitReplay(b, replayColsRef.current, t.cols, replayRowsRef.current, t.rows)'))
check('the first replay writes through the stage', pane.includes('writeStaged(b, done, keep)'))
// Fix re-renders the same bytes; written raw at the pane's width they tear exactly the way
// the first replay used to, so the button meant to mend a pane broke a mended one.
check('...and so does Fix', pane.includes("writeStaged('\\x1bc' + bytes, () => {"))
check('nothing on the pane writes a reset snapshot raw', !pane.includes("t.write('\\x1bc' + bytes"))
check('and resizes inside the write callback, not after the call', /t\.write\(prep\(split\.before\), \(\) => \{\s*\n\s*t\.resize\(back/.test(pane))
check('a fit landing mid-replay is refused', pane.includes('if (replaying.current) return false'))
check('the prop is compared, or the pane stops updating for it', pane.includes('a.replayCols === b.replayCols'))
check('main records the width the restored bytes were painted at', sessions.includes('meta.replayCols = back.cols'))
check('and reads it off the session that wrote them', sessions.includes('sizeOf(scrollbackId)'))
check('the session carries it to the renderer', types.includes('replayCols?: number'))
// One copy of the caption, in the shared file: two would drift into a pane full of garbage
// rather than into an error.
check('the restore mark is not spelled out twice', sessions.includes('${RESTORE_MARK_TEXT}'))

// ------------------------------------------- 4. the width the BYTES were painted at

// The recorded width is written at launch and again only at a clean end, so a pane the
// app was killed out of records the launch width (120) over a log that paints past 150.
// The bytes themselves are the honest reading: `paintedWidth` is the widest column any
// absolute move in them addresses.
eq('no column move at all', paintedWidth('plain text\r\n'), 0)
eq('a CHA move', paintedWidth('a\x1b[143Gb'), 143)
eq('a CUP move is read on its COLUMN, not its row', paintedWidth('\x1b[7;156H'), 156)
eq('...and the f form of it', paintedWidth('\x1b[7;99f'), 99)
eq('the widest wins, whatever order they arrive in', paintedWidth('\x1b[156G x \x1b[10G'), 156)

const CLAUDE = readFileSync(join(root, 'scripts/fixtures/claude-wide.bin'), 'utf8')
const ANTI = readFileSync(join(root, 'scripts/fixtures/antigravity-frame.bin'), 'utf8')
eq('the claude fixture really carries escape bytes', CLAUDE.includes('\x1b['), true)
const painted = paintedWidth(CLAUDE)
check('a real Claude Code stretch paints past 150', painted >= 150, `paints to ${painted}`)

// 400 KB of it has to be single-digit milliseconds: this runs on the replay path of every
// pane that is reopened, before a byte is written.
const big = CLAUDE.repeat(Math.ceil(400_000 / CLAUDE.length))
// The BEST of five, because `npm test` runs this beside 60 other suites on a loaded
// machine and a scheduler hiccup is not a slow regex: the fastest pass is the one that
// measured the scan rather than the queue.
let ms = Infinity
for (let i = 0; i < 5; i++) {
  const t0 = performance.now()
  paintedWidth(big)
  ms = Math.min(ms, performance.now() - t0)
}
check('400 KB scanned in single-digit ms', ms < 10, `${ms.toFixed(1)}ms`)

// The recorded 120 is what shipped; the widest move in the bytes is what is true.
const staged = splitReplay(CLAUDE, 120, 90)
// ONE PAST the widest move: a pane exactly as wide as the furthest column still clamps
// the word written AT it - measured on this fixture, staging at the paint width loses
// lines a pane one column wider keeps.
check('a log that paints wider than its record stages past the PAINT width', staged?.cols === painted + 1, `staged ${staged?.cols}, paints ${painted}`)
eq('and the recorded width wins when it is the wider one', splitReplay(CLAUDE, 200, 90)?.cols, 200)

// The proof, in a real xterm, on LOGICAL LINES - re-wrapping moves rows without losing a
// character, so row diffing is not the reading. See scripts/torn-repro.mjs.
const { render: renderPane, lines: logicalLines } = await import('./torn-repro.mjs')
const lostAgainst = async (writeCols, rows, refCols, refRows) => {
  const ref = await renderPane(CLAUDE, refCols, 90, refRows)
  const got = await renderPane(CLAUDE, writeCols, 90, rows)
  const mine = new Set(got.lines)
  return ref.lines.filter((l) => l.length > 8 && !mine.has(l)).length
}
const lostAtRecorded = await lostAgainst(120, 40, painted + 1, 40)
const lostAtStaged = await lostAgainst(staged.cols, 40, painted + 1, 40)
check('CONTROL - written at the RECORDED 120 and resized to 90, lines are gone', lostAtRecorded > 0, `${lostAtRecorded} lost`)
eq('written at the staged width and resized to 90, nothing is lost', lostAtStaged, 0)

// ------------------------------------------------------ 5. rows, which antigravity needs

// Claude Code and Codex draw in absolute column moves and do not care how tall the
// terminal is. Antigravity's frame is cursor-UP arithmetic against the terminal HEIGHT,
// so the same bytes at the same width lose lines at the wrong number of rows.
const antiSplit = splitReplay(ANTI, 120, 90, 40)
eq('the recorded height is carried to the pane', antiSplit?.rows, 40)
eq('...and is undefined when nothing recorded one', splitReplay(ANTI, 120, 90)?.rows, undefined)

// The real antigravity case, as the app meets it: a log recording 83 columns, painted at
// 40 rows, reopened in a pane 120 wide and 30 tall. Nothing here is wider than the pane,
// so a staging gated on WIDTH alone refuses - and the height, which is the only thing
// wrong, never reaches the terminal.
const antiReal = splitReplay(ANTI, 83, 120, 40, 30)
eq('a pane whose HEIGHT is wrong is staged even though its width is fine', antiReal?.rows, 40)
eq('...at the pane own width, never narrower than it already is', antiReal?.cols, 120)
eq('nothing wrong at all: no stage', splitReplay(ANTI, 83, 120, 40, 40), null)
eq('...and no recorded height is no reason to stage either', splitReplay(ANTI, 83, 120, undefined, 30), null)

/** Written at one shape, handed back at the pane's: what the staged replay actually does. */
const staging = async (writeCols, writeRows, finalRows) => {
  const { Terminal: T } = require_('@xterm/headless')
  const t = new T({ cols: writeCols, rows: writeRows, allowProposedApi: true, scrollback: 20000 })
  await new Promise((res) => t.write(ANTI, res))
  t.resize(writeCols, finalRows)
  const b = t.buffer.active
  const rows = [], wrapped = []
  for (let y = 0; y < b.length; y++) {
    rows.push(b.getLine(y)?.translateToString(true) ?? '')
    wrapped.push(Boolean(b.getLine(y)?.isWrapped))
  }
  return new Set(logicalLines(rows, wrapped))
}
const antiLost = async (rows) => {
  const ref = await renderPane(ANTI, 120, 120, 40)
  const got = await renderPane(ANTI, 120, 120, rows)
  const mine = new Set(got.lines)
  return ref.lines.filter((l) => l.length > 8 && !mine.has(l)).length
}
const wrongRows = await antiLost(30)
const rightRows = await antiLost(antiSplit.rows)
check('CONTROL - a real antigravity frame written at the wrong height loses lines', wrongRows > 0, `${wrongRows} lost at 30 rows`)
eq('written at the height it was painted at, nothing is lost', rightRows, 0)
check('logical lines is the reading, not rows', typeof logicalLines === 'function')

const antiRef = (await renderPane(ANTI, 120, 120, 40)).lines.filter((l) => l.length > 8)
const staged30 = await staging(antiReal.cols, antiReal.rows, 30)
const straight30 = await staging(120, 30, 30)
const lostStraight = antiRef.filter((l) => !straight30.has(l)).length
const lostStaged = antiRef.filter((l) => !staged30.has(l)).length
check('CONTROL - written straight into a 30-row pane, lines are gone', lostStraight > 0, `${lostStraight} lost`)
// Written at 40 rows and handed back to 30 it holds every line the 30-row write loses to
// the frame arithmetic, and then some: measured on this fixture 12 lost straight, 8 after
// staging, 0 when the pane is never shrunk at all. The remainder is xterm's own row
// shrink, which DISCARDS the rows below the cursor - a stage cannot give those back, and
// the pane really is 30 rows tall.
check('staging the height recovers lines a straight write loses', lostStaged < lostStraight, `${lostStaged} lost staged vs ${lostStraight} straight`)
const unshrunk = await staging(120, 40, 40)
eq('...and at the height it was painted at, with no shrink, nothing is lost', antiRef.filter((l) => !unshrunk.has(l)).length, 0)

// ------------------------------------------------------------- 6. the wiring, part two

const history = readFileSync(join(root, 'src/main/history.ts'), 'utf8')
check('main widens the staged replay off the bytes themselves', sessions.includes('paintedWidth('))
check('the height travels with it', sessions.includes('meta.replayRows'))
check('history keeps the pane rows too', /export function noteCols\(id: string, cols: number, rows\?: number\)/.test(history))
check('...and answers both', /export function sizeOf\(id: string\)/.test(history))
check('the size is written on a debounced, unref-d timer, never on the resize itself', /SIZE_FLUSH_MS[\s\S]{0,400}unref\?\.\(\)/.test(history))
check('nothing sync on that path', !/writeFileSync\(metaFile\(id\), JSON\.stringify\(entry\), 'utf8'\)[\s\S]{0,80}sizeDirty/.test(history))
check('the pane resizes its rows from the split', pane.includes('split.rows ?? t.rows'))
check('...and tells splitReplay how tall it is now', pane.includes('splitReplay(b, replayColsRef.current, t.cols, replayRowsRef.current, t.rows)'))
check('the stage resizes inside the write callback', /t\.write\(prep\(split\.before\), \(\) => \{\s*\n\s*t\.resize\(back, backRows\)/.test(pane))
check('the rows prop is compared, or the pane stops updating for it', pane.includes('a.replayRows === b.replayRows'))
check('the session carries the height to the renderer', types.includes('replayRows?: number'))

console.log(`replay-width: ${checks} checks passed`)
