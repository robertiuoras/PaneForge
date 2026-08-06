// Where a prompt tag is allowed to be drawn.
//
// The rail is a table of contents, and the two ways it can lie are the two this pins:
// a tag drawn somewhere off the rail (over the terminal, or below the pane entirely),
// and a tag drawn nowhere near the thumb it claims to point at. Both shipped. The
// greedy placement this replaced put 11 of 100 evenly-spread tags past the end of a
// 352px rail - the last of them 44px below it - and, on the shape a real conversation
// has (a run of asks bunched together, then a long tail of output), moved the tag for
// the first ask 304.8px down a 352px rail.
//
// No window and no terminal: the placement is arithmetic, so this is the cheap half of
// `test:rail` / `test:railclick`, which drive a real pane over CDP.
//
//   node scripts/rail-place-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-rail-place-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'rail.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/rail.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { placeRail, dodge, separation, fitSeparation, BAR, MAX_SEP, MAX_HIT, driftCap } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A pane in a 2x2 grid: ~400px of track less the 48px minimum thumb. */
const SPAN = 352
const even = (n, span = SPAN) =>
  n < 2 ? [0] : Array.from({ length: n }, (_, i) => (i / (n - 1)) * span)

// ---------------------------------------------------------------- on the rail

for (const n of [1, 2, 5, 40, 60, 100, 400]) {
  const tops = placeRail(even(n), SPAN).map((t) => t.top)
  check(`${n} tags: none above the rail`, Math.min(...tops) >= -1e-9, Math.min(...tops))
  check(
    `${n} tags: none past the end of the rail`,
    Math.max(...tops) <= SPAN + 1e-9,
    `last=${Math.max(...tops)} span=${SPAN}`
  )
  check(
    `${n} tags: oldest to newest, top to bottom`,
    tops.every((t, i) => i === 0 || t >= tops[i - 1] - 1e-9),
    tops.slice(0, 6).join(', ')
  )
}

// The exact case that shipped broken.
{
  const tops = placeRail(even(100), SPAN).map((t) => t.top)
  check('100 evenly spread tags all fit', tops[99] <= SPAN + 1e-9, tops[99])
  check(
    '100 evenly spread tags are not displaced at all - they already fit',
    Math.max(...tops.map((t, i) => Math.abs(t - even(100)[i]))) < 0.5
  )
}

// A rail with more tags than pixels packs rather than overflowing, and says so by
// handing out hit boxes too small to steal a neighbour's click.
{
  const many = placeRail(even(400), SPAN)
  check('an overfull rail still ends on the rail', many[399].top <= SPAN + 1e-9, many[399].top)
  check(
    'an overfull rail hands out no oversized hit boxes',
    many.every((t) => t.hitUp <= MAX_HIT && t.hitDown <= MAX_HIT)
  )
  check('separation shrinks rather than overflowing', separation(400, SPAN) < 1, separation(400, SPAN))
}

// -------------------------------------------------------- near the truth

// The conversation shape: 40 asks inside the first 30px, then two much later ones.
{
  const raw = [...Array.from({ length: 40 }, (_, i) => (i / 39) * 30), SPAN * 0.8, SPAN * 0.95]
  const tops = placeRail(raw, SPAN).map((t) => t.top)
  const disp = tops.map((t, i) => Math.abs(t - raw[i]))
  const worst = Math.max(...disp)
  // The greedy placement managed 304.8px on this input - the tag for the first ask drawn
  // near the bottom of a 352px rail. Separation is what gives now, so this is capped.
  check(
    'a bunched conversation stays near its own part of the rail',
    worst <= driftCap(SPAN) + 1e-6,
    `worst=${worst.toFixed(1)}px cap=${driftCap(SPAN)}`
  )
  check(
    'and it gave up separation to get there, not position',
    fitSeparation(raw, SPAN) < separation(raw.length, SPAN),
    `${fitSeparation(raw, SPAN).toFixed(2)} vs ${separation(raw.length, SPAN).toFixed(2)}`
  )
  check(
    'the two late tags are not dragged by the cluster above them',
    Math.abs(tops[40] - raw[40]) < 1 && Math.abs(tops[41] - raw[41]) < 1,
    `${tops[40].toFixed(1)} vs ${raw[40].toFixed(1)}, ${tops[41].toFixed(1)} vs ${raw[41].toFixed(1)}`
  )
  check(
    'the cluster spreads around where it is, not only below it',
    tops[0] < raw[0] + 1,
    `first=${tops[0].toFixed(1)} raw=${raw[0].toFixed(1)}`
  )
}

