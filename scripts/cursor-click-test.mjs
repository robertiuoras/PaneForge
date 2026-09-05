// Alt-clicking where you want the cursor, in a terminal that has no caret to click.
//
// The whole feature is a subtraction and a repeat, and that is exactly why it is worth
// pinning: the answer is written straight into somebody's pty as keystrokes. Two wrong
// answers are dangerous rather than merely wrong - arrows sent to a plain shell recall
// commands instead of moving, and a click in the scrollback is thirty rows away - so
// the refusals below are the load-bearing half of this file, not the happy path.
//
// No window, no terminal, no pty: it is arithmetic.
//
//   node scripts/cursor-click-test.mjs

import { buildSync, transformSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-cursor-click-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'cursor.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/cursorMove.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const {
  keysForClick,
  keysAlongLine,
  keysForRows,
  keysToPoint,
  offsetIn,
  offsetsForCells,
  cellAt,
  ARROW,
  BACKSPACE
} =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) => check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
const write = (t, data) => new Promise((resolve) => t.write(data, resolve))
async function actualRow(text) {
  const t = new Terminal({ cols: 24, rows: 4, scrollback: 10, allowProposedApi: true })
  await write(t, text)
  const b = t.buffer.active
  const line = b.getLine(b.baseY + b.cursorY)
  const end = b.cursorX
  const offsets = offsetsForCells(0, end, (col) => line?.getCell(col))
  if (!offsets) throw new Error(`could not map ${JSON.stringify(text)}`)
  return { t, row: { start: 0, end, full: true, offsets } }
}

const at = (o) => ({ cursorRow: 10, cursorCol: 20, clickRow: 10, clickCol: 20, ...o })

