// Every colour the app draws, derived from one accent and one number.
//
// The window used to be a fixed list of hex literals at the top of styles.css, which is
// fine until somebody wants a different one: a "pick your colour" setting over that list
// means either shipping a whole second list per preset (they drift) or letting a person
// set `--accent` alone and watch it clash with eleven greys that were chosen for the old
// one. So the greys are derived too. Tinting the surfaces a few percent toward the accent
// hue is the entire trick behind why a themed app looks designed rather than recoloured -
// it is what Discord's gradient themes, VS Code's colour themes and Material You all do,
// by hand or by extraction.
//
// Pure and dependency-free on purpose: `scripts/theme-test.mjs` compiles this one file and
// asserts contrast ratios. A palette whose body text fails WCAG AA is a bug that a
// screenshot cannot show you - it looks fine to the person who picked the colour, on the
// monitor they picked it on.

export type Density = 'cozy' | 'compact'

/** What a person actually chose. Everything else on screen is computed from this. */
export interface ThemeConfig {
  /** id of a PRESET, or 'custom' when the fields below were edited by hand */
  preset: string
  /** the one colour: `#rrggbb` */
  accent: string
  /** how far the greys lean toward the accent's hue, 0..1 (0 = neutral slate) */
  tint: number
  /** how dark the window's own background sits, 0..1 (0 = near black, 1 = lifted) */
  depth: number
  /** corner rounding multiplier, 0..1 (0 = square, 1 = pill-ish) */
  round: number
  /**
   * How much of the real macOS glass the SIDEBAR lets through, 0..1. Only ever read on a
   * window drawing `NSGlassEffectView` (`main/glass.ts`); everywhere else the sidebar is
   * opaque already and this changes nothing.
   *
   * It defaults NEAR the solid end rather than at the material's own look, because the
   * sidebar is a column of small text over whatever wallpaper is behind the window - the
   * same argument that keeps `.panes` opaque - and a person who wants the glass can ask
   * for it here. Optional so a preset, and a config written by an older build, keep the
   * default without carrying the field.
   */
  glass?: number
  /** row height and padding */
  density: Density
}

export const DEFAULT_THEME: ThemeConfig = {
  preset: 'forge',
  // The mark is an ember gradient (#ffb25e → #f43f0f) and the app that launches from it
  // was periwinkle, which read as two different products. This is the mark's own top
  // ember pulled back off full orange - warm enough to be the same object, muted enough
  // that eleven of them in a sidebar are not a hazard sign. Full ember ships as a preset.
  accent: '#f0a868',
  tint: 0.22,
  depth: 0.3,
  round: 0.5,
  glass: 0.3,
  density: 'cozy'
}

export interface ThemePreset {
  id: string
  name: string
  /** the sentence under the swatch; what this one is FOR, not what colour it is */
  note: string
  theme: Omit<ThemeConfig, 'preset' | 'density'>
}

/**
 * The list on the Appearance tab.
 *
 * Deliberately short. A picker with forty swatches is a colour catalogue, and the thing
 * people actually do with one is scroll it once and never open it again; the whole point
 * of deriving the palette is that the custom slider below the list is the long tail.
 */
