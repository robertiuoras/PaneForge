import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = '/Users/robertiuoras/Projects/PaneForge-a'
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
  applyPreset,
  contrast,
  paletteFor,
  rgbToOklch,
  parseHex
} = T

// Test Paper theme
const paper = applyPreset('paper', DEFAULT_THEME)
const v = paletteFor(paper)

console.log('\nPaper theme colors:')
console.log('--bg:', v['--bg'])
console.log('--surface:', v['--surface'])
console.log('--danger:', v['--danger'])
console.log('--text:', v['--text'])

const bgL = rgbToOklch(parseHex(v['--bg'])).l
const dangerL = rgbToOklch(parseHex(v['--danger'])).l
const surfaceL = rgbToOklch(parseHex(v['--surface'])).l

console.log('\nLightness values:')
console.log('--bg lightness:', bgL.toFixed(3))
console.log('--danger lightness:', dangerL.toFixed(3))
console.log('--surface lightness:', surfaceL.toFixed(3))

const contrastBgDanger = contrast(v['--bg'], v['--danger'])
const contrastDangerSurface = contrast(v['--danger'], v['--surface'])

console.log('\nContrast ratios:')
console.log('bg on danger:', contrastBgDanger.toFixed(2), ':1')
console.log('danger on surface:', contrastDangerSurface.toFixed(2), ':1')

console.log('\nAA requirements:')
console.log('Body text (bg on danger) needs >= 4.5, got:', contrastBgDanger.toFixed(2), contrastBgDanger >= 4.5 ? 'PASS' : 'FAIL')
console.log('Semantic color (danger on surface) needs >= 3, got:', contrastDangerSurface.toFixed(2), contrastDangerSurface >= 3 ? 'PASS' : 'FAIL')

rmSync(work, { recursive: true, force: true })
