// Does the QR we draw actually decode?
//
// This test reads the symbol back the way a scanner does, and it is deliberately written
// against nothing in `qr.ts` except the public `qr()`: it re-derives the function-pattern
// map, pulls the format bits out of the drawn symbol to learn which mask was used, walks
// the modules in the standard zig-zag, de-interleaves the blocks, checks every Reed-Solomon
// syndrome is zero and then reads the payload back out. A symbol that passes all of that is
// a valid QR code carrying the right bytes.
//
// It is written this way because of what the first version of `qr.ts` did. The generator
// polynomial was built in reverse, so every error-correction codeword was wrong - and the
// symbols still had the right size, the right version, the right finders, the right timing
// patterns and the right data modules. They looked perfect on screen, side by side with a
// reference encoder they differed only in the way a different mask would, and not one of
// them could be read by any scanner. Nothing short of decoding catches that.
//
// Deliberately offline: no Python, no camera library, nothing downloaded. The one fixture
// that comes from outside is the block of error-correction codewords for "hi" at version 1,
// which was taken off a symbol produced by an independent encoder - it is the check that
// pins the arithmetic itself rather than only its self-consistency.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-qr-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'qr.cjs')

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/qr.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { qr, qrPath, qrCapacity, qrEcCodewords } = createRequire(import.meta.url)(out)

let checks = 0
let failures = 0
const ok = (cond, what, detail = '') => {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}

// ---- an independent reader ----------------------------------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** total codewords, EC codewords per block, blocks - error level M. */
const VER = {
  1: [26, 10, 1],
  2: [44, 16, 1],
  3: [70, 26, 1],
  4: [100, 18, 2],
  5: [134, 24, 2],
  6: [172, 16, 4]
}
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] }
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

function functionMap(version) {
  const size = version * 4 + 17
  const f = Array.from({ length: size }, () => new Array(size).fill(false))
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ])
    for (let dr = -1; dr <= 7; dr++)
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr
        const c = c0 + dc
        if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = true
      }
  for (let i = 8; i < size - 8; i++) {
    f[6][i] = true
    f[i][6] = true
  }
  for (const r0 of ALIGN[version])
    for (const c0 of ALIGN[version]) {
      if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6))
        continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) f[r0 + dr][c0 + dc] = true
    }
  for (let i = 0; i <= 8; i++) {
    f[8][i] = true
    f[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    f[8][size - 1 - i] = true
    f[size - 1 - i][8] = true
  }
  f[size - 8][8] = true
  return f
}

/** The error level and mask a finished symbol says it used, read off its format strip. */
function readFormat(m) {
  let bits = 0
  const bit = (r, c) => (m[r][c] ? 1 : 0)
  for (let i = 0; i < 6; i++) bits |= bit(i, 8) << i
  bits |= bit(7, 8) << 6
  bits |= bit(8, 8) << 7
  bits |= bit(8, 7) << 8
  for (let i = 9; i < 15; i++) bits |= bit(8, 14 - i) << i
  const data = (bits ^ 0x5412) >> 10
  return { level: (data >> 3) & 3, mask: data & 7 }
}

function readCodewords(m, version, mask) {
  const size = m.length
  const f = functionMap(version)
  const bits = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (f[row][col]) continue
        bits.push((m[row][col] ? 1 : 0) ^ (MASKS[mask](row, col) ? 1 : 0))
      }
  }
  const codes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    codes.push(b)
  }
  return codes
}

/** Zero for a codeword a decoder would accept without correcting anything. */
function syndromesClear(block, ec) {
  for (let i = 0; i < ec; i++) {
    let s = 0
    for (const b of block) s = mul(s, EXP[i]) ^ b
    if (s !== 0) return false
  }
  return true
}

/** Read a drawn symbol the whole way back: `{ text, level, mask, version, clean }`. */
function decode(code) {
  const size = code.size
  const version = (size - 17) / 4
  const [total, ec, blocks] = VER[version]
  const { level, mask } = readFormat(code.modules)
  const codes = readCodewords(code.modules, version, mask).slice(0, total)
  const dataLen = total - ec * blocks
  const per = dataLen / blocks
  const dataBlocks = Array.from({ length: blocks }, () => [])
  const ecBlocks = Array.from({ length: blocks }, () => [])
  let at = 0
  for (let i = 0; i < per; i++) for (let b = 0; b < blocks; b++) dataBlocks[b].push(codes[at++])
  for (let i = 0; i < ec; i++) for (let b = 0; b < blocks; b++) ecBlocks[b].push(codes[at++])
  const clean = dataBlocks.every((d, b) => syndromesClear([...d, ...ecBlocks[b]], ec))

  const stream = dataBlocks.flat()
  const bin = stream.map((c) => c.toString(2).padStart(8, '0')).join('')
  const mode = bin.slice(0, 4)
  const n = parseInt(bin.slice(4, 12), 2)
  const bytes = []
  for (let i = 0; i < n; i++) bytes.push(parseInt(bin.slice(12 + 8 * i, 20 + 8 * i), 2))
  return {
    version,
    level,
    mask,
    clean,
    mode,
    text: new TextDecoder().decode(Uint8Array.from(bytes))
  }
}

