// What a theme is allowed to look like.
//
// The whole point of deriving eleven greys from one accent is that nobody has to check
// them, so nobody will - a person picks a colour they like, the window recolours, and
// the second line of every sidebar row quietly drops to 2.4:1 against its background.
// That is invisible to the person who chose it (they know what it says) and it is the
// only failure mode this feature has. So the contrast is asserted here, for every preset
// and for a spread of hostile custom colours, in milliseconds, with no window.
//
// The second half is about not surprising anyone: a config nobody has touched must draw
// the app it always drew. The old palette was eleven hex literals at the top of
// styles.css, and the ladder below reproduces them - so `depth: 0.3` is pinned to land on
// the surfaces this app shipped with rather than "somewhere dark".
//
//   node scripts/theme-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-theme-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'theme.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/theme.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const T = createRequire(import.meta.url)(out)
const {
  DEFAULT_THEME,
  PRESETS,
  applyPreset,
  auditTheme,
  contrast,
  inGamut,
  onColor,
  oklchToRgb,
  paletteFor,
  parseHex,
  rgbToOklch,
  toHex
} = T

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const near = (actual, expected, tol, what) => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ~${expected} (+-${tol}), got ${actual}`
  )
  checks++
}

// ---------------------------------------------------------------------------
// The colour maths, before anything that depends on it

is(toHex(parseHex('#8b9dff')), '#8b9dff', 'hex survives a round trip')
is(toHex(parseHex('8b9dff')), '#8b9dff', 'a missing # is not a reason to lose the colour')
is(toHex(parseHex('#abc')), '#aabbcc', 'three-digit hex expands the way CSS does')
is(toHex(parseHex('nonsense')), '#808080', 'an unparseable colour falls back rather than throwing')

for (const hex of ['#ffffff', '#000000', '#f0a868', '#5fd7ef', '#c48bff', '#35d07f']) {
  is(toHex(oklchToRgb(rgbToOklch(parseHex(hex)))), hex, `oklch round trip is exact for ${hex}`)
}

// White and black are the fixed points every contrast number is anchored to.
near(contrast('#ffffff', '#000000'), 21, 0.01, 'white on black is the maximum ratio')
near(contrast('#808080', '#808080'), 1, 0.001, 'a colour on itself is the minimum ratio')

// The gamut clamp is the one piece of this that is easy to get subtly wrong: letting the
// RGB conversion clamp each channel on its own does not desaturate, it HUE-SHIFTS, so a
// violet surface becomes a blue one at the dark end and nobody can say why.
{
  const violet = rgbToOklch(parseHex('#c48bff'))
  const dark = inGamut(0.16, violet.c, violet.h)
  const back = rgbToOklch(parseHex(dark))
  near(back.l, 0.16, 0.01, 'a clamped colour still lands on the lightness it was asked for')
  const drift = Math.abs(((back.h - violet.h + 540) % 360) - 180)
  ok(drift < 4, `hue must survive the clamp: drifted ${drift.toFixed(1)} degrees`)
}

// ---------------------------------------------------------------------------
// A config nobody has touched draws the app that shipped

{
  const v = paletteFor(DEFAULT_THEME)
  // Not the literal old hex - the accent changed on purpose and it tints the greys - but
  // the LADDER has to land where the hand-written one did, or every dialog, divider and
  // hover state in 1600 lines of CSS is now a slightly different shade of not-quite.
  const wanted = { '--bg': '#0a0a0d', '--surface': '#101014', '--surface-2': '#16161d', '--surface-3': '#1e1e27' }
  for (const [name, oldHex] of Object.entries(wanted)) {
    const oldL = rgbToOklch(parseHex(oldHex)).l
    const newL = rgbToOklch(parseHex(v[name])).l
    near(newL, oldL, 0.025, `${name} keeps the shipped app's lightness`)
  }
  is(v['--r'], '9px', 'the middle of the rounding slider is the 9px the app shipped with')
  is(v['--r-sm'], '6px', 'and its small radius is the 6px')
  is(v['--r-lg'], '13px', 'and its large one the 13px')
  is(v['--accent'], DEFAULT_THEME.accent, 'the accent is used verbatim, never "corrected"')
}

// The default must not be the orange the icon is. That was the whole brief: the app and
// its mark should read as one product without the window being a hazard sign.
{
  const acc = rgbToOklch(parseHex(DEFAULT_THEME.accent))
  ok(acc.c < 0.12, `the default accent is muted, not full ember: chroma ${acc.c.toFixed(3)}`)
  ok(acc.h > 40 && acc.h < 80, `the default accent is still warm: hue ${acc.h.toFixed(0)}`)
}

// ---------------------------------------------------------------------------
// Every preset is legible. This is the assertion the feature exists for.

for (const p of PRESETS) {
  const theme = applyPreset(p.id, { ...DEFAULT_THEME, density: 'cozy' })
  is(theme.preset, p.id, `applying preset ${p.id} records which preset it was`)
  const a = auditTheme(theme)
  ok(a.textOnBg >= 4.5, `${p.name}: body text is ${a.textOnBg.toFixed(2)}:1, AA needs 4.5`)
  ok(a.mutedOnBg >= 3, `${p.name}: second lines are ${a.mutedOnBg.toFixed(2)}:1, needs 3`)
  ok(a.accentOnBg >= 3, `${p.name}: accent text is ${a.accentOnBg.toFixed(2)}:1, needs 3`)
  is(a.ok, true, `${p.name} passes its own audit`)

  const v = paletteFor(theme)
  // A filled accent button has to be readable too, and which of black/white wins depends
  // on the accent - hard-coding one is how a yellow button gets white text.
  ok(contrast(v['--accent'], v['--accent-on']) >= 4.5, `${p.name}: text on a filled accent button`)
  // Layers have to be distinguishable or the whole surface ladder is decoration.
  for (const [lo, hi] of [
    ['--bg', '--surface'],
    ['--surface', '--surface-2'],
    ['--surface-2', '--surface-3']
  ]) {
    const d = Math.abs(rgbToOklch(parseHex(v[lo])).l - rgbToOklch(parseHex(v[hi])).l)
    ok(d > 0.008, `${p.name}: ${lo} and ${hi} are the same colour (dL ${d.toFixed(4)})`)
  }
}

