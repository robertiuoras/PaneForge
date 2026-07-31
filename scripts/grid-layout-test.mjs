// The arithmetic behind dragging the line between two panes.
//
// Worth its own test because every failure mode here is silent and permanent: a track
// that reaches zero cannot be dragged back, a divider drawn at the wrong offset is a
// grab strip sitting over a pane instead of the gap, and a saved layout of the wrong
// length would apply three column widths to a two-column grid.
//
//   node scripts/grid-layout-test.mjs

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The module is TypeScript, and the only TypeScript in it is the type annotations - so
// they are stripped and it is imported as plain ESM. No build step, no bundler, and the
// test runs against the same source the app does rather than a copy that can drift.
const src = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'gridLayout.ts'), 'utf8')
const js = src
  .replace(/^export type .*$/gm, '')
  .replace(/^export interface [\s\S]*?^}$/gm, '')
  .replace(/: Fractions\[\]/g, '')
  .replace(/: (Fractions|GridSize|LayoutKind|GridPlan|Cell|number|string|boolean)(\[\])?( \| undefined)?/g, '')
  .replace(/<[A-Za-z]+(\[\])?>/g, '')
const dir = join(tmpdir(), 'paneforge-grid-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'gridLayout.mjs')
writeFileSync(mod, js, 'utf8')
const {
  drag,
  dividerPx,
  equal,
  isLayout,
  layoutDefaults,
  LAYOUTS,
  moveInOrder,
  nextLayout,
  planGrid,
  shapeKey,
  template,
  trackPx,
  usable,
  MIN_TRACK_PX
} = await import(
  'file://' + mod.replace(/\\/g, '/')
)

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}
const near = (a, b, eps = 0.001) => Math.abs(a - b) < eps
const sum = (a) => a.reduce((x, y) => x + y, 0)

// ---------------------------------------------------------------- reading what was saved

ok('a shape with no saved layout is equal shares', JSON.stringify(usable(undefined, 3)) === '[1,1,1]')
ok('a saved layout of the wrong length is ignored', JSON.stringify(usable([1, 2], 3)) === '[1,1,1]')
ok('a saved zero is ignored, not applied', JSON.stringify(usable([0, 2], 2)) === '[1,1]')
ok('a saved NaN is ignored', JSON.stringify(usable([NaN, 1], 2)) === '[1,1]')
ok('a usable layout is kept, normalised to sum to the track count', near(sum(usable([3, 1], 2)), 2))
ok('and its proportions survive that', near(usable([3, 1], 2)[0] / usable([3, 1], 2)[1], 3))
ok('the shape key names the grid, not the panes', shapeKey(3, 2) === '3x2')
ok('the template is fr units in order', template([1.5, 0.5]) === '1.5fr 0.5fr')

// ---------------------------------------------------------------- pixels

const px = trackPx(equal(3), 618, 9)
ok('equal tracks share what the gaps leave', near(sum(px) + 2 * 9, 618), sum(px))
ok('and they really are equal', near(px[0], px[1]) && near(px[1], px[2]), px.join(','))
ok('the divider sits in the middle of the gap', near(dividerPx(equal(2), 209, 9, 0), 104.5), dividerPx(equal(2), 209, 9, 0))
ok(
  'the second divider is a track and a gap further on',
  near(dividerPx(equal(3), 618, 9, 1) - dividerPx(equal(3), 618, 9, 0), 200 + 9),
  dividerPx(equal(3), 618, 9, 1) - dividerPx(equal(3), 618, 9, 0)
)

// ---------------------------------------------------------------- dragging one divider

const wide = drag(equal(2), 400, 0, 0, 50)
ok('dragging right makes the left track bigger', trackPx(wide, 400, 0)[0] > 200)
ok('by exactly what the pointer moved', near(trackPx(wide, 400, 0)[0], 250), trackPx(wide, 400, 0)[0])
ok('and the right track gives up the same', near(trackPx(wide, 400, 0)[1], 150))
ok('the pair still adds up, so nothing else on screen moves', near(sum(wide), 2))

const three = drag(equal(3), 900, 0, 0, 100)
ok('a divider in a three-column grid leaves the third column alone', near(three[2], 1), three.join(','))

// The clamp: a pane that reaches zero width cannot be grabbed to drag it back.
const shoved = drag(equal(2), 400, 0, 0, -1000)
ok('a track cannot be shoved below the minimum', near(trackPx(shoved, 400, 0)[0], MIN_TRACK_PX), trackPx(shoved, 400, 0)[0])
ok('and never past it into the other one', trackPx(shoved, 400, 0)[1] <= 400 - MIN_TRACK_PX + 0.001)
const shovedOther = drag(equal(2), 400, 0, 0, 1000)
ok('the same holds dragging the other way', near(trackPx(shovedOther, 400, 0)[1], MIN_TRACK_PX))

// A grid so small that the minimum does not fit: half each rather than a locked divider.
const tiny = drag(equal(2), 200, 0, 0, -1000)
ok('in a box too small for the minimum it stops at half', near(trackPx(tiny, 200, 0)[0], 100), trackPx(tiny, 200, 0)[0])

// Dragging from an already-uneven layout starts where the pane actually is, not at equal.
const from = usable([3, 1], 2)
const nudged = drag(from, 400, 0, 0, -50)
ok('a drag is measured from the current size', near(trackPx(nudged, 400, 0)[0], 250), trackPx(nudged, 400, 0)[0])

// ---------------------------------------------------------------- the five layouts
//
// Every one of these is a way a layout can be silently wrong rather than obviously
// broken: a cell count that does not match the panes leaves one pane invisible, two cells
// on the same square draw two terminals on top of each other, and a cell past the last
// track leaves a pane in a row the grid does not have.

