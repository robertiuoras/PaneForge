import { parseHex, luminance, contrast, paletteFor, applyPreset, DEFAULT_THEME } from './src/shared/theme.ts'
import { readFileSync } from 'fs'

console.log('=== ACCENT-DIM CONTRAST VERIFICATION ===\n')

// Test 1: Check if parseHex handles alpha values
console.log('Test 1: parseHex with alpha')
const hexWithAlpha = '#8a6a3c1f'
try {
  const result = parseHex(hexWithAlpha)
  console.log(`  parseHex("${hexWithAlpha}"):`, result)
} catch(e) {
  console.log(`  ERROR: ${e.message}`)
}

// Test 2: Get Paper theme and check values
console.log('\nTest 2: Paper theme colors')
const paper = applyPreset('paper', DEFAULT_THEME)
const v = paletteFor(paper)
console.log(`  --bg: ${v['--bg']}`)
console.log(`  --text: ${v['--text']}`)
console.log(`  --accent: ${v['--accent']}`)
console.log(`  --accent-dim: ${v['--accent-dim']}`)

// Test 3: Measure contrast
console.log('\nTest 3: Contrast measurements on Paper theme')
const textOnAccentDim = contrast(v['--text'], v['--accent-dim'])
console.log(`  contrast(--text, --accent-dim): ${textOnAccentDim.toFixed(3)}:1`)
console.log(`  WCAG AA minimum (4.5:1): ${textOnAccentDim >= 4.5 ? 'PASS' : 'FAIL ⚠️'}`)

// Test 4: Check test coverage
console.log('\nTest 4: Does theme-test.mjs test this?')
const testFile = readFileSync('./scripts/theme-test.mjs', 'utf8')
const hasAccentDimTest = testFile.includes(`'--accent-dim'`) && testFile.includes('contrast')
console.log(`  Specific test for text on --accent-dim: ${hasAccentDimTest ? 'YES' : 'NO ✗'}`)