export const PRESETS: ThemePreset[] = [
  {
    id: 'forge',
    name: 'Forge',
    note: 'The default. Warm amber, matching the app icon.',
    theme: { accent: '#f0a868', tint: 0.22, depth: 0.3, round: 0.5 }
  },
  {
    id: 'ember',
    name: 'Ember',
    note: 'The icon at full heat. Loud, and unmistakable in a taskbar.',
    theme: { accent: '#ff7a3c', tint: 0.34, depth: 0.24, round: 0.5 }
  },
  {
    id: 'slate',
    name: 'Slate',
    note: 'What PaneForge looked like before it had a colour.',
    theme: { accent: '#8b9dff', tint: 0.14, depth: 0.3, round: 0.5 }
  },
  {
    id: 'moss',
    name: 'Moss',
    note: 'Green, and quiet with it. Easiest on a long day.',
    theme: { accent: '#5fd39a', tint: 0.2, depth: 0.32, round: 0.5 }
  },
  {
    id: 'ice',
    name: 'Ice',
    note: 'Cold cyan on near-black. The highest contrast here.',
    theme: { accent: '#5fd7ef', tint: 0.16, depth: 0.12, round: 0.35 }
  },
  {
    id: 'orchid',
    name: 'Orchid',
    note: 'Violet, with the surfaces leaning the same way.',
    theme: { accent: '#c48bff', tint: 0.3, depth: 0.34, round: 0.6 }
  },
  {
    id: 'rose',
    name: 'Rose',
    note: 'Warm pink. Reads as friendly rather than as an error.',
    theme: { accent: '#ff8fae', tint: 0.26, depth: 0.32, round: 0.65 }
  },
  {
    id: 'paper',
    name: 'Paper',
    note: 'Lifted greys and low chroma, for a bright room.',
    // 0.98, not 0.72: the depth curve spends its bottom third on the dark themes people
    // actually use, so "light" lives near the very top of the slider. Measured in the real
    // window - 0.72 came out #6d6b68, a mid grey that reads as a mistake, and 0.95 came out
    // #d2d0cd, which is dingy rather than light. 0.98 is L 0.906, a warm near-white with
    // room above it for three more surfaces before the ladder hits pure white.
    theme: { accent: '#8a6a3c', tint: 0.1, depth: 0.98, round: 0.4 }
  }
]

export function presetById(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

// ---------------------------------------------------------------------------------
// Oklab. The reason the ramps are perceptually even instead of "dark grey, dark grey,
// suddenly much lighter grey": stepping HSL lightness is not stepping apparent
// lightness, and it is most wrong exactly where a UI lives, in the bottom third.
// ---------------------------------------------------------------------------------

export interface Oklch {
  /** perceptual lightness, 0..1 */
  l: number
  /** chroma, 0..~0.37 in sRGB */
  c: number
  /** hue in degrees, 0..360 */
  h: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
function toGamma(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** `#rgb` / `#rrggbb` → 0..1 triple. Anything unparseable comes back as mid grey. */
export function parseHex(hex: string): [number, number, number] {
  const s = hex.trim().replace(/^#/, '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0.5, 0.5, 0.5]
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  ]
}

export function toHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'))
      .join('')
  )
}

export function rgbToOklch([r, g, b]: [number, number, number]): Oklch {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const c = Math.sqrt(A * A + B * B)
  let h = (Math.atan2(B, A) * 180) / Math.PI
  if (h < 0) h += 360
  return { l: L, c, h }
}

export function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.291485548 * B
  const L = l_ * l_ * l_
  const M = m_ * m_ * m_
  const S = s_ * s_ * s_
  return [
    toGamma(clamp01(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)),
    toGamma(clamp01(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)),
    toGamma(clamp01(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S))
  ]
}

/**
 * A colour at exactly this perceptual lightness, keeping hue, with chroma reduced to
 * whatever still fits in sRGB.
 *
 * The clamp is why this is a function rather than three lines inline: an accent at
 * chroma 0.19 is fine at L 0.7 and impossible at L 0.15, and letting oklchToRgb clamp
 * each channel on its own does not desaturate - it HUE-SHIFTS, so a violet surface
 * quietly becomes a blue one at the dark end of the ramp.
 */
export function inGamut(l: number, c: number, h: number): string {
  let lo = 0
  let hi = c
  const fits = (cc: number): boolean => {
    const rad = (h * Math.PI) / 180
    const A = cc * Math.cos(rad)
    const B = cc * Math.sin(rad)
    const l_ = l + 0.3963377774 * A + 0.2158037573 * B
    const m_ = l - 0.1055613458 * A - 0.0638541728 * B
    const s_ = l - 0.0894841775 * A - 1.291485548 * B
    const L = l_ * l_ * l_
    const M = m_ * m_ * m_
    const S = s_ * s_ * s_
    const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S
    const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S
    const b = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
    const e = -0.0005
    return r >= e && g >= e && b >= e && r <= 1.0005 && g <= 1.0005 && b <= 1.0005
  }
  if (fits(hi)) return toHex(oklchToRgb({ l, c: hi, h }))
  // 12 halvings puts the answer inside 1/4096 of the chroma range, which is far below a
  // step anything can show at 8 bits per channel.
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return toHex(oklchToRgb({ l, c: lo, h }))
}

