/**
 * Where a copy affordance goes, and what it would copy - the arithmetic half, with no
 * window and no terminal.
 *
 * The two failures worth catching here are both silent ones. A chip clamped flat against
 * the bottom edge covers the composer, which is the row of a pane that must stay visible,
 * and it looks fine in a screenshot taken anywhere else. And a block whose range is off by
 * one line copies the NEXT prompt onto the end of the previous reply, which pastes
 * perfectly and is wrong.
 */
import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'pf-copychip-')), 'copyChip.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/copyChip.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { chipSpot, blockFor } = await import(pathToFileURL(out).href)

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}
const eq = (what, a, b) => {
  n++
  assert.deepEqual(a, b, `${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}

// A pane 157 columns by 50 rows at 8x18, the shape this app actually runs at.
const box = { cellW: 8, cellH: 18, width: 1256, height: 900, viewportY: 0, chipW: 76, chipH: 26 }

// --- the selection chip ----------------------------------------------------
eq('empty selection has no chip', chipSpot({ x: 4, y: 3 }, { x: 4, y: 3 }, box), null)

{
  // Ends at column 20 of row 3, so it points just past column 19 and one row down.
  const s = chipSpot({ x: 2, y: 3 }, { x: 20, y: 3 }, box)
  eq('chip sits past the last selected cell', s, { left: 20 * 8 + 6, top: 4 * 18 + 4 })
}

{
  // A selection that wrapped ends at column 0 of the next row; the cell to point at is the
  // END of the row above, not column -1 of this one.
  const s = chipSpot({ x: 2, y: 3 }, { x: 0, y: 4 }, box)
  ok('a wrapped end points at the row above', s.top === 4 * 18 + 4)
  ok('a wrapped end is not off the left edge', s.left >= 0)
}

{
  // Off the right edge: pulled in, never allowed to hang out of the pane.
  const s = chipSpot({ x: 2, y: 3 }, { x: 157, y: 3 }, box)
  ok('chip stays inside the right edge', s.left + box.chipW <= box.width)
}

{
  // The load-bearing one. A selection ending on the LAST row would put the chip below the
  // pane; clamping it flat would park it on the composer. It flips above instead.
  const last = { ...box, viewportY: 0 }
  const s = chipSpot({ x: 2, y: 49 }, { x: 30, y: 49 }, last)
  ok('a chip on the last row flips above the line', s.top < 49 * 18)
  ok('and is still inside the pane', s.top >= 0 && s.top + last.chipH <= last.height)
}

{
  // Scrolled: the row is absolute, the chip is in pane pixels.
  const s = chipSpot({ x: 2, y: 1003 }, { x: 30, y: 1003 }, { ...box, viewportY: 1000 })
  eq('a scrolled selection is placed by viewport row', s.top, 4 * 18 + 4)
}

// --- which turn a row belongs to -------------------------------------------
const prompts = [10, 40, 90]
eq('above the first prompt is not a turn', blockFor(prompts, 4, 200), null)
eq('no prompts at all is not a turn', blockFor([], 50, 200), null)
eq('the prompt row itself opens its turn', blockFor(prompts, 10, 200), { from: 10, to: 39, index: 0 })
eq('a row inside a turn', blockFor(prompts, 25, 200), { from: 10, to: 39, index: 0 })
eq('the row before the next prompt is still the old turn', blockFor(prompts, 39, 200), {
  from: 10,
  to: 39,
  index: 0
})
eq('the next prompt starts the next turn', blockFor(prompts, 40, 200), { from: 40, to: 89, index: 1 })
eq('the newest turn runs to the tail', blockFor(prompts, 120, 200), { from: 90, to: 200, index: 2 })

// Order is not promised by the caller: marks are re-anchored as the CLI repaints, and a
// disposed marker reads -1 until it is dropped.
eq('unsorted prompt rows still answer', blockFor([90, 10, 40], 25, 200), { from: 10, to: 39, index: 0 })
eq('a dead marker (-1) is ignored', blockFor([-1, 10, 40], 25, 200), { from: 10, to: 39, index: 0 })

// A prompt on the very last row: the turn is that one row, never an inverted range.
eq('a prompt on the tail row is a one-row turn', blockFor([200], 200, 200), {
  from: 200,
  to: 200,
  index: 0
})
ok(
  'a range is never inverted',
  [0, 1, 25, 39, 40, 120, 200].every((r) => {
    const b = blockFor(prompts, r, 200)
    return !b || b.to >= b.from
  })
)

console.log(`copychip: ${n} checks passed`)