// ---- the checks ---------------------------------------------------------------

console.log('qr: encode, then read it back the way a scanner does')

// The arithmetic itself, against a symbol produced by somebody else's encoder. These are
// the sixteen data codewords that encoder put in a version 1 symbol for "hi", and the ten
// error-correction codewords it computed from them. If the generator polynomial is built
// backwards these ten bytes are the only thing here that says so - everything below this
// point is self-consistent with a wrong generator, which is exactly how the first version
// of `qr.ts` shipped a symbol no scanner could read.
//
// Not routed through `qr()` on purpose: encoders differ harmlessly on how much zero padding
// follows the terminator (this one adds a byte we do not), and that difference would make a
// comparison of finished symbols fail for a reason that is not a bug.
{
  const DATA = [0x40, 0x26, 0x86, 0x90, 0x00, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec] // prettier-ignore
  const EC = [0x03, 0xb0, 0xb5, 0x76, 0xa4, 0x51, 0x1c, 0xab, 0x37, 0x64]
  const got = qrEcCodewords(DATA, 10)
  ok(
    JSON.stringify(got) === JSON.stringify(EC),
    'the error correction for "hi" matches an independently produced symbol',
    got.map((c) => c.toString(16).padStart(2, '0')).join(' ')
  )
}

// Real addresses, the thing this exists for.
const REAL = [
  'http://192.168.1.23:7312/#PF2345',
  'http://100.64.12.34:7312/#ABCDEF',
  'http://10.0.0.2:7312/#Q7WXYZ',
  // The longest address this app can produce: every octet and the port at full width.
  'http://255.255.255.255:65535/#ZZZZZZ'
]
for (const text of REAL) {
  const got = decode(qr(text))
  ok(got.text === text, `${text} reads back`, got.text)
  ok(got.clean, `${text} needs no error correction to read`)
  ok(got.level === 0, `${text} says error level M`, String(got.level))
  ok(got.mode === '0100', `${text} says byte mode`, got.mode)
}

// Every version and every mask, so a placement bug that only shows under one of them is
// not waiting for somebody's IP address to land on it.
{
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/.#-_'
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let read = 0
  let total = 0
  const versions = new Set()
  // The byte capacity of each version, and one under it: the boundary is where a padding
  // or terminator mistake shows up.
  for (const len of [1, 2, 13, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106]) {
    for (let k = 0; k < 3; k++) {
      let s = ''
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)]
      for (let mask = 0; mask < 8; mask++) {
        const code = qr(s, mask)
        const got = decode(code)
        versions.add(got.version)
        total++
        if (got.text === s && got.clean && got.mask === mask && got.level === 0) read++
      }
    }
  }
  ok(read === total, 'every version at every mask reads back cleanly', `${read}/${total}`)
  ok(versions.size === 6, 'the sweep really covered versions 1 to 6', [...versions].join(','))
}

// A payload that does not fit refuses rather than encoding half an address: a truncated QR
// is worse than none, because it scans and sends the phone somewhere wrong.
{
  let threw = ''
  try {
    qr('x'.repeat(qrCapacity(6) + 1))
  } catch (err) {
    threw = String(err.message)
  }
  ok(threw.includes('does not fit'), 'an over-long payload throws', threw)
  ok(decode(qr('x'.repeat(qrCapacity(6)))).version === 6, 'the last byte that fits still encodes')
}

// Multi-byte text, because the code is drawn from a config a person can edit.
{
  const text = 'héllo — ünicode ✓'
  ok(decode(qr(text)).text === text, 'utf-8 survives', decode(qr(text)).text)
}

// The path is what actually reaches the screen, so an empty one is a blank QR.
{
  const code = qr('http://192.168.1.23:7312/#PF2345')
  const d = qrPath(code)
  ok(d.startsWith('M') && d.length > 200, 'the svg path draws something', String(d.length))
  const runs = (d.match(/M/g) ?? []).length
  const dark = code.modules.flat().filter(Boolean).length
  ok(runs > 0 && runs < dark, 'horizontal runs are merged rather than one rect per module', `${runs} runs, ${dark} modules`)
  ok(!/NaN|undefined/.test(d), 'no NaN in the path')
}

console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
