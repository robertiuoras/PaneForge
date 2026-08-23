// node scripts/mirrorfit-test.mjs
//
// A mirrored pane draws the HOST's grid, so the only question is how small this
// window draws it - and the two ways that went wrong are both arithmetic, which is
// why they survived every screenshot and every typecheck.
//
// The load-bearing half is CONVERGENCE, and each way of getting it wrong is kept as a
// CONTROL that must fail: the shipped `Math.round` stalls one column short, flooring
// only the shrink cycles 11/12/11/12 for ever, and the bare font floor leaves a grid
// far too wide simply cut off at the pane edge.

import { strict as assert } from 'node:assert'
import { mirrorFit, MIN_FONT } from '../src/shared/mirrorFit.ts'

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log(`  ok  ${name}`)
}

/**
 * The real loop: a font change re-measures, so the space available in COLS scales
 * with the font. `roomCols` is what fits at font 1; the caller sees `roomCols/font`.
 */
function walk({ hostCols, hostRows, roomCols, roomRows, maxFont = 13, steps = 12 }) {
  let font = maxFont
  let scale = 1
  let settled = false
  const seen = []
  for (let i = 0; i < steps; i++) {
    const out = mirrorFit({
      fitCols: Math.floor(roomCols / font),
      fitRows: Math.floor(roomRows / font),
      hostCols,
      hostRows,
      font,
      maxFont,
    })
    seen.push(`${out.font}@${out.scale.toFixed(2)}`)
    if (out.font === font && out.scale === scale) {
      settled = true
      break
    }
    font = out.font
    scale = out.scale
  }
  // Does the host grid actually fit on screen once the walk settles?
  // Scaling DOWN multiplies: a scale of 0.67 draws the grid at two thirds the size.
  const drawnCols = hostCols * font * scale
  const drawnRows = hostRows * font * scale
  return { font, scale, seen, settled, fits: drawnCols <= roomCols + 1e-9 && drawnRows <= roomRows + 1e-9 }
}

t('a grid that fits is left at the user’s own font', () => {
  const r = walk({ hostCols: 80, hostRows: 24, roomCols: 80 * 13, roomRows: 24 * 13 })
  assert.equal(r.font, 13)
  assert.equal(r.scale, 1)
  assert.ok(r.fits)
})

// The smaller fault, and it is exactly one column wide: a shrink of less than half a
// pixel rounds back to the font it started at, so the walk reports "no change" while
// the grid is still a fraction too wide. Room for 158 columns at 12px, host 159.
t('a shrink of under half a pixel still shrinks', () => {
  const room = 158 * 12
  const out = mirrorFit({
    fitCols: Math.floor(room / 12),
    fitRows: 40,
    hostCols: 159,
    hostRows: 40,
    font: 12,
    maxFont: 13,
  })
  assert.equal(out.font, 11, 'floors, so the next frame is measured smaller')
  const r = walk({ hostCols: 159, hostRows: 40, roomCols: room, roomRows: 40 * 12 })
  assert.ok(r.fits, `did not fit: ${r.seen.join(' ')}`)
})

t('CONTROL: rounding to nearest stalls with the grid still over the edge', () => {
  const room = 158 * 12
  const font = Math.round(12 * (Math.floor(room / 12) / 159))
  assert.equal(font, 12, 'the old step does not move at all')
  assert.ok(159 * font > room, 'and 159 columns at that font are wider than the room')
})

// The second fault: below the font floor there was nothing left to do, so the pane
// drew a grid wider than itself - the cut Robert reported.
t('a grid far too wide is SCALED once the font floor is reached', () => {
  const r = walk({ hostCols: 159, hostRows: 40, roomCols: 120 * 6, roomRows: 40 * 6 })
  assert.equal(r.font, MIN_FONT, 'the font goes to the floor')
  assert.ok(r.scale < 1, `and the rest is taken by scale, got ${r.scale}`)
  assert.ok(r.fits, `the whole host grid must be on screen: ${r.seen.join(' ')}`)
})

t('CONTROL: the font floor alone leaves it cut', () => {
  const cols = 159
  const room = 120 * 6
  assert.ok(cols * MIN_FONT > room, 'at the floor, 159 columns still overflow the room for 120')
})

t('rows can be the binding constraint, not just columns', () => {
  const r = walk({ hostCols: 40, hostRows: 60, roomCols: 40 * 13, roomRows: 20 * 13 })
  assert.ok(r.fits, `did not fit: ${r.seen.join(' ')}`)
  assert.ok(r.font < 13 || r.scale < 1)
})

// The property that matters more than any single case: whatever the room and whatever
// the host grid, the walk must reach a fixed point AND that point must show the whole
// grid. A rule that cycles repaints a mirrored pane every frame for ever.
t('the font never oscillates: the walk has a fixed point', () => {
  for (const hostCols of [80, 100, 120, 159, 200, 240]) {
    for (const roomCols of [700, 900, 1200, 1500, 1900, 2400]) {
      const r = walk({ hostCols, hostRows: 40, roomCols, roomRows: 40 * 13, steps: 30 })
      assert.ok(
        r.settled,
        `${hostCols} cols into ${roomCols}px never settled: ${r.seen.join(' ')}`,
      )
      assert.ok(r.fits, `${hostCols} cols into ${roomCols}px stayed cut: ${r.seen.join(' ')}`)
    }
  }
})

// The obvious repair for the stall above is to floor the SHRINK and leave the grow
// rounding to nearest. It is worse than the bug: 12 floors to 11, at 11 there is room
// for 172 columns so k is 1.08 and round asks for 12, and 12 floors to 11 again.
t('CONTROL: flooring only the shrink cycles for ever', () => {
  const room = 158 * 12
  const step = (font) => {
    const k = Math.floor(room / font) / 159
    const want = k < 1 ? Math.floor(font * k) : Math.round(font * k)
    return Math.max(MIN_FONT, Math.min(13, want))
  }
  assert.equal(step(12), 11, 'down')
  assert.equal(step(11), 12, 'and straight back up - the cycle')
  // The rule that shipped does not cycle; it simply stops one column short.
  const shipped = (font) => Math.round(font * (Math.floor(room / font) / 159))
  assert.equal(shipped(12), 12, 'shipped stalls instead')
  assert.ok(159 * 12 > room, 'with 159 columns wider than the room it settled in')
})

t('a pane that shrank grows back when the room returns', () => {
  const small = mirrorFit({ fitCols: 60, fitRows: 20, hostCols: 120, hostRows: 40, font: 12, maxFont: 13 })
  assert.ok(small.font < 12)
  const big = mirrorFit({ fitCols: 400, fitRows: 200, hostCols: 120, hostRows: 40, font: small.font, maxFont: 13 })
  assert.equal(big.font, 13, 'never bigger than the user’s own size, but back up to it')
  assert.equal(big.scale, 1)
})

t('an unmeasured container changes nothing', () => {
  const out = mirrorFit({ fitCols: 0, fitRows: 0, hostCols: 120, hostRows: 40, font: 11, maxFont: 13 })
  assert.deepEqual(out, { font: 11, scale: 1 })
})

t('a zero host grid cannot divide by zero', () => {
  const out = mirrorFit({ fitCols: 80, fitRows: 24, hostCols: 0, hostRows: 0, font: 12, maxFont: 13 })
  assert.ok(Number.isFinite(out.font) && Number.isFinite(out.scale))
  assert.ok(out.scale > 0)
})

console.log(`\nmirrorfit: ${pass} cases passed`)