const cellsFit = (plan, n) => {
  if (plan.cells.length !== n) return 'cell count ' + plan.cells.length + ' for ' + n + ' panes'
  const seen = new Set()
  for (const c of plan.cells) {
    if (c.col < 1 || c.row < 1) return 'cell outside the grid'
    if (c.col + c.colSpan - 1 > plan.cols) return 'cell past the last column'
    if (c.row + c.rowSpan - 1 > plan.rows) return 'cell past the last row'
    for (let x = c.col; x < c.col + c.colSpan; x++)
      for (let y = c.row; y < c.row + c.rowSpan; y++) {
        const k = x + ',' + y
        if (seen.has(k)) return 'two panes in cell ' + k
        seen.add(k)
      }
  }
  return ''
}

for (const kind of LAYOUTS)
  for (let n = 1; n <= 9; n++) {
    const bad = cellsFit(planGrid(kind, n), n)
    ok(`${kind} with ${n}: every pane gets its own cell inside the grid`, !bad, bad)
  }

ok('an empty desk still has a grid to draw into', planGrid('tiled', 0).cols === 1 && planGrid('tiled', 0).rows === 1)
ok('tiled is near-square', planGrid('tiled', 5).cols === 3 && planGrid('tiled', 5).rows === 2)
ok('columns is one row of panes', planGrid('columns', 4).cols === 4 && planGrid('columns', 4).rows === 1)
ok('rows is one column of panes', planGrid('rows', 4).cols === 1 && planGrid('rows', 4).rows === 4)

const left = planGrid('main-left', 4)
ok('big left is two columns and one row per other pane', left.cols === 2 && left.rows === 3)
ok('and the main pane spans every row of them', left.cells[0].rowSpan === 3, JSON.stringify(left.cells[0]))
ok(
  'while the rest are one cell each in the second column',
  left.cells.slice(1).every((c) => c.col === 2 && c.rowSpan === 1)
)

const top = planGrid('main-top', 4)
ok('big top is two rows and one column per other pane', top.cols === 3 && top.rows === 2)
ok('and the main pane spans every column of them', top.cells[0].colSpan === 3, JSON.stringify(top.cells[0]))
ok(
  'while the rest are one cell each in the second row',
  top.cells.slice(1).every((c) => c.row === 2 && c.colSpan === 1)
)

// One pane is one pane. A "big left" of one that drew two columns would be a window with
// a terminal in half of it and nothing at all in the other half.
for (const kind of LAYOUTS) {
  const one = planGrid(kind, 1)
  ok(`${kind} with a single pane is the whole window`, one.cols === 1 && one.rows === 1, `${one.cols}x${one.rows}`)
}

// ---------------------------------------------------------------- saving a layout's sizes

ok('tiled keeps the bare key it has always saved under', shapeKey(3, 2) === '3x2')
ok('and still does when it says so out loud', shapeKey(3, 2, 'tiled') === '3x2')
ok('another layout of the same shape saves separately', shapeKey(2, 3, 'main-left') === 'main-left:2x3')
ok('so the two cannot read each other', shapeKey(2, 3) !== shapeKey(2, 3, 'main-left'))

const mainCols = layoutDefaults('main-left', 2, 3).cols
ok('big left starts with a big left column', mainCols[0] > mainCols[1], mainCols.join(','))
ok('and its two columns still sum to the track count', near(sum(mainCols), 2))
ok('big top starts with a tall top row', layoutDefaults('main-top', 3, 2).rows[0] > 1)
ok('tiled starts equal', JSON.stringify(layoutDefaults('tiled', 2, 2).cols) === '[1,1]')
ok('a layout with nothing saved uses its own default, not equal shares', near(usable(undefined, 2, mainCols)[0], mainCols[0]))
ok('a saved size still beats it', near(usable([1, 1], 2, mainCols)[0], 1))
ok('and a default of the wrong length cannot leak into another shape', JSON.stringify(usable(undefined, 3, mainCols)) === '[1,1,1]')

// ---------------------------------------------------------------- the cycle key

ok(
  'the cycle visits every layout once and comes back',
  (() => {
    let k = 'tiled'
    const seen = []
    for (let i = 0; i < LAYOUTS.length; i++) {
      seen.push(k)
      k = nextLayout(k)
    }
    return k === 'tiled' && seen.length === new Set(seen).size && seen.length === LAYOUTS.length
  })()
)
ok('a layout name off disk is recognised', isLayout('main-top'))
ok('and one this build has never heard of is not', !isLayout('hexagons'))

// -------------------------------------------------- moving a pane by keyboard
//
// The keyboard move and the drag write the SAME list, so the two must agree about what
// moving means. The drag swaps; if this ever starts inserting, a key nobody was watching
// would reshuffle every pane after the one being moved.

const four = ['a', 'b', 'c', 'd']
ok('one slot on swaps with the next pane', JSON.stringify(moveInOrder(four, 'b', 1)) === '["a","c","b","d"]')
ok('one slot back swaps with the one before', JSON.stringify(moveInOrder(four, 'c', -1)) === '["a","c","b","d"]')
ok('a further move is still a swap, never an insert', JSON.stringify(moveInOrder(four, 'a', 2)) === '["c","b","a","d"]')
ok('the list it was given is never mutated', JSON.stringify(four) === '["a","b","c","d"]')
ok('off the front does nothing', moveInOrder(four, 'a', -1) === four)
ok('off the end does nothing - no wrap to the far corner', moveInOrder(four, 'd', 1) === four)
ok('a pane that is not in the list is left alone', moveInOrder(four, 'zz', 1) === four)
ok('one pane cannot be moved anywhere', moveInOrder(['only'], 'only', 1)[0] === 'only')
ok(
  'every pane is still there afterwards',
  new Set(moveInOrder(four, 'b', 1)).size === four.length
)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
