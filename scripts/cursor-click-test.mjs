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
const { keysForClick, keysAlongLine, keysForDelete, cellAt, ARROW, BACKSPACE } =
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
{
  const sel = (o) => ({
    cursorRow: 10,
    cursorCol: 30,
    startRow: 10,
    startCol: 10,
    endRow: 10,
    endCol: 20,
    cols: 80,
    wrapped: false,
    ...o
  })

  eq(
    'the cursor walks back to the end of the selection, then backspaces over it',
    keysForDelete(sel({})),
    ARROW.left.repeat(10) + BACKSPACE.repeat(10)
  )
  eq(
    'a cursor already at the end sends only backspaces',
    keysForDelete(sel({ cursorCol: 20 })),
    BACKSPACE.repeat(10)
  )
  eq(
    'a cursor before the selection walks forward first',
    keysForDelete(sel({ cursorCol: 4 })),
    ARROW.right.repeat(16) + BACKSPACE.repeat(10)
  )
  eq('an empty selection sends nothing', keysForDelete(sel({ endCol: 10 })), '')
  eq('a backwards selection sends nothing', keysForDelete(sel({ endCol: 4 })), '')

  // A wrapped line is one line to the far end, `cols` characters a row, so the count
  // crosses the wrap by itself - exactly as the arrows do for a click.
  eq(
    'a selection across a wrap counts a whole row per row',
    keysForDelete(sel({ cursorRow: 11, cursorCol: 20, startRow: 10, startCol: 70, endRow: 11, endCol: 20, wrapped: true })),
    BACKSPACE.repeat(80 - 70 + 20)
  )

  // The load-bearing refusal. Rows of a DRAWN input box are separate lines carrying a
  // newline and a frame of unknown width; counting them as `cols` would send a burst of
  // backspaces into whatever is above.
  eq(
    'a selection across separate lines is refused, not guessed',
    keysForDelete(sel({ endRow: 11, endCol: 5, wrapped: false })),
    ''
  )
  eq(
    'and so is one whose cursor is on another line',
    keysForDelete(sel({ cursorRow: 9, wrapped: false })),
    ''
  )
  eq('no width, no keys', keysForDelete(sel({ cols: 0 })), '')
  eq('past the key limit sends nothing', keysForDelete(sel({ startCol: 0, endCol: 40, keyLimit: 20 })), '')
}

console.log(`cursor click: ${checks} checks passed`)