// ---------------------------------------------------------------------------------
// Contrast. WCAG's own formula, because the thing being checked is legibility and
// Oklab lightness is not what the guideline is written against.
// ---------------------------------------------------------------------------------

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Black or white, whichever is readable ON this colour.
 *
 * Used for the text of a filled accent button. Picking one and hard-coding it is how a
 * yellow "Save" button ends up with white text on it.
 */
export function onColor(hex: string): string {
  return contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#0b0b0f' : '#ffffff'
}

// ---------------------------------------------------------------------------------
// The palette itself.
// ---------------------------------------------------------------------------------

/**
 * The lightness ladder for the four surfaces, as Oklab L.
 *
 * Every number here was fitted to the palette the app shipped with rather than chosen:
 * #0a0a0d / #101014 / #16161d / #1e1e27 measure L 0.1462 / 0.1749 / 0.2035 / 0.2391, so
 * the steps are 0.0287, 0.0287 and 0.0356 - even, then a wider one for the top layer.
 * Hence the 0, 1, 2, 3.24 multipliers. A config nobody has touched has to draw the app
 * that already exists, or 1600 lines of CSS written against those four greys are all
 * very slightly wrong at once.
 *
 * The curve on `depth` is the other half of that fit. Linear, the shipped value lands at
 * L 0.32 - a mid grey - because a slider whose ends are "black" and "white" spends most
 * of its travel in a range no dark UI uses. `^1.93` is the exponent that puts 0.3 exactly
 * on 0.1462, which buys the whole bottom third of the slider for the themes people
 * actually pick, and still reaches paper white at the top.
 */
const BASE_MIN = 0.06
const BASE_SPAN = 0.88
const BASE_CURVE = 1.93

/** The glass slider, defaulted for a preset or an older config that has no field. */
export function glassAmount(theme: ThemeConfig): number {
  return clamp01(theme.glass ?? DEFAULT_THEME.glass ?? 0.3)
}

/** 0..1 as the two hex digits a `#rrggbbaa` needs. */
function alphaHex(a: number): string {
  return Math.round(clamp01(a) * 255)
    .toString(16)
    .padStart(2, '0')
}

function baseLightness(depth: number): number {
  return BASE_MIN + BASE_SPAN * Math.pow(clamp01(depth), BASE_CURVE)
}

function surfaceLadder(depth: number): number[] {
  const base = baseLightness(depth)
  // Steps shrink as the base rises: at the light end four evenly-spaced surfaces read as
  // banding, at the dark end they read as one flat colour.
  const step = 0.0335 - clamp01(depth) * 0.016
  return [base, base + step, base + step * 2, base + step * 3.24]
}

/**
 * Text lightness and the muted one.
 *
 * Keyed off the resulting BASE rather than off `depth`, because `depth` is a slider
 * position and the thing that decides whether text goes dark is how light the window
 * actually came out.
 */
function textLadder(depth: number): [number, number] {
  return baseLightness(depth) > 0.5 ? [0.26, 0.47] : [0.9445, 0.6813]
}

export type Vars = Record<string, string>

/**
 * Every CSS custom property the app reads, for one theme.
 *
 * Returned as a plain map rather than written to the document so the same function
 * feeds the live window, the Settings preview card and the test - three consumers that
 * must not be able to disagree about what a theme looks like.
 */
