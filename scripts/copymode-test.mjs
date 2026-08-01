// What keyboard copy mode is allowed to get wrong, pinned without a window and without a
// model. Everything here is arithmetic over a buffer - `src/shared/copyMode.ts` draws
// nothing and reads nothing - which is exactly why it needs a test: a column that clamps
// to the wrong end of a short line and a selection that is one cell out on the row it
// wraps at both look completely fine in a screenshot.
//
// The one that matters is the WANTED column. Walking down through a short line and out
// the other side has to come back to the column the cursor was reaching for, and a test
// that only checks ONE hop passes while that is broken: the first j lands correctly on
// the short line either way, and the damage only shows on the second.
//
//   node scripts/copymode-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-copymode-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'copymode.bundle.cjs')
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/copyMode.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { startState, applyKey, selectionOf, scrollFor } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, `${what}\n     got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  checks++
}
const same = (actual, expected, what) => {
  assert.deepEqual(actual, expected, `${what}\n     got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  checks++
}

// --- the buffer ---------------------------------------------------------------------
// Eight lines, every one of them awkward on purpose. Row 1 is a SHORT line between two
// long ones, which is the shape the wanted column is about; row 3 is empty and row 4 is
// nothing but spaces, which are the two ways a line can have no column to land on.
//
// `lineText` hands the row back verbatim. A real pane right-trims (xterm's own
// `translateToString(true)` does), so the run-of-spaces row is a shape a trimming pane
// would never produce - it is here to prove `^` falls back to column 0 on a line with no
// non-blank character, rather than to model xterm.
const LINES = [
  'the quick brown fox jumps over the lazy dog and runs past column thirty', // 0  long
  'short', //                                                                   1  short
  'another long line that also runs comfortably past column thirty, twice', // 2  long
  '', //                                                                        3  empty
  '        ', //                                                                4  blanks
  'src/main/pipe.ts --flag=1', //                                               5  a path
  '    indented text here', //                                                  6  indented
  'the last line is long too, so G and PageDown have somewhere to land' //      7  long
]

const COLS = 80
const VIEW_ROWS = 6
const LAST_ROW = LINES.length - 1
const WANT = 30

const CTX = {
  cols: COLS,
  lastRow: LAST_ROW,
  viewRows: VIEW_ROWS,
  lineText: (row) => LINES[row] ?? ''
}
// Ctrl-D/Ctrl-U are half a screen, and `Math.max(1, ...)` is what stops a one-row pane
// having a motion that moves nowhere.
const NARROW = { ...CTX, viewRows: 1 }

const press = (s, key, ctrl = false) => applyKey(s, key, ctrl, CTX)
const move = (s, ...keys) => keys.reduce((cur, key) => press(cur, key).state, s)
const rc = (s) => [s.row, s.col]
const maxCol = (row) => Math.max(0, LINES[row].length - 1)

// --- the fixture itself -------------------------------------------------------------
// Shortening a line here would silently defeat the tests below rather than fail them:
// a "long" line under 31 characters makes every wanted-column assertion trivially true.
is(LINES.length, 8, 'fixture: eight lines, or LAST_ROW and every clamp below is wrong')
is(LINES[0].length, 71, 'fixture: row 0 must stay long enough to hold column 30')
is(LINES[1].length, 5, 'fixture: row 1 is the short line the wanted column walks over')
is(LINES[2].length, 70, 'fixture: row 2 must stay long enough to hold column 30')
is(LINES[3], '', 'fixture: row 3 is the empty line')
is(LINES[4].trim(), '', 'fixture: row 4 is nothing but spaces')
is(LINES[4].length, 8, 'fixture: row 4 is eight spaces, so its last column is 7')
is(LINES[5].slice(17), '--flag=1', 'fixture: the flag starts at column 17 of the path line')
is(LINES[5][15], 's', 'fixture: the path ends at column 15 (the s of pipe.ts)')
is(LINES[6].search(/\S/), 4, 'fixture: row 6 is indented by four spaces')
is(LINES[7].length > WANT, true, 'fixture: row 7 must hold column 30 for the walk down')

// ====================================================================================
// MOTION
// ====================================================================================

