#!/usr/bin/env node
/**
 * What a looping decoration may cost.
 *
 * A CSS animation is either composited or painted, and the difference is not a nuance:
 * `transform` and `opacity` are handed to the GPU and cost nothing per frame, while a
 * `box-shadow` spread, a `filter`, a `width` or a `top` invalidates the element's rect and
 * the tile under it is rasterised again, on the main thread, every single frame - at
 * whatever the panel happens to run at, which on this desk is 120Hz and on the PC is 480.
 *
 * Measured, not assumed. A test copy carrying eighteen idle dots, the ring drawn each way,
 * same window, same panes, back to back:
 *
 *   ring as `box-shadow` spread 2px -> 7px     gpu 136% of a core, renderer 44%
 *   ring as a layer scaling 1 -> 1.85          gpu  36%,           renderer 30%
 *   ring off entirely (the floor)              gpu  20%,           renderer 16%
 *
 * So the paint version cost 116 points of a core against the layer version's 16, for the
 * same motion in the same colour - and it ran on IDLE panes, which is what a desk full of
 * finished turns looks like most of the day. That was "PaneForge is making my MacBook hot".
 *
 * A one-shot animation is not the target: `doneGlow` paints a box-shadow three times and
 * stops, which is a transition, not a loop. Only `infinite` is checked, because only a
 * loop is still costing something an hour later.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = ['src/renderer/src/styles.css', 'src/renderer/src/shelf.css']

/** Properties a compositor can animate without repainting anything. */
const CHEAP = new Set(['transform', 'opacity', 'translate', 'rotate', 'scale', 'visibility'])

const problems = []

for (const rel of files) {
  const css = readFileSync(join(root, rel), 'utf8')

  // Every keyframe name used by an `animation` / `animation-name` declaration that loops.
  // The shorthand carries the name and `infinite` in the same declaration, which is what
  // makes this readable without a real CSS parser.
  const looping = new Set()
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
    const value = m[1]
    if (!/\binfinite\b/.test(value)) continue
    for (const word of value.split(/[\s,]+/)) {
      if (/^[A-Za-z][\w-]*$/.test(word)) looping.add(word)
    }
  }

  // The blocks themselves, found by counting braces rather than by a lazy match: a
  // keyframes body is itself full of braces, and `[\s\S]*?\}` stops at the first one -
  // which reads `@keyframes pulse { 50% { opacity: .45 } }` as ending after `.45`, then
  // treats every ordinary rule after it as part of the animation. The first version of
  // this file did exactly that and reported five failures on correct CSS.
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const name = m[1]
    let depth = 1
    let i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    const body = css.slice(m.index + m[0].length, i - 1)
    if (!looping.has(name)) continue
    const props = new Set()
    for (const d of body.matchAll(/(^|[{;\s])([a-z-]+)\s*:/g)) props.add(d[2])
    const costly = [...props].filter((p) => !CHEAP.has(p))
    if (costly.length) {
      problems.push(`${rel}: @keyframes ${name} loops forever and animates ${costly.join(', ')}`)
    }
  }
}

if (problems.length) {
  console.error('A looping animation is repainting every frame:\n')
  for (const p of problems) console.error('  ' + p)
  console.error(
    '\nDraw it as a layer instead: a pseudo-element animating transform/opacity gives the' +
      '\nsame motion for a seventh of the cost. See scripts/anim-cost-test.mjs for the numbers.'
  )
  process.exit(1)
}

console.log('ok: every infinite animation is transform/opacity only')