// Two clusters far apart: neither may push the other, and neither may leave the rail.
{
  const raw = [
    ...Array.from({ length: 25 }, (_, i) => 20 + i * 1.7),
    ...Array.from({ length: 25 }, (_, i) => 240 + i * 1.7)
  ]
  const tops = placeRail(raw, SPAN).map((t) => t.top)
  check('two clusters: the last tag is on the rail', tops[49] <= SPAN + 1e-9, tops[49].toFixed(1))
  check(
    'two clusters: the lower one does not climb into the upper one',
    tops[25] > 150,
    tops[25].toFixed(1)
  )
  const worst = Math.max(...tops.map((t, i) => Math.abs(t - raw[i])))
  check('two clusters: worst displacement stays local', worst < 100, `${worst.toFixed(1)}px`)
}

// Minimum displacement is the actual promise, so a greedy alternative may never beat it.
{
  const greedy = (raw, span) => {
    const out = raw.slice()
    const sep = out.length > 1 ? Math.max(4, Math.min(12, span / (out.length - 1))) : 12
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + sep)
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - sep)
    return out.map((t) => Math.max(0, t))
  }
  const cases = [
    even(60),
    even(100),
    [...Array.from({ length: 40 }, (_, i) => (i / 39) * 30), SPAN * 0.8, SPAN * 0.95],
    [0, 1, 2, 3, 200, 201, 202, SPAN]
  ]
  const cost = (tops, raw) => tops.reduce((a, t, i) => a + (t - raw[i]) ** 2, 0)
  for (const [i, raw] of cases.entries()) {
    const ours = placeRail(raw, SPAN).map((t) => t.top)
    check(
      `case ${i}: no cheaper placement than ours`,
      cost(ours, raw) <= cost(greedy(raw, SPAN), raw) + 1e-6,
      `${cost(ours, raw).toFixed(0)} vs ${cost(greedy(raw, SPAN), raw).toFixed(0)}`
    )
  }
}

// ------------------------------------------------------------- separation + hit boxes

{
  const tags = placeRail([0, 1, 2, 3, 4], SPAN)
  const sep = separation(5, SPAN)
  check('an uncrowded rail separates by the full 12px', sep === MAX_SEP, sep)
  check(
    'tags a hair apart come out 12px apart',
    tags.every((t, i) => i === 0 || t.top - tags[i - 1].top >= MAX_SEP - 1e-9),
    tags.map((t) => t.top.toFixed(1)).join(', ')
  )
  check(
    'a 12px gap leaves no hit box reaching into a neighbour',
    tags.every((t, i) => (i === 0 ? true : t.hitUp <= (MAX_SEP - BAR) / 2 + 1e-9))
  )
  check('the ends still get the full target', tags[0].hitUp === MAX_HIT && tags[4].hitDown === MAX_HIT)
}

{
  const one = placeRail([100], SPAN)
  check('a lone tag is not moved', one[0].top === 100)
  check('a lone tag gets the full target both ways', one[0].hitUp === MAX_HIT && one[0].hitDown === MAX_HIT)
  check('no tags is not a crash', placeRail([], SPAN).length === 0)
}

// A rail with no room at all (a pane one row tall mid-drag) must not produce NaN.
{
  const tops = placeRail([0, 5, 10], 0).map((t) => t.top)
  check('a zero-height rail places everything at 0', tops.every((t) => t === 0), tops.join(', '))
  check('a zero-height rail produces no NaN', tops.every(Number.isFinite))
}

// dodge on its own: the constraint it claims to satisfy, on random input.
{
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rand() * 60)
    const raw = Array.from({ length: n }, () => rand() * SPAN).sort((a, b) => a - b)
    const sep = separation(n, SPAN)
    const out = dodge(raw, sep, SPAN)
    if (
      !out.every((t, i) => i === 0 || t - out[i - 1] >= sep - 1e-9) ||
      out[0] < -1e-9 ||
      out[n - 1] > SPAN + 1e-9
    ) {
      check(`random trial ${trial} holds the constraints`, false, out.join(', '))
    }
  }
  check('200 random rails hold separation and both ends', true)
}

console.log(`rail placement: ${checks} checks passed`)
