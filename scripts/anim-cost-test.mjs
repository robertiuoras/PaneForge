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
// TerminalPane.css was missing until 2026-08-30, so every animation on the pane itself -
// the surface that is on screen the most and the one running a terminal underneath - was
// unguarded. The handover curtain's rail was written against `background-position` and
// this file reported ok.
const files = [
  'src/renderer/src/styles.css',
  'src/renderer/src/shelf.css',
  'src/renderer/src/components/TerminalPane.css',
  // The pet's moods (src/renderer/src/components/mascotMood.css) are their own sheet, and
  // a sheet this file does not read is a sheet with no rule about what it may cost.
  'src/renderer/src/components/mascotMood.css'
]

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

/* --- second question: is every CONTINUOUS loop held still when a frame is expensive?
   Cheap per frame is not the same as free. A `transform`/`opacity` loop composites a
   layer once per frame and nothing more, which is a rounding error at 60Hz and is not one
   at 120 or 480: measured on the PC, ten breathing halos cost 34% of a GPU core (peaks
   63%) plus 12% of the renderer, and 0.3% held lit. So styles.css carries a block that
   holds them at their lit end under two classes - `hi-refresh` (fast panel) and
   `on-battery` (this MacBook's built-in panel is 120Hz, twice the 60Hz these were drawn
   against, on the one power source that runs out).

   That block is a list, and a list rots. This is what stops it: add a new looping
   decoration without a line in the guard and the test says so, naming the selector.

   `steps()` loops are not continuous - the mascot changes opacity two or three times a
   cycle and composites nothing in between - so they are free at any rate and are not
   asked to hold. */

/** Split a selector list on top-level commas: `:is(a, b)` is ONE selector, not two. */
function splitSelectors(sel) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of sel) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Every ordinary rule in the sheet, with @media descended into and @keyframes skipped. */
function eachRule(css) {
  const out = []
  const scan = (start, end) => {
    let pos = start
    while (pos < end) {
      const brace = css.indexOf('{', pos)
      if (brace < 0 || brace >= end) break
      const close = css.indexOf('}', pos)
      if (close >= 0 && close < brace) {
        pos = close + 1
        continue
      }
      const sel = css.slice(pos, brace).trim()
      let depth = 1
      let j = brace + 1
      for (; j < end && depth > 0; j++) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
      }
      const body = css.slice(brace + 1, j - 1)
      if (sel.startsWith('@')) {
        // A keyframe body's "selectors" are percentages, and its declarations are the
        // motion itself - the first half of this file already judges those.
        if (!/^@keyframes/.test(sel)) scan(brace + 1, j - 1)
      } else if (sel) {
        out.push({ sel, body })
      }
      pos = j
    }
  }
  scan(0, css.length)
  return out
}

/* Shown for as long as one handover takes and then gone, which is the opposite of the
   thing this check exists for: a decoration still costing frames an hour later. The rail
   IS the progress - held still it reads as a stalled handover, which is a worse lie than
   the frames are worth. */
const EXEMPT = new Set(['.handover-rail::after'])

const guarded = new Set()
const needsGuard = []

for (const rel of files) {
  const css = readFileSync(join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const { sel, body } of eachRule(css)) {
    const anim = body.match(/animation(?:-name)?\s*:\s*([^;}]+)/)
    if (!anim) continue
    const value = anim[1]
    const holds = /\bnone\b/.test(value)
    const guardRule = /\.hi-refresh|\.on-battery/.test(sel)
    if (guardRule && holds) {
      // `html:is(.hi-refresh, .on-battery) .dot.working` guards `.dot.working`.
      for (const part of splitSelectors(sel)) {
        // Not `split(/\s+/)`: `html:is(.hi-refresh, .on-battery)` has a space INSIDE its
        // parentheses, so word-splitting tears the prefix in half and guards a selector
        // that does not exist. Match the whole prefix, parentheses and all.
        const bare = part.replace(/^html(?::is\([^)]*\)|[.\w-]*)\s+/, '')
        if (bare !== part) guarded.add(bare)
      }
      continue
    }
    if (!/\binfinite\b/.test(value)) continue
    // Discrete: a step function composites on the step, not on the frame.
    if (/\bsteps\s*\(/.test(value)) continue
    for (const part of splitSelectors(sel)) {
      if (/\.hi-refresh|\.on-battery|\.app-blurred/.test(part)) continue
      needsGuard.push({ rel, part })
    }
  }
}

for (const { rel, part } of needsGuard) {
  if (EXEMPT.has(part) || guarded.has(part)) continue
  problems.push(
    `${rel}: \`${part}\` loops forever without a hold - add it to the` +
      ` html:is(.hi-refresh, .on-battery) block in styles.css`
  )
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

console.log(
  `ok: every infinite animation is transform/opacity only, and all ${needsGuard.length} continuous` +
    ` loops are held still on a fast panel or on battery`
)