// 1. h/l move one column and clamp at both ends.
is(move(startState(0, 5), 'l').col, 6, 'l must move one column right')
is(move(startState(0, 5), 'h').col, 4, 'h must move one column left')
is(move(startState(0, 0), 'h').col, 0, 'h at column 0 must clamp, never go negative')
is(move(startState(1, 4), 'l').col, 4, 'l must not go past the last character of a short line')
is(move(startState(1, 0), 'l', 'l', 'l', 'l', 'l').col, 4, 'l repeated must stop on the last character')
is(move(startState(3, 0), 'l').col, 0, 'l on an empty line has nowhere to go')
is(move(startState(3, 0), 'h').col, 0, 'h on an empty line has nowhere to go')
same(rc(move(startState(2, 10), 'h')), [2, 9], 'h must not change the row')
same(rc(move(startState(2, 10), 'l')), [2, 11], 'l must not change the row')

// 2. j/k move one row and clamp at 0 and lastRow.
is(move(startState(0, 0), 'j').row, 1, 'j must move one row down')
is(move(startState(2, 0), 'k').row, 1, 'k must move one row up')
is(move(startState(0, 0), 'k').row, 0, 'k on the first row must clamp at 0')
is(move(startState(LAST_ROW, 0), 'j').row, LAST_ROW, 'j on the last row must clamp at lastRow')

// 3. The wanted column. One hop is not a test: the short line answers correctly either
//    way, and the bug only appears on the way back out.
const down1 = move(startState(0, WANT), 'j')
same(rc(down1), [1, 4], 'j from column 30 onto a short line must land on that line s last column')
is(down1.want, WANT, 'landing short must REMEMBER column 30, not overwrite the want with 4')
same(rc(move(down1, 'j')), [2, WANT], 'j back onto a long line must return to column 30')
const up1 = move(startState(2, WANT), 'k')
same(rc(up1), [1, 4], 'k from column 30 onto a short line must land on that line s last column')
same(rc(move(up1, 'k')), [0, WANT], 'k back onto a long line must return to column 30')

// 4. An empty line has no column to land on. Column 0 is the only answer, and it must
//    not become the wanted column - the whole walk below is one keypress at a time.
const walk = []
let cur = startState(2, WANT)
for (let i = 0; i < 5; i++) {
  cur = move(cur, 'j')
  walk.push([cur.row, cur.col, cur.want])
}
same(
  walk,
  [
    [3, 0, WANT], // empty line: column 0, and no throw
    [4, 7, WANT], // eight spaces: its last column
    [5, 24, WANT], // the path line
    [6, 21, WANT], // the indented line
    [7, WANT, WANT] // long again, and the wanted column is back
  ],
  'walking down through an empty line must restore column 30 on the other side'
)

// 5. 0, ^, $, g, G.
is(move(startState(0, WANT), '0').col, 0, '0 must go to the first column')
same(rc(move(startState(6, 20), '^')), [6, 4], '^ must go to the first non-blank of an indented line')
same(rc(move(startState(4, 5), '^')), [4, 0], '^ on a line of only spaces must fall back to column 0')
is(move(startState(3, 0), '^').col, 0, '^ on an empty line must be column 0')
is(move(startState(1, 0), '$').col, 4, '$ must go to the last character of the short line')
is(move(startState(5, 0), '$').col, 24, '$ must go to the last character of the path line')
is(move(startState(3, 0), '$').col, 0, '$ on an empty line must be column 0')
same(rc(move(startState(5, 10), 'g')), [0, 0], 'g must go to the top of the buffer')
same(rc(move(startState(0, 10), 'G')), [LAST_ROW, 0], 'G must go to the last row, column 0')

// 6. Half a screen and a whole screen. viewRows is 6, so Ctrl-D/Ctrl-U are exactly 3.
const HALF = Math.max(1, Math.floor(VIEW_ROWS / 2))
is(HALF, 3, 'the half-page step is floor(viewRows / 2)')
is(press(startState(0, 0), 'd', true).state.row, 0 + HALF, 'Ctrl-D must move half a screen down')
is(press(startState(4, 0), 'd', true).state.row, 4 + HALF, 'Ctrl-D must move half a screen down')
is(press(startState(6, 0), 'd', true).state.row, LAST_ROW, 'Ctrl-D must clamp at the last row')
is(press(startState(7, 0), 'u', true).state.row, 7 - HALF, 'Ctrl-U must move half a screen up')
is(press(startState(1, 0), 'u', true).state.row, 0, 'Ctrl-U must clamp at row 0')
is(applyKey(startState(0, 0), 'd', true, NARROW).state.row, 1, 'a one-row screen still steps one row, never zero')
is(move(startState(0, 0), 'PageDown').row, VIEW_ROWS, 'PageDown must move a whole screen down')
is(move(startState(5, 0), 'PageDown').row, LAST_ROW, 'PageDown must clamp at the last row')
is(move(startState(7, 0), 'PageUp').row, 7 - VIEW_ROWS, 'PageUp must move a whole screen up')
is(move(startState(2, 0), 'PageUp').row, 0, 'PageUp must clamp at row 0')