// ---------------------------------------------------------------------------
// Custom colours, including the ones a person will actually try

{
  // Every hue at full saturation, which is what a colour wheel hands back.
  let worst = { ratio: 99, hue: -1 }
  for (let h = 0; h < 360; h += 15) {
    const accent = inGamut(0.72, 0.2, h)
    const theme = { ...DEFAULT_THEME, preset: 'custom', accent, tint: 1 }
    const a = auditTheme(theme)
    ok(a.textOnBg >= 4.5, `hue ${h} at full tint: body text is ${a.textOnBg.toFixed(2)}:1`)
    if (a.accentOnBg < worst.ratio) worst = { ratio: a.accentOnBg, hue: h }
  }
  ok(
    worst.ratio >= 3,
    `the worst hue on the wheel (${worst.hue}) still reaches ${worst.ratio.toFixed(2)}:1`
  )
}

{
  // The two a person picks to be funny, and the one they pick by accident.
  for (const accent of ['#000000', '#ffffff', '#010203', '#fffe00']) {
    const theme = { ...DEFAULT_THEME, preset: 'custom', accent }
    const a = auditTheme(theme)
    ok(a.textOnBg >= 4.5, `accent ${accent}: the WINDOW stays readable whatever the accent is`)
    const v = paletteFor(theme)
    ok(contrast(v['--accent'], v['--accent-on']) >= 4.5, `accent ${accent}: filled button text`)
  }
  // Black as an accent on a near-black window is the case that looks like it must fail,
  // and does not - because `--accent-text` is a LIFT of the accent rather than the accent
  // itself, so it comes out a readable grey. Worth pinning precisely because it is
  // counter-intuitive: the thing to check is that the lift really happened and was not
  // quietly the same colour twice.
  const blackTheme = { ...DEFAULT_THEME, preset: 'custom', accent: '#000000' }
  const black = auditTheme(blackTheme)
  is(black.ok, true, 'a black accent survives, because what gets drawn is the lifted accent')
  is(black.warning, '', 'so there is nothing to warn about')
  const bv = paletteFor(blackTheme)
  ok(bv['--accent-text'] !== bv['--accent'], 'and the lift is a different colour from the accent')
  ok(contrast(bv['--accent-text'], bv['--surface']) >= 3, 'and it is the readable one')

  // The audit does have to be capable of saying no, or it is decoration. A window whose
  // own surfaces are mid-grey is where body text genuinely runs out of room.
  const mush = auditTheme({ ...DEFAULT_THEME, preset: 'custom', depth: 0.62 })
  is(mush.ok, false, 'a mid-grey window is reported as hard to read rather than shipped')
  ok(mush.warning.length > 0, 'and the report is a sentence, not a boolean')
}

is(onColor('#fffe00'), '#0b0b0f', 'yellow takes dark text')
is(onColor('#101014'), '#ffffff', 'near-black takes white text')

// ---------------------------------------------------------------------------
// Depth: the light end has to work, because a preset ships on it

{
  const paper = paletteFor(applyPreset('paper', DEFAULT_THEME))
  ok(
    rgbToOklch(parseHex(paper['--text'])).l < rgbToOklch(parseHex(paper['--bg'])).l,
    'on a light theme the text is darker than the window, not lighter'
  )
  ok(paper['--line'].startsWith('#000000'), 'a light theme draws its edges in black alpha')
}
{
  const dark = paletteFor({ ...DEFAULT_THEME, depth: 0 })
  ok(
    rgbToOklch(parseHex(dark['--text'])).l > rgbToOklch(parseHex(dark['--bg'])).l,
    'on a dark theme the text is lighter than the window'
  )
}

// Density and rounding are the two knobs with no colour in them, so they are the two that
// could silently do nothing at all.
{
  const cozy = paletteFor({ ...DEFAULT_THEME, density: 'cozy' })
  const compact = paletteFor({ ...DEFAULT_THEME, density: 'compact' })
  ok(cozy['--row-pad'] !== compact['--row-pad'], 'compact actually changes the row padding')
  const square = paletteFor({ ...DEFAULT_THEME, round: 0 })
  const round = paletteFor({ ...DEFAULT_THEME, round: 1 })
  ok(parseInt(square['--r']) < parseInt(round['--r']), 'the rounding slider actually rounds')
}

// Every var the stylesheet reads must exist for every theme, or one preset has an
// undefined colour somewhere nobody looks.
{
  const names = Object.keys(paletteFor(DEFAULT_THEME))
  for (const p of PRESETS) {
    const v = paletteFor(applyPreset(p.id, DEFAULT_THEME))
    for (const n of names) ok(typeof v[n] === 'string' && v[n].length > 0, `${p.name} defines ${n}`)
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`PASS theme: ${checks} assertions`)
