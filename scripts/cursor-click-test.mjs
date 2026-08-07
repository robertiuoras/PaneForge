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
const { keysForClick, cellAt, ARROW } = createRequire(import.meta.url)(outfile)

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

console.log(`cursor click: ${checks} checks passed`)