// 7. The arrows are the same motions, not a second implementation of them.
const arrowFrom = startState(2, WANT)
same(press(arrowFrom, 'ArrowLeft').state, press(arrowFrom, 'h').state, 'ArrowLeft must be h')
same(press(arrowFrom, 'ArrowRight').state, press(arrowFrom, 'l').state, 'ArrowRight must be l')
same(press(arrowFrom, 'ArrowDown').state, press(arrowFrom, 'j').state, 'ArrowDown must be j')
same(press(arrowFrom, 'ArrowUp').state, press(arrowFrom, 'k').state, 'ArrowUp must be k')

// 8. WORD motions - runs of non-space, vi's W/B rather than vi's w/b. The whole point is
//    that `src/main/pipe.ts` is ONE thing to reach for and eight stops to vi's small w.
same(rc(move(startState(5, 0), 'w')), [5, 17], 'w must clear the whole path and land on the - of --flag=1')
same(rc(move(startState(5, 17), 'b')), [5, 0], 'b from the flag must come back to the start of the path')
same(rc(move(startState(5, 0), 'e')), [5, 15], 'e must land on the last character of the path')
same(rc(move(startState(5, 15), 'e')), [5, 24], 'e again must land on the last character of the flag')
is(move(startState(5, 17), 'w').col, 24, 'w with no word left must clamp to the last character')
is(move(startState(5, 24), 'w').col, 24, 'w on the last character must stay there')
is(move(startState(5, 24), 'e').col, 24, 'e on the last character must stay there')
is(move(startState(5, 0), 'b').col, 0, 'b at column 0 must clamp, never go negative')
same(rc(move(startState(0, 0), 'w')), [0, 4], 'w must land on the start of the next word')
same(rc(move(startState(0, 4), 'b')), [0, 0], 'b must come back to the start of the first word')
for (const key of ['w', 'b', 'e']) {
  is(move(startState(5, 12), key).row, 5, `${key} must stay on its own line`)
  is(move(startState(3, 0), key).row, 3, `${key} on an empty line must not throw or leave the line`)
  is(move(startState(3, 0), key).col, 0, `${key} on an empty line must be column 0`)
}

// ====================================================================================
// SELECTION
// ====================================================================================

// 9. No anchor: the one-cell selection IS the cursor. There is no caret with the WebGL
//    renderer, so a length of 1 is the only thing on screen saying where you are.
same(selectionOf(startState(2, 7), CTX), { row: 2, col: 7, length: 1 }, 'with no anchor the selection must be the single cell under the cursor')

// 10. v sets the anchor, v again drops it.
const anchored = move(startState(2, 10), 'v')
same(anchored.anchor, { row: 2, col: 10 }, 'v must anchor at the cursor')
const dropped = move(anchored, 'v')
is(dropped.anchor, null, 'a second v must drop the selection')
same(rc(dropped), [2, 10], 'dropping the selection must leave the cursor where it is')

// 11. Length is in CELLS and wraps at cols, which is how xterm's own select() says it.
//     (4 - 2) * 80 + (5 - 3) + 1 = 163.
same(
  selectionOf({ row: 4, col: 5, anchor: { row: 2, col: 3 }, want: 5 }, CTX),
  { row: 2, col: 3, length: 2 * COLS + 2 + 1 },
  'a selection across two rows must be 163 cells: 2 * cols, plus the column difference, plus the cursor cell'
)
is(2 * COLS + 2 + 1, 163, 'the arithmetic above is 163 cells, spelled out')

// 12. Backwards is the same range. Start is always the earlier cell and the length is
//     positive - a negative length is a selection xterm silently draws as nothing.
same(
  selectionOf({ row: 2, col: 3, anchor: { row: 4, col: 5 }, want: 3 }, CTX),
  { row: 2, col: 3, length: 163 },
  'selecting upwards must give the same range as selecting downwards'
)
same(
  selectionOf({ row: 0, col: 4, anchor: { row: 0, col: 10 }, want: 4 }, CTX),
  { row: 0, col: 4, length: 7 },
  'selecting leftwards on one row must start at the earlier column with a positive length'
)
same(
  selectionOf({ row: 3, col: 0, anchor: { row: 3, col: 0 }, want: 0 }, CTX),
  { row: 3, col: 0, length: 1 },
  'an anchor on the cursor is one cell, never zero'
)

