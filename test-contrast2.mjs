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

const bgL = rgbToOklch(parseHex(v['--bg'])).l
const dangerL = rgbToOklch(parseHex(v['--danger'])).l

console.log('Contrast function test:')
console.log('contrast(v["--bg"], v["--danger"]):', contrast(v['--bg'], v['--danger']).toFixed(2))
console.log('contrast(v["--danger"], v["--bg"]):', contrast(v['--danger'], v['--bg']).toFixed(2))

// Manual calculation
const manualContrast = (Math.max(bgL, dangerL) + 0.05) / (Math.min(bgL, dangerL) + 0.05)
console.log('Manual calculation:', manualContrast.toFixed(2))

console.log('\nLightness values:')
console.log('bg L:', bgL.toFixed(3))
console.log('danger L:', dangerL.toFixed(3))

rmSync(work, { recursive: true, force: true })
