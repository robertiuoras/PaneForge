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
  .replace(/: (Fractions|GridSize|number|string|boolean)(\[\])?( \| undefined)?/g, '')
  .replace(/<[A-Za-z]+(\[\])?>/g, '')
const dir = join(tmpdir(), 'paneforge-grid-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'gridLayout.mjs')
writeFileSync(mod, js, 'utf8')
const { drag, dividerPx, equal, shapeKey, template, trackPx, usable, MIN_TRACK_PX } = await import(
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

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