// --- terminal cell width is not JavaScript string length --------------------------------
// These rows come from xterm's real buffer, including its width-zero continuation cells.
// The editor receives one arrow/backspace per leading cell, never per UTF-16 code unit.
{
  const emoji = await actualRow('A😀B')
  try {
    eq('xterm maps A emoji B to three editor positions', offsetIn([emoji.row], 0, emoji.row.end), 3)
    const keys = keysForRows({
      rows: [emoji.row],
      cursor: { row: 0, col: emoji.row.end },
      start: { row: 0, col: 1 },
      end: { row: 0, col: 2 }
    })
    eq('selecting only the emoji walks one logical place and backspaces once', keys, ARROW.left + BACKSPACE)
    const graphemes = ['A', '😀', 'B']
    let cursor = graphemes.length
    cursor -= (keys.match(/\x1b\[D/g) ?? []).length
    graphemes.splice(cursor - (keys.match(/\x7f/g) ?? []).length, (keys.match(/\x7f/g) ?? []).length)
    eq('emoji deletion preserves the unselected prefix and suffix', graphemes.join(''), 'AB')
  } finally {
    emoji.t.dispose()
  }

  const cjk = await actualRow('A你B')
  try {
    eq('xterm maps A CJK B to three editor positions', offsetIn([cjk.row], 0, cjk.row.end), 3)
    eq('the inside of a wide CJK glyph is refused as an ambiguous caret boundary', offsetIn([cjk.row], 0, 2), -1)
    eq('clicking before CJK maps to its logical caret', keysToPoint([cjk.row], { row: 0, col: cjk.row.end }, { row: 0, col: 1 }), ARROW.left.repeat(2))
    eq('clicking after CJK maps to its logical caret', keysToPoint([cjk.row], { row: 0, col: cjk.row.end }, { row: 0, col: 3 }), ARROW.left)
  } finally {
    cjk.t.dispose()
  }

  const combining = await actualRow('Ae\u0301B')
  try {
    eq('a combining glyph occupies one logical editor position', offsetIn([combining.row], 0, combining.row.end), 3)
    eq(
      'selecting a combining glyph sends one backspace',
      keysForRows({
        rows: [combining.row],
        cursor: { row: 0, col: combining.row.end },
        start: { row: 0, col: 1 },
        end: { row: 0, col: 2 }
      }),
      ARROW.left + BACKSPACE
    )
  } finally {
    combining.t.dispose()
  }
}

// --- the ordinary case: one line, move along it -----------------------------------
eq('a click 5 columns right is 5 rights', keysForClick(at({ clickCol: 25 })), ARROW.right.repeat(5))
eq('a click 7 columns left is 7 lefts', keysForClick(at({ clickCol: 13 })), ARROW.left.repeat(7))
eq('the cell the cursor is already on sends nothing', keysForClick(at({})), '')
eq('column 0 from column 20 is 20 lefts', keysForClick(at({ clickCol: 0 })), ARROW.left.repeat(20))

// --- vertical, and the order it happens in ----------------------------------------
// Rows first. Moving along the row before arriving on it walks off the end of whichever
// line happens to be shorter, and the column is lost.
{
  const keys = keysForClick(at({ clickRow: 12, clickCol: 24 }))
  eq('two rows down and four right', keys, ARROW.down.repeat(2) + ARROW.right.repeat(4))
  check(
    'the vertical moves come first',
    keys.indexOf(ARROW.down) < keys.indexOf(ARROW.right),
    keys.replace(/\x1b/g, 'ESC')
  )
}
eq(
  'three rows up and two left',
  keysForClick(at({ clickRow: 7, clickCol: 18 })),
  ARROW.up.repeat(3) + ARROW.left.repeat(2)
)
eq('straight down, same column', keysForClick(at({ clickRow: 11 })), ARROW.down)

// --- the refusals -----------------------------------------------------------------
// A click well above the prompt is a click in the scrollback. In a plain shell every
// up-arrow there is the previous command, so the only safe answer is to do nothing.
eq('a click 7 rows away is refused', keysForClick(at({ clickRow: 3, clickCol: 20 })), '')
eq('a click 30 rows away is refused', keysForClick(at({ clickRow: 40, clickCol: 20 })), '')
eq('a click exactly at the row limit is allowed', keysForClick(at({ clickRow: 16 })), ARROW.down.repeat(6))
eq(
  'a tighter row limit refuses what the default allows',
  keysForClick(at({ clickRow: 13, rowLimit: 2 })),
  ''
)
// The backstop. A 500-column terminal can put a legal click 499 cells away; nothing that
// far is worth 499 keystrokes into a CLI that may read an arrow as a menu step.
eq(
  'a move past the key limit is refused whole, not truncated',
  keysForClick(at({ cursorCol: 0, clickCol: 500, keyLimit: 400 })),
  ''
)
eq(
  'a move just under the key limit still goes',
  keysForClick(at({ cursorCol: 0, clickCol: 399, keyLimit: 400 })).length,
  ARROW.right.repeat(399).length
)
check(
  'the limits count rows and columns together',
  keysForClick(at({ cursorCol: 0, clickRow: 13, clickCol: 9, keyLimit: 11 })) === '' &&
    keysForClick(at({ cursorCol: 0, clickRow: 13, clickCol: 9, keyLimit: 12 })) !== '',
  'a 3-row 9-column move is 12 keys'
)

// --- which cell was clicked -------------------------------------------------------
// A 800x400 box of 80 columns and 20 rows: 10px per column, 20px per row.
const box = { left: 100, top: 50, width: 800, height: 400 }
{
  const c = cellAt(100, 50, box, 80, 20)
  check('the top-left pixel is cell 0,0', c.col === 0 && c.row === 0, JSON.stringify(c))
}
{
  const c = cellAt(105, 59, box, 80, 20)
  check('a pixel inside the first cell is still 0,0', c.col === 0 && c.row === 0, JSON.stringify(c))
}
{
  const c = cellAt(100 + 25 * 10 + 3, 50 + 7 * 20 + 3, box, 80, 20)
  check('a pixel in column 25, row 7', c.col === 25 && c.row === 7, JSON.stringify(c))
}
{
  // Clicking the padding to the right of the last column, or below the last row, must
  // land ON the terminal rather than one past it - an out-of-range column would be a
  // move of a whole extra cell in the wrong direction.
  const c = cellAt(100 + 900, 50 + 500, box, 80, 20)
  check('a click past the bottom-right clamps to the last cell', c.col === 79 && c.row === 19, JSON.stringify(c))
  const d = cellAt(-40, -40, box, 80, 20)
  check('a click above and left of the box clamps to 0,0', d.col === 0 && d.row === 0, JSON.stringify(d))
}

// --- the two coordinate systems ---------------------------------------------------
// xterm counts the cursor from the top of the whole buffer (baseY + cursorY) and a click
// from the top of what is on screen (viewportY + row). Mixing them up is silent: it only
// shows once the pane has scrolled, which is always, and by then it is dozens of rows of
// arrow keys. This is the sum the pane does, written out.
{
  const baseY = 1200
  const cursorY = 18
  const viewportY = 1200
  const clickedRow = 16
  eq(
    'scrolled to the tail, a click two rows above the cursor is two ups',
    keysForClick({
      cursorRow: baseY + cursorY,
      cursorCol: 4,
      clickRow: viewportY + clickedRow,
      clickCol: 4
    }),
    ARROW.up.repeat(2)
  )
  // Scrolled back 300 lines, the same on-screen row is 300 rows away in the buffer, and
  // must be refused rather than sent as 300 up-arrows.
  eq(
    'scrolled up, the same on-screen click is out of range',
    keysForClick({
      cursorRow: baseY + cursorY,
      cursorCol: 4,
      clickRow: viewportY - 300 + clickedRow,
      clickCol: 4
    }),
    ''
  )
}

// --- a BARE click: along the line, and never off it --------------------------------
// This is the one a person gets without knowing anything, so its refusals matter more
// than the modifier's. The single rule it has to keep, at every input: not one up-arrow
// and not one down-arrow, ever, whatever the numbers are - an up-arrow in a plain shell
// recalls the last command, and a bare click may not be able to reach that.
{
  const line = (o) => ({ cursorCol: 20, clickCol: 20, rows: 0, cols: 80, ...o })
  eq('same row, 5 right', keysAlongLine(line({ clickCol: 25 })), ARROW.right.repeat(5))
  eq('same row, 7 left', keysAlongLine(line({ clickCol: 13 })), ARROW.left.repeat(7))
  eq('the cell the cursor is on sends nothing', keysAlongLine(line({})), '')

  // A prompt long enough to wrap is ONE line to the editor, so a row up is a whole
  // terminal width of characters back and the arrows cross the wrap by themselves.
  eq(
    'a row up on a wrapped line is one width of lefts',
    keysAlongLine(line({ rows: -1, clickCol: 20 })),
    ARROW.left.repeat(80)
  )
  eq(
    'a row up and 6 columns right is 74 lefts',
    keysAlongLine(line({ rows: -1, clickCol: 26 })),
    ARROW.left.repeat(74)
  )
  eq(
    'two rows down and 3 left is 157 rights',
    keysAlongLine(line({ rows: 2, clickCol: 17 })),
    ARROW.right.repeat(157)
  )

  // The load-bearing assertion. Every shape, including ones the caller should never
  // produce, and none of them may contain a vertical arrow.
  for (const rows of [-6, -3, -1, 0, 1, 3, 6]) {
    for (const clickCol of [0, 1, 19, 20, 21, 79]) {
      const keys = keysAlongLine(line({ rows, clickCol }))
      check(
        `no up or down for rows=${rows} col=${clickCol}`,
        !keys.includes(ARROW.up) && !keys.includes(ARROW.down),
        JSON.stringify(keys)
      )
    }
  }

  // The same backstop the modifier has: nothing legitimate needs hundreds of keys.
  eq('past the key limit sends nothing', keysAlongLine(line({ rows: 9, cols: 80 })), '')
  eq('a keyLimit of its own is obeyed', keysAlongLine(line({ clickCol: 30, keyLimit: 5 })), '')
  // A terminal with no width is a pane mid-resize, and `rows * 0` would silently turn a
  // click three rows up into a horizontal move along the wrong line.
  eq('no width, no keys', keysAlongLine(line({ rows: -1, cols: 0 })), '')
}


// --- deleting what is highlighted -------------------------------------------------
//
// The half a terminal normally cannot do at all: a selection lives in this window and the
// far end has never heard of it. So it is walked to and backspaced over, and the risk is
// entirely in the count - one too many eats a character nobody selected, and a guess
// across a line boundary eats the line above.
//
// The input is described as ROWS rather than as a rectangle of `cols`, because the shape
// that actually needed deleting is not a rectangle: Claude Code's composer indents every
// row after the first, ends each one where the text ends, and is neither framed nor
// xterm-wrapped. `full` is the one bit that decides a character - see `InputRow`.
{
  /** A shell's wrapped line: nothing indented, every row out to the width. */
  const wrapped = (n) => Array.from({ length: n }, () => ({ start: 0, end: 80, full: true }))
  const del = (o) =>
    keysForRows({
      rows: wrapped(2),
      cursor: { row: 0, col: 30 },
      start: { row: 0, col: 10 },
      end: { row: 0, col: 20 },
      ...o
    })

  eq(
    'the cursor walks back to the end of the selection, then backspaces over it',
    del({}),
    ARROW.left.repeat(10) + BACKSPACE.repeat(10)
  )
  eq('a cursor already at the end sends only backspaces', del({ cursor: { row: 0, col: 20 } }), BACKSPACE.repeat(10))
  eq(
    'a cursor before the selection walks forward first',
    del({ cursor: { row: 0, col: 4 } }),
    ARROW.right.repeat(16) + BACKSPACE.repeat(10)
  )
  eq('an empty selection sends nothing', del({ end: { row: 0, col: 10 } }), '')
  eq('a backwards selection sends nothing', del({ end: { row: 0, col: 4 } }), '')

  // A wrapped line is one line to the far end, a row's width per row, so the count
  // crosses the wrap by itself - exactly as the arrows do for a click.
  eq(
    'a selection across a wrap counts a whole row per row',
    del({ cursor: { row: 1, col: 20 }, start: { row: 0, col: 70 }, end: { row: 1, col: 20 } }),
    BACKSPACE.repeat(80 - 70 + 20)
  )

  // The load-bearing refusal: a position that is not in the input at all. The pane reads
  // '' as "refused" and SWALLOWS the key rather than handing a bare Backspace to the pty,
  // which would delete one character out of a highlighted block.
  eq('a row that is not part of the input sends nothing', del({ end: { row: 2, col: 5 } }), '')
  eq('and neither does a cursor outside it', del({ cursor: { row: -1, col: 5 } }), '')
  eq('no rows, no keys', del({ rows: [] }), '')
  eq('past the key limit sends nothing', del({ start: { row: 0, col: 0 }, end: { row: 0, col: 40 }, keyLimit: 20 }), '')

  // "Highlight it and press delete and it doesn't delete fully."
  //
  // A delete used to share the ARROW backstop of 400, so a selection any longer than that
  // produced '' - which the pane read as "not eligible" and handed the key to the pty, and
  // a bare Backspace at a pty removes exactly one character. A Mod+A over a paragraph is
  // past 400 immediately, so the select-all the feature exists for was the case that could
  // not work. These are the same selection either side of the old ceiling.
  const long = (chars) => {
    const rows = wrapped(Math.floor(chars / 80) + 1)
    const last = { row: Math.floor(chars / 80), col: chars % 80 }
    return keysForRows({ rows, cursor: last, start: { row: 0, col: 0 }, end: last })
  }
  eq('a 399-character selection worked before and still does', long(399), BACKSPACE.repeat(399))
  eq('a 401-character selection is deleted whole, not dropped on the old arrow limit', long(401), BACKSPACE.repeat(401))
  eq('and a full 200x50 screenful still answers', long(9600), BACKSPACE.repeat(9600))
  // The backstop is raised, not removed: past a screenful something is wrong with the
  // caller, and a burst that size is not a keystroke anybody typed.
  eq('past a screenful it still refuses', long(10001), '')
}

// --- a composer the CLI draws itself ----------------------------------------------
//
// Every number below was measured against a live Claude Code pane at 157 columns, and
// they are the reason this is rows-and-offsets rather than rows-times-cols: what is on
// the screen is NOT what the CLI is holding. See `InputRow`.
{
  // A 244-character prompt, broken at a space: 151 drawn on the first row and 91 on the
  // second, so one character - the space the wrap ate - is on screen nowhere.
  const spaceWrap = [
    { start: 2, end: 153, full: false },
    { start: 2, end: 94, full: true }
  ]
  const whole = { rows: spaceWrap, cursor: { row: 1, col: 94 }, start: { row: 0, col: 2 }, end: { row: 1, col: 94 } }
  eq(
    'a prompt wrapped at a space is 244 backspaces, not the 242 that are drawn',
    keysForRows(whole),
    BACKSPACE.repeat(244)
  )
  eq('the offset past the wrap counts the eaten space', offsetIn(spaceWrap, 1, 2), 152)

  // 300 unbroken characters: the wrapper SPLIT the word, so nothing was eaten and the
  // screen count is the true count. Getting this one wrong deletes a character nobody
  // highlighted, which is why a row within a column of the width counts as full.
  const split = [
    { start: 2, end: 155, full: true },
    { start: 2, end: 149, full: true }
  ]
  eq(
    'a word too long for the line was split, and costs nothing to cross',
    keysForRows({ rows: split, cursor: { row: 1, col: 149 }, start: { row: 0, col: 2 }, end: { row: 1, col: 149 } }),
    BACKSPACE.repeat(300)
  )

  // Half a prompt, selected from the middle of the first row to the middle of the second.
  eq(
    'a selection across the boundary walks back and deletes exactly its own length',
    keysForRows({ rows: spaceWrap, cursor: { row: 1, col: 94 }, start: { row: 0, col: 100 }, end: { row: 1, col: 40 } }),
    ARROW.left.repeat(54) + BACKSPACE.repeat(92)
  )

  // A click, which is the same arithmetic without the backspaces - and never an up arrow,
  // whatever rows it crosses: measured, 92 lefts walk the width of the second row and the
  // 93rd steps onto the end of the first.
  const longDraft = Array.from({ length: 20 }, () => ({ start: 2, end: 50, full: true }))
  eq('unverified long input still refuses more than 400 arrows',
    keysToPoint(longDraft, { row: 19, col: 50 }, { row: 0, col: 2 }), '')
  eq('confirmed Codex draft can cross 400 characters within one screen',
    keysToPoint(longDraft, { row: 19, col: 50 }, { row: 0, col: 2 }, Math.min(50 * 24, 10_000)),
    ARROW.left.repeat(960))
  const hugeDraft = Array.from({ length: 220 }, () => ({ start: 2, end: 50, full: true }))
  eq('a huge confirmed draft still refuses an excessive arrow burst',
    keysToPoint(hugeDraft, { row: 219, col: 50 }, { row: 0, col: 2 }, Math.min(50 * 240, 10_000)), '')
  eq(
    'a click at the start of the second row is 92 lefts',
    keysToPoint(spaceWrap, { row: 1, col: 94 }, { row: 1, col: 2 }),
    ARROW.left.repeat(92)
  )
  eq(
    'and one more crosses onto the row above',
    keysToPoint(spaceWrap, { row: 1, col: 2 }, { row: 0, col: 153 }),
    ARROW.left
  )
  eq(
    'a click past what is written on a row stops at the last character',
    keysToPoint(spaceWrap, { row: 1, col: 2 }, { row: 1, col: 150 }),
    ARROW.right.repeat(92)
  )
  eq('a click on the indent of a row lands at its first character', keysToPoint(spaceWrap, { row: 1, col: 10 }, { row: 1, col: 0 }), ARROW.left.repeat(8))
}

// The character the count is allowed to lose, and the check that gets it back.
//
// `InputRow.full` is a judgement, and a deliberately biased one: a row that stops one
// column short of the composer's edge is called full, so the space its wrap ate is
// counted as nothing. That is one character of a highlight surviving - at the START,
// because the walk goes to the END of the selection and backspaces from there. Robert's
// report was exactly that: "it misses the first character that's highlighted".
{
  // Two rows of a 157-column composer. The first stops at 156 - one short of the edge -
  // so it is called full, and the space the wrap ate is not counted.
  const shortOfEdge = [
    { start: 2, end: 156, full: true },
    { start: 2, end: 40, full: false }
  ]
  // 154 on the first row, 38 on the second: 192 counted. The CLI holds 193.
  eq(
    'a row that broke one column short of the edge is counted one character short',
    keysForRows({ rows: shortOfEdge, cursor: { row: 1, col: 40 }, start: { row: 0, col: 2 }, end: { row: 1, col: 40 } }),
    BACKSPACE.repeat(192)
  )
  // What the composer is left holding, measured the same way, is one more than wanted.
  // One per boundary crossed, plus one, is the most a count can honestly lose. More than
  // that is somebody typing, and a backspace into that is a character nobody highlighted.
}

console.log(`cursor click: ${checks} checks passed`)

// Execute the renderer's adapter, not only the arithmetic with hand-built offsets.
{
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
  const source = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
  const begin = source.indexOf('    const textColumn = ')
  const end = source.indexOf('    /**\n     * What is being typed, row by row', begin)
  assert.ok(begin > 0 && end > begin)
  const code = transformSync(source.slice(begin,end), {loader:'ts'}).code
  for (const value of ['A你BCDE', 'AéBCDEF', 'A😀BCDE']) {
    const term = new Terminal({cols:6, rows:5, allowProposedApi:true})
    await new Promise(resolve=>term.write(value,resolve))
    const inputRow = new Function('t','offsetsForCells',code+';return inputRow')(term,offsetsForCells)
    const first = inputRow(0,0,null,true)
    assert.ok(first, `wrapped full row remains editable: ${value}`)
    assert.equal(first.end,6)
    term.dispose()
  }
  const term = new Terminal({cols:6, rows:5, allowProposedApi:true})
  await new Promise(resolve=>term.write('A你',resolve))
  const inputRow = new Function('t','offsetsForCells',code+';return inputRow')(term,offsetsForCells)
  const row = inputRow(0,0,2,false)
  assert.ok(row,'CJK textual endpoint maps past continuation cell')
  assert.equal(row.end,3)
  assert.equal(row.offsets.at(-1),2)
  term.dispose()
  console.log('renderer Unicode adapter: 4 real xterm cases passed')
}

// A word-wrap can hide a space at the same edge as an unbroken word. Exercise
// the actual renderer handler, including cancellation while its reply is pending.
{
  const source = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
  const begin = source.indexOf('const moveAlongLine =')
  const end = source.indexOf('const forceSelectable =', begin)
  const code = transformSync(source.slice(begin, end), { loader: 'ts' }).code
  const revisionOnSleep = source.match(/if \(asleepRef\.current !== asleep\) keyRevision\.current\+\+/)?.[0]
  assert.ok(revisionOnSleep, 'sleep transitions invalidate pending cursor corrections')
  const sleepRef = { current: false }, revisionRef = { current: 0 }
  const renderSleep = new Function('asleepRef', 'keyRevision', 'asleep', revisionOnSleep + ';asleepRef.current=asleep')
  renderSleep(sleepRef, revisionRef, true)
  renderSleep(sleepRef, revisionRef, false)
  assert.equal(revisionRef.current, 2, 'sleep then wake invalidates even when awake at callback')
  function fixture(selection = '') {
    const rows = [{ start: 2, end: 49, full: true }, { start: 2, end: 20, full: false }]
    const b = { type: 'normal', baseY: 0, viewportY: 0, cursorX: 20, cursorY: 1 }
    const writes = [], timers = []
    const revision = { current: 0 }, typed = { current: 0 }, asking = { current: false }
    const cached = { current: selection }, asleep = { current: false }
    const texts = ['› ' + 'x'.repeat(47), '  second row of text']
    const t = { cols: 50, rows: 20, buffer: { active: b }, getSelection: () => selection,
      clearSelection: () => { selection = '' } }
    const deps = { downAt: { x: 4, y: 0 }, clickCursorRef: { current: true }, askRef: asking,
      t, el: { querySelector: () => ({ getBoundingClientRect: () => ({ width: 50, height: 20 }) }) },
      cellAt: () => ({ col: 4, row: 0 }), inputRows: () => ({ top: 0, rows }),
      spanBottom: s => s.top + s.rows.length - 1, keysToPoint, agent: 'codex',
      stopForAgent() {}, sendKeys: k => { revision.current++; writes.push(k) },
      rowText: r => texts[r], keyRevision: revision, typedAt: typed,
      dead: false, asleepRef: asleep, lastSelection: cached, copied: { current: selection },
      setTimeout: f => timers.push(f), sameLine: () => false }
    const handler = new Function(...Object.keys(deps), code + ';return {callback:moveAlongLine,die(){dead=true}}')(...Object.values(deps))
    handler.callback({ clientX: 4, clientY: 0, preventDefault() {} })
    return { b, writes, timers, revision, typed, texts, asking, cached, asleep, die: handler.die, selection: () => selection }
  }
  const f = fixture('x')
  assert.ok(f.writes.length === 1 && !f.selection(), 'stationary composer click releases an old selection')
  assert.equal(f.cached.current, '', 'clearing selection also clears the copy fallback')
  assert.equal(f.timers.length, 2, 'cross-row click schedules two bounded observations')
  f.b.cursorY = 0; f.b.cursorX = 5
  f.timers[0]()
  assert.equal(f.writes[1], ARROW.left, 'actual cursor corrects one hidden wrap space')
  for (const change of [f => f.revision.current++, f => f.typed.current = Date.now() + 1,
    f => f.texts[0] += 'new draft', f => f.asking.current = true,
    f => f.die(), f => f.asleep.current = true]) {
    const f = fixture(); f.b.cursorY = 0; f.b.cursorX = 5; change(f); f.timers[0]()
    assert.equal(f.writes.length, 1, 'new input, click or question cancels the old check')
  }
  const pending = fixture(); pending.timers[0]()
  assert.equal(pending.writes.length, 1, 'no duplicate arrows before the CLI has moved')
  pending.b.cursorY = 0; pending.b.cursorX = 5; pending.timers[1]()
  assert.equal(pending.writes[1], ARROW.left, 'a slow renderer gets a second observation')
  console.log('renderer click placement: selection, wrap correction and cancellation passed')
}
