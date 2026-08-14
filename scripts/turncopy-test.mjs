/**
 * Where a turn's copy icons go - the arithmetic, with no window.
 *
 * The failure this exists for is not a wrong pixel, it is a button you cannot press. The
 * version before this one followed the pointer: the pair was drawn at the top of whatever
 * turn the mouse was over, so moving towards it crossed into the turn above and the pair
 * jumped away ("cant even copy prompt because once you move mouse over hover it
 * disappears"). Nothing here takes a pointer at all, which is the fix - so what is left to
 * get wrong is crowding (two pairs on top of each other, both mis-pressable) and the reply
 * range being off by one, which pastes perfectly and is the wrong text.
 */
import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'pf-turncopy-')), 'turnCopy.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/turnCopy.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { placeTurnCopies } = await import(pathToFileURL(out).href)

let n = 0
const eq = (what, a, b) => {
  n++
  assert.deepEqual(a, b, `${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}

// A pane 50 rows at 18px a row, drawn 7px down inside its wrap - the desk's shape.
const geom = { viewportY: 100, cellH: 18, offY: 7, height: 900 }
const STACK = 38

// --- the ordinary case -----------------------------------------------------
{
  const p = placeTurnCopies([110, 125, 145], geom, STACK, 199)
  eq('one pair per prompt on screen', p.length, 3)
  eq('newest first', p.map((c) => c.row), [145, 125, 110])
  eq('drawn on the prompt row', p[2].top, (110 - 100) * 18 + 7)
  // The reply is the rows AFTER the prompt up to the row before the next one. Off by one
  // either way and a copy carries the next prompt or drops the last line of the answer.
  eq('a turn ends the row before the next prompt', p[2].to, 124)
  eq('the newest turn runs to the tail', p[0].to, 199)
}

// --- crowding: ask, one-line answer, ask again ------------------------------
{
  // 110 and 112 are 36px apart, which is less than one pair plus its gap.
  const p = placeTurnCopies([110, 112, 145], geom, STACK, 199)
  eq('a crowded pair is dropped, not overlapped', p.map((c) => c.row), [145, 112])
  ok('and the one kept is the newer of the two', p[1].row === 112)
  // Scrolling them apart is not what happens - the rows are fixed - but a taller row is,
  // and then both fit.
  const tall = placeTurnCopies([110, 112, 128], { ...geom, cellH: 30 }, STACK, 199)
  eq('a taller row gives both of them room', tall.map((c) => c.row), [128, 112, 110])
}

// --- a finger is bigger than a pointer --------------------------------------
{
  const pointer = placeTurnCopies([110, 112], geom, 38, 199)
  const finger = placeTurnCopies([110, 112], geom, 66, 199)
  eq('the pointer pair fits one of the two', pointer.length, 1)
  eq('and the finger pair still fits one', finger.length, 1)
  const wide = placeTurnCopies([110, 113], geom, 38, 199)
  eq('54px apart is room for a pointer pair', wide.length, 2)
  eq('but not for a finger pair', placeTurnCopies([110, 113], geom, 66, 199).length, 1)
}

// --- nothing is drawn where there is no line --------------------------------
{
  eq('a prompt scrolled off the top gets nothing', placeTurnCopies([10], geom, STACK, 199), [])
  // The last row on screen is 100 + 900/18 - 1 = 149. A pair anchored there would hang
  // 38px below the pane.
  eq('a pair that would hang off the bottom is dropped', placeTurnCopies([149], geom, STACK, 199), [])
  eq('one that fits whole is kept', placeTurnCopies([146], geom, STACK, 199).length, 1)
  eq('a pane with no prompts offers nothing', placeTurnCopies([], geom, STACK, 199), [])
  eq('a disposed marker (-1) is not a row', placeTurnCopies([-1], geom, STACK, 199), [])
  eq('a zero cell height draws nothing', placeTurnCopies([110], { ...geom, cellH: 0 }, STACK, 199), [])
}

console.log(`turn copies: ${n} checks passed`)