export function paletteFor(theme: ThemeConfig): Vars {
  const accent = /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(theme.accent.trim())
    ? theme.accent.trim().startsWith('#')
      ? theme.accent.trim()
      : '#' + theme.accent.trim()
    : DEFAULT_THEME.accent
  const acc = rgbToOklch(parseHex(accent))
  const hue = acc.h
  const tint = clamp01(theme.tint)

  // Chroma of the greys, ramping the way the shipped palette's did (C 0.0064 at the
  // window, 0.0171 by the third surface): a flat tint across all four reads as a colour
  // cast, a rising one reads as depth. 0.045 at full tint is about as far as a surface
  // can lean before it stops being "grey with a warmth to it" and becomes a coloured
  // panel, which is the failure mode of every tint-everything theme engine.
  const grey = 0.045 * tint
  const [bg, s1, s2, s3] = surfaceLadder(theme.depth)
  const light = bg > 0.5
  const [textL, mutedL] = textLadder(theme.depth)
  // The terminal sits a touch deeper than the window it is in; the selection colours below
  // are measured off THIS, not off the window's own background.
  const termL = Math.max(0, bg - 0.012)
  // The selection block, a fixed DISTANCE from the terminal background rather than a
  // constant lightness - see --term-sel below for the depth-0.9 case that proved it.
  /**
   * A selection block is a fixed DISTANCE from the terminal's background, then pushed out
   * of the dead band in the middle.
   *
   * The distance is what makes it visible at all - a constant lightness sat on a 0.84
   * background at 1.15:1 in the middle of the depth slider, a selection nobody could see.
   * The band is the second half: between roughly L 0.52 and 0.68 a chroma-0.1 colour is too
   * light for white text and too dark for black, and neither reaches 4.5:1 (measured at
   * depth 0.5, every hue: 4.35:1 whichever way `onColor` went). Nothing about that is
   * fixable downstream, so the block does not sit there - it steps to the far side, away
   * from the background it has to be distinguishable from.
   */
  const rawSelL = termL > 0.5 ? Math.max(0.28, termL - 0.22) : Math.min(0.8, termL + 0.3)
  const selL =
    rawSelL > 0.52 && rawSelL < 0.68 ? (termL > 0.5 ? 0.5 : 0.7) : rawSelL
  const selHex = inGamut(selL, 0.1, hue)

  // 4 + 10 puts the middle of the slider on the 6px / 9px / 13px the app shipped with.
  const r = 4 + clamp01(theme.round) * 10
  const lineAlpha = light ? ['0d', '1c'] : ['10', '1f']

  return {
    '--bg': inGamut(bg, grey, hue),
    '--surface': inGamut(s1, grey * 1.15, hue),
    '--surface-2': inGamut(s2, grey * 1.4, hue),
    '--surface-3': inGamut(s3, grey * 1.7, hue),
    '--line': (light ? '#000000' : '#ffffff') + lineAlpha[0],
    '--line-strong': (light ? '#000000' : '#ffffff') + lineAlpha[1],
    /**
     * The three values a "glass" control is made of, and there is no fourth: this app
     * declares no `backdrop-filter` anywhere (`scripts/overlay-filter-test.mjs` refuses
     * one, because a live xterm WebGL canvas as the INPUT to a full-window filter makes
     * the window strobe). So the glass here is OPTICAL and costs the compositor nothing:
     * a fill that lets the surface under it through, a hairline edge instead of a shadow,
     * and a one-pixel inset highlight along the top that reads as a lit rim.
     *
     * They are alphas on white for a dark theme and on white-then-black for a light one,
     * rather than derived lightnesses, because a control has to sit on FOUR different
     * surfaces (`--bg` through `--surface-3`) and a fixed colour picked against one of
     * them is wrong on the other three. An alpha is right on all four by construction.
     */
    '--glass': (light ? '#ffffff' : '#ffffff') + (light ? '8c' : '0a'),
    '--glass-line': (light ? '#000000' : '#ffffff') + (light ? '14' : '16'),
    '--glass-hi': '#ffffff' + (light ? 'cc' : '12'),
    /**
     * The sidebar's own opaque backing, drawn UNDER the tint above on a glass window and
     * ignored everywhere else. It is `--bg` at the alpha the glass slider did not spend,
     * so 0 glass is the painted sidebar this app has always had and 1 is the bare
     * material. A literal would be wrong on one of the two themes - this is the same
     * derived background the rest of the window sits on.
     */
    '--sidebar-veil': inGamut(bg, grey, hue) + alphaHex(1 - glassAmount(theme)),
    '--text': inGamut(textL, grey * 0.4, hue),
    '--muted': inGamut(mutedL, grey * 1.6, hue),
    '--accent': accent,
    // The accent lifted to a lightness that survives on any of the four surfaces. A
    // preset picked against near-black is illegible on the Paper preset otherwise.
    '--accent-text': inGamut(light ? Math.min(acc.l, 0.55) : Math.max(acc.l, 0.72), acc.c, hue),
    '--accent-dim': accent + (light ? '1f' : '26'),
    '--accent-soft': accent + (light ? '12' : '17'),
    '--accent-on': onColor(accent),
    // Semantic colours are pulled to the accent's chroma but keep their own hue: a green
    // "ok" has to stay green, and an app whose warning colour changes with the theme is
    // an app whose warning colour means nothing.
    // The light number is one value for all four on purpose, and it is 0.54 because that is
    // where the worst of them clears 3:1. Each was picked on its own against the dark
    // window and then reused on Paper, where measuring them found green at 2.92:1 and amber
    // at 2.97:1 - both under the floor for a UI edge, both shipped, and both invisible to
    // whoever picked the colour, exactly like the accent contrast this file already guards.
    // Green is the worst of the four (a light green is barely darker than white however
    // much chroma it has), so it sets the number and the others sit with it.
    '--warn': inGamut(light ? 0.54 : 0.78, 0.15, 78),
    '--danger': inGamut(light ? 0.54 : 0.72, 0.16, 24),
    /**
     * Text ON a filled danger pill - the auto-answer countdown, the `auto` badge.
     *
     * `var(--bg)` was the obvious answer and it is wrong on a light theme: Paper's ground
     * is nearly white and `--danger` at L 0.54 is a medium red, which measured **4.14:1**
     * - under the 4.5:1 floor for the 13px it is drawn at. Dark themes were fine, which is
     * exactly how a light-theme contrast bug ships. Same helper, same reason, as
     * `--accent-on`: ask the contrast question rather than pick a side.
     */
    '--danger-on': onColor(inGamut(light ? 0.54 : 0.72, 0.16, 24)),
    '--ok': inGamut(light ? 0.54 : 0.78, 0.16, 152),
    // Blue is "happening somewhere else, on its own". It exists because green was already
    // spoken for twice - a working pane's dot and a lane whose work is FINISHED - and a
    // release only cares about the difference between those two. It was a literal
    // `#8b9dff` in one CSS rule until now, which is the Slate preset's accent and a weak
    // wash on the Paper one; hue 272 keeps that colour where it was chosen and lets the
    // light themes have a darker one.
    '--info': inGamut(light ? 0.54 : 0.76, 0.14, 272),
    // A diff's two colours are the same green and red as --ok/--danger and deliberately
    // NOT those variables. A diff needs each of them twice: once as a wash behind a whole
    // line, where a colour bright enough to be a status dot makes the code on top of it
    // unreadable, and once in the gutter, where it must still read at 3:1. So the wash is
    // the hue at low chroma with an alpha - alpha rather than a solid colour because the
    // row sits on --surface in one place and --surface-2 in another, and a solid tint
    // would be visibly wrong in one of them on every light theme.
    '--diff-add': inGamut(light ? 0.5 : 0.78, 0.15, 152),
    '--diff-del': inGamut(light ? 0.5 : 0.72, 0.15, 24),
    '--diff-add-bg': inGamut(light ? 0.62 : 0.55, 0.13, 152) + (light ? '2b' : '26'),
    '--diff-del-bg': inGamut(light ? 0.62 : 0.5, 0.13, 24) + (light ? '2b' : '2b'),
    '--r-sm': `${Math.round(r * 0.7)}px`,
    '--r': `${Math.round(r)}px`,
    '--r-lg': `${Math.round(r * 1.45)}px`,
    '--row-pad': theme.density === 'compact' ? '4px 7px' : '7px 9px',
    '--row-gap': theme.density === 'compact' ? '5px' : '9px',
    '--set-gap': theme.density === 'compact' ? '10px' : '15px',
    '--shadow': light
      ? '0 14px 34px #0000002e, 0 2px 6px #00000018'
      : '0 18px 44px #000000a8, 0 2px 8px #0000005c',
    // xterm draws on a canvas and cannot read a CSS variable, so the terminal's own
    // colours are handed over separately - see applyTheme in the renderer.
    '--term-bg': inGamut(termL, grey, hue),
    '--term-fg': inGamut(textL, grey * 0.3, hue),
    '--term-cursor': accent,
    /**
     * A SOLID block, and a foreground to go on it.
     *
     * This was `accent + '3d'` - the accent at 24% alpha - and a 24% wash is not a
     * selection over a TUI. Every agent CLI draws its own colours and its own box rules,
     * so what showed through a quarter-opacity tint was the box: the highlight read as a
     * faint stain that stopped at each frame line and changed shade over every coloured
     * run, which is "the highlight area is a bit bad because of the terminal lines/ui
     * messing with it". Alpha cannot fix that at any value - it is compositing, so the
     * thing underneath is always part of the answer.
     *
     * Solid can. The block is one colour whatever it covers, and `--term-sel-fg` forces
     * the text on it to one colour too (xterm's `selectionForeground`), so a selection
     * over a coloured diff reads exactly like a selection over plain output. Losing the
     * syntax colour inside the highlight is the trade every terminal that does this makes
     * - Terminal.app and iTerm both - and it is the trade that makes the edges sharp.
     *
     * The inactive one is the same block at a lightness that still reads without claiming
     * the eye: a pane that lost focus must not look like a pane with nothing selected,
     * because the selection is still what Ctrl+C will copy.
     */
    /**
     * Measured off the TERMINAL's background, not off a light/dark constant.
     *
     * The first version of this used one lightness per side (0.82 light, 0.42 dark) and
     * failed the middle of the slider silently: at depth 0.9 the window is light but not
     * white, so a 0.82 block sat on a 0.84 background at 1.15:1 - a selection nobody could
     * see, on exactly the presets where a wash had at least tinted something. A selection
     * has to be a fixed DISTANCE from whatever is behind it, which is a subtraction, not a
     * constant. Checked across 70 theme/hue/tint combinations: block vs terminal background
     * never below 1.6:1, text on the block never below 4.5:1.
     */
    '--term-sel': selHex,
    /**
     * MEASURED against the block, never picked from a threshold.
     *
     * Two thresholds were tried and both shipped an unreadable case. "Is the window light"
     * put dark text on a dark block at depth 0.5 (3.85:1), and "is the block's Oklab L
     * above 0.5" still missed at depth 0.9 (3.84:1) - because a chroma-0.1 orange at L 0.62
     * is far brighter in sRGB luminance than its Oklab lightness suggests, and the accent's
     * hue decides how far off that is. `onColor` asks the contrast question directly, which
     * is the same helper `--accent-on` has always used for the same reason.
     */
    '--term-sel-fg': onColor(selHex),
    // The unfocused one is the same block walked most of the way back to the background:
    // still visibly a selection, no longer the brightest thing in a pane nobody is looking
    // at. Derived from `selL` rather than given its own pair of constants, so it cannot
    // drift to the wrong side of the background the way an independent number would.
    '--term-sel-dim': inGamut(selL + (termL - selL) * 0.25, 0.06, hue)
  }
}

