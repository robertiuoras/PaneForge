// A reopened pane's history, replayed at the width it was PAINTED at.
//
// Three halves, and the middle one is the point:
//
//   1. the arithmetic - when a staged replay is worth doing at all, and the four cases
//      where it must refuse (no recorded width, a width that already matches, a width too
//      small to be a real pane, and a buffer carrying no restore mark);
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
const { splitReplay, RESTORE_MARK_TEXT } = require_(outfile)
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
// The load-bearing refusal: a pane that has printed past its own restore mark holds
// nothing old at all, and staging then paints THIS pane's output at the old width.
eq('no restore mark left in the buffer', splitReplay('only new output', 159, 85), null)
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

check('the pane asks splitReplay before it replays', pane.includes('splitReplay(b, replayColsRef.current, t.cols)'))
check('and resizes inside the write callback, not after the call', /t\.write\(keep\(split\.before\), \(\) => \{\s*\n\s*t\.resize\(back/.test(pane))
check('a fit landing mid-replay is refused', pane.includes('if (replaying.current) return false'))
check('the prop is compared, or the pane stops updating for it', pane.includes('a.replayCols === b.replayCols'))
check('main records the width the restored bytes were painted at', sessions.includes('meta.replayCols = back.cols'))
check('and reads it off the session that wrote them', sessions.includes('colsOf(scrollbackId)'))
check('the session carries it to the renderer', types.includes('replayCols?: number'))
// One copy of the caption, in the shared file: two would drift into a pane full of garbage
// rather than into an error.
check('the restore mark is not spelled out twice', sessions.includes('${RESTORE_MARK_TEXT}'))

console.log(`replay-width: ${checks} checks passed`)