// 12b. A horizontal key that moves NOTHING must not move the wanted column either.
//      `l` against the end of a short line looks like a no-op on screen, and it used to
//      raise `want` past the line's end - so the next `j` landed one column further
//      right than the one before it, for a keypress that visibly did nothing.
const stuckRight = move(startState(1, maxCol(1)), 'l')
is(stuckRight.col, maxCol(1), 'l at the end of a line must not move the cursor')
is(stuckRight.want, maxCol(1), 'l at the end of a line must not move the wanted column')
is(move(startState(1, 0), 'h').want, 0, 'h at column 0 must leave the wanted column at 0')

// 13. V is whole lines, and it is a SHAPE rather than a pair of columns. This is the
//     half that cannot be expressed the way `v` is: going down, the range has to reach
//     the end of a line whose length nothing knows until the cursor is on it. The
//     first version of this module tried, and `V j` selected all of one line plus a
//     single stray character of the next - which is what a yank then put on the
//     clipboard. Measured, not argued: row 2 is 70 characters, so the honest answer is
//     80 + 70 and the wrong one was 80 + 1.
const lineWise = move(startState(1, 3), 'V')
is(lineWise.lineWise, true, 'V must turn the line-wise shape on')
is(lineWise.row, 1, 'V must not change the row')
same(
  selectionOf(lineWise, CTX),
  { row: 1, col: 0, length: 5 },
  'V must select the whole of its own line'
)
const lineWiseDown = move(lineWise, 'j')
same(
  selectionOf(lineWiseDown, CTX),
  { row: 1, col: 0, length: COLS + LINES[2].length },
  'j after V must reach the END of the line it lands on, not one cell into it'
)
is(COLS + LINES[2].length, 150, 'the arithmetic above is 150 cells, spelled out')
// Upwards is the same range read the other way round: from column 0 of the row above to
// the end of the row V started on.
const lineWiseUp = move(move(startState(2, 4), 'V'), 'k')
same(
  selectionOf(lineWiseUp, CTX),
  { row: 1, col: 0, length: COLS + LINES[2].length },
  'V then k must select both whole lines, not stop where the anchor happened to be'
)
// v after V goes back to characters, so a wrong V is one keypress from being fixed.
const backToChars = move(lineWise, 'v')
is(backToChars.lineWise, false, 'v after V must go back to a character selection')

// ====================================================================================
// ACTIONS
// ====================================================================================

// 14. What a key ASKS the pane to do. An unbound key must ask for nothing and change
//     nothing - copy mode swallows every key, so a typo cannot be allowed to move the
//     cursor as a side effect of doing nothing.
const acting = startState(2, 10)
is(press(acting, 'y').action, 'yank', 'y must yank')
is(press(acting, 'Enter').action, 'yank', 'Enter must yank')
is(press(acting, 'Escape').action, 'exit', 'Escape must leave copy mode')
is(press(acting, 'q').action, 'exit', 'q must leave copy mode')
is(press(acting, '/').action, 'find', '/ must hand over to the find bar')
is(press(acting, 'z').action, 'none', 'an unbound key must ask for nothing')
is(press(acting, 'z').state, acting, 'an unbound key must leave the state untouched')
is(press(acting, 'a', true).action, 'none', 'a ctrl chord that is not d or u must ask for nothing')
is(press(acting, 'a', true).state, acting, 'a ctrl chord that is not d or u must leave the state untouched')
same(press(acting, 'y').state, acting, 'yanking must not move the cursor')

// 15. Scrolling the cursor back on screen, and NOT scrolling when it already is - a
//     scroll on every keypress fights the user's own scrollback position.
is(scrollFor(startState(4, 0), 2, VIEW_ROWS), null, 'a cursor inside the viewport must not scroll')
is(scrollFor(startState(3, 0), 3, VIEW_ROWS), null, 'a cursor on the top row of the viewport is already on screen')
is(scrollFor(startState(8, 0), 3, VIEW_ROWS), null, 'a cursor on the bottom row of the viewport is already on screen')
is(scrollFor(startState(1, 0), 3, VIEW_ROWS), 1, 'a cursor above the viewport must scroll to the cursor row')
is(scrollFor(startState(12, 0), 3, VIEW_ROWS), 12 - VIEW_ROWS + 1, 'a cursor below the viewport must scroll to row - viewRows + 1')
is(12 - VIEW_ROWS + 1, 7, 'the arithmetic above is row 7, spelled out')

rmSync(work, { recursive: true, force: true })
console.log(`PASS copymode: ${checks} assertions`)
