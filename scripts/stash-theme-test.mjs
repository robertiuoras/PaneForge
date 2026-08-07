// The floating Stash wears the app's colours, and this is what keeps it that way.
//
// It is a structural test, not a contrast one, and that is on purpose: `test:theme` already
// holds every preset and every hue at 4.5:1 body and 3:1 secondary, and the overlay's three
// text steps are now `--text`, `--muted`, and a mix of the two. A mix of two colours that
// both clear a ratio against the same background clears it too - luminance along the mix is
// between theirs - so the only way the overlay can fail contrast again is by reintroducing a
// colour of its own. That is exactly what this looks for.
//
// The bug it exists for, measured on a default install 2026-08-07, before the fix:
//
//   main window   --accent #f0a868   --text #efecea   --bg #0d0907    (warm, derived)
//   Stash overlay --accent 128,192,255  ink #ecedf2   card rgba(38,38,48,.9)  (cold, fixed)
//   Stash overlay :root inline variables: 0 - applyTheme had never been called there
//
// and light-or-dark was `@media (prefers-color-scheme: light)`, i.e. macOS's answer rather
// than the app's, so PaneForge on Paper with the OS in dark mode drew a light window with a
// dark Stash floating over it and no slider in Settings could reach it.
//
// Four traps this pins, three of which cost a build each to find:
//
//   1. A colour literal in shelf.css outside a var() fallback slot. The fallback is the
//      ~40ms before the config arrives and is allowed to be a literal; anything else is a
//      second source of truth.
//   2. `rgba(var(--accent), a)`. The overlay wants the accent as a triplet and the palette
//      writes `--accent` as a hex onto the same :root, so the old name collided: every one
//      of those rules would have resolved to nothing the moment the theme was applied, with
//      no error anywhere. The triplet is `--acc-rgb`.
//   3. `parseHex` unscaled. It answers in 0..1 because theme.ts is Oklab maths downstream;
//      `rgba()` reads 0.94 as ~1/255 and paints black. The live window read
//      "0.941, 0.659, 0.408" on the first build of the fix.
//   4. `theme` reaching STASH_CONFIG_KEYS. The overlay may READ the theme and must never
//      patch it - that list is the allowlist of keys it can write.
//
//   node scripts/stash-theme-test.mjs

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
const ok = (cond, what, detail = '') => {
  if (cond) return
  failed++
  console.error(`  FAIL  ${what}${detail ? `\n        ${detail}` : ''}`)
}

const css = read('src/renderer/src/shelf.css')
const tsx = read('src/renderer/src/shelf.tsx')
const types = read('src/shared/types.ts')

// Comments carry the measured hex values from the bug itself, so they would trip every
// check below. Strip them first - and only /* */, which is all CSS has.
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '')

console.log('shelf.css draws no colour of its own')

// A literal is legal in exactly one position: the second argument of a var(), which is what
// paints the window for the frame before the theme lands. Blank those out, then anything
// left that names a colour is the overlay deciding one for itself.
const withoutFallbacks = cssCode.replace(/var\(\s*--[a-z0-9-]+\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var(--x)')

const hexes = withoutFallbacks.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
ok(!hexes.length, 'no hex colour outside a var() fallback', hexes.join(' '))

// Neutral black and white at an alpha are the one exception, and a deliberate one: they are
// a hover or a scrim ON whatever surface is underneath, so they follow the theme by being
// transparent. A CHROMATIC rgb() is the overlay picking a hue, which is the thing being
// banned - it is how the old cold blue got in.
const chromatic = (withoutFallbacks.match(/\brgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,[^)]*)?\)/g) ?? [])
  .filter((c) => {
    const [r, g, b] = c.match(/[\d.]+/g).map(Number)
    return !(r === g && g === b)
  })
ok(!chromatic.length, 'no chromatic rgb() outside a var() fallback', chromatic.join(' '))

console.log('light and dark are the app\'s decision, not the operating system\'s')
ok(
  !cssCode.includes('prefers-color-scheme'),
  'shelf.css does not ask the OS for its colour scheme',
  'the depth slider decides this; the OS does not know which preset is loaded'
)
ok(cssCode.includes(':root.light'), 'shelf.css has a :root.light branch')
ok(
  /classList\.toggle\('light'/.test(tsx),
  'shelf.tsx sets that class'
)
ok(
  /luminance\(/.test(tsx),
  'and sets it from the luminance of the derived background, not from a preset id'
)

console.log('the accent triplet does not collide with the palette\'s hex accent')
ok(
  !/rgba\(\s*var\(--accent\)/.test(cssCode),
  'shelf.css uses --acc-rgb, never rgba(var(--accent), …)',
  'applyTheme writes --accent as a hex onto the same :root; rgba() of a hex is dropped silently'
)
ok(cssCode.includes('var(--acc-rgb)'), 'shelf.css reads --acc-rgb')
ok(
  /setProperty\('--acc-rgb'/.test(tsx),
  'shelf.tsx writes --acc-rgb'
)
ok(
  /parseHex\([^)]*\)\s*\.map\(\([^)]*\)\s*=>\s*Math\.round\([^)]*\*\s*255\)\)/.test(tsx),
  'and scales parseHex from 0..1 to 0..255 first',
  'unscaled, every accent tint in the overlay paints black'
)

console.log('the overlay reads the theme and may not write it')
ok(/applyTheme\(/.test(tsx), 'shelf.tsx calls the shared applyTheme')
ok(
  /import \{ applyTheme \} from '\.\/theme'/.test(tsx),
  'the same one the main window calls, not a copy'
)

// Anchored on the `export const`, not on the bare name: the Pick's own comment says the
// theme is deliberately absent from STASH_CONFIG_KEYS, and slicing to the first mention cut
// the declaration in half - the test failed on the very line it was written to require.
const keysAt = types.indexOf('export const STASH_CONFIG_KEYS')
const pick = types.slice(types.indexOf('export type StashConfig'), keysAt)
ok(/\|\s*'theme'/.test(pick), 'StashConfig carries the theme')

const keys = types.slice(keysAt)
const list = keys.slice(0, keys.indexOf('] as const'))
ok(
  !list.includes("'theme'"),
  'STASH_CONFIG_KEYS does not, so the overlay cannot patch it',
  'a window that floats over every other app must not be able to recolour the one behind it'
)

// The push that carries it. Without this the overlay reads the theme once at startup and
// never hears the slider move, which looks identical to it working until you drag one.
const index = read('src/main/index.ts')
const fn = index.slice(index.indexOf('function stashConfig'))
ok(
  /theme:\s*cfg\.theme/.test(fn.slice(0, fn.indexOf('\n}'))),
  'stashConfig() in main includes the theme on every push'
)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall good')