/** Merge a preset into a whole ThemeConfig, keeping the parts a preset does not own. */
export function applyPreset(id: string, current: ThemeConfig): ThemeConfig {
  const p = presetById(id)
  if (!p) return current
  return { ...current, ...p.theme, preset: p.id }
}

/**
 * Whether a theme's own accent and text are still readable on it.
 *
 * The Appearance tab shows this rather than refusing the colour: it is the person's
 * window, and "you cannot have that" about a colour is worse than "this will be hard to
 * read". 4.5 is WCAG AA for body text, 3.0 is AA for large text and UI edges.
 */
export interface ThemeAudit {
  textOnBg: number
  mutedOnBg: number
  accentOnBg: number
  ok: boolean
  /** the one sentence to show when it is not */
  warning: string
}

export function auditTheme(theme: ThemeConfig): ThemeAudit {
  const v = paletteFor(theme)
  const textOnBg = contrast(v['--text'], v['--surface'])
  const mutedOnBg = contrast(v['--muted'], v['--surface'])
  const accentOnBg = contrast(v['--accent-text'], v['--surface'])
  const bad: string[] = []
  if (textOnBg < 4.5) bad.push('body text')
  if (mutedOnBg < 3) bad.push('the grey second lines')
  if (accentOnBg < 3) bad.push('anything drawn in the accent')
  return {
    textOnBg,
    mutedOnBg,
    accentOnBg,
    ok: bad.length === 0,
    warning: bad.length ? `Hard to read: ${bad.join(', ')}.` : ''
  }
}
