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

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
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
const { keysForClick, keysAlongLine, keysForRows, keysToPoint, offsetIn, cellAt, ARROW, BACKSPACE } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) => check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const at = (o) => ({ cursorRow: 10, cursorCol: 20, clickRow: 10, clickCol: 20, ...o })

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

console.log(`cursor click: ${checks} checks passed`)
