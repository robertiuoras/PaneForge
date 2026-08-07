/**
 * A QR code, with no dependency and nothing downloaded.
 *
 * Pairing a phone has always been six characters read off this screen and typed on that
 * one. That is small, but it is the only typing left in the product, and it is done in the
 * worst place to type: a phone held in the other hand, on an on-screen keyboard, from a
 * screen a metre away. A camera does it in one gesture and cannot mistype.
 *
 * The alternatives were considered and rejected in `docs/design-notes.md`: OAuth and email
 * both move the secret through a third party and off this network, to remove six keystrokes
 * from a link that is otherwise entirely local. A QR keeps the secret in the room.
 *
 * Scope is deliberately narrow, and that is what keeps this under 300 lines: **byte mode,
 * error level M, versions 1 to 6**. The longest thing this app will ever encode is
 * `http://255.255.255.255:65535/#ABCDEF`, 36 bytes, and version 5 holds 84. Stopping at 6
 * also stops before version 7, which is where a QR starts carrying a second version block
 * of its own - a whole extra table and BCH code for capacity nothing here will ask for.
 * `qr()` throws rather than truncating: a QR that encodes half an address is worse than no
 * QR at all, because it scans.
 */

/** Dark modules of a finished symbol, `[row][col]`. */
export interface QrCode {
  size: number
  modules: boolean[][]
}

/** Per version, at error level M: total codewords, EC codewords per block, block count. */
const VERSIONS: Record<number, { total: number; ec: number; blocks: number }> = {
  1: { total: 26, ec: 10, blocks: 1 },
  2: { total: 44, ec: 16, blocks: 1 },
  3: { total: 70, ec: 26, blocks: 1 },
  4: { total: 100, ec: 18, blocks: 2 },
  5: { total: 134, ec: 24, blocks: 2 },
  6: { total: 172, ec: 16, blocks: 4 }
}

/** Centres of the alignment patterns. Version 1 has none; 2 to 6 have exactly one. */
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34]
}

const MAX_VERSION = 6

/** Data codewords a version holds, which is everything that is not error correction. */
function dataCodewords(v: number): number {
  const { total, ec, blocks } = VERSIONS[v]
  return total - ec * blocks
}

/** Bytes a version holds in byte mode: 4 bits of mode and 8 of length come off the top. */
export function qrCapacity(v: number): number {
  return Math.floor((dataCodewords(v) * 8 - 12) / 8)
}

// ---- GF(256), the field the error correction lives in ------------------------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    // The QR primitive polynomial, x^8 + x^4 + x^3 + x^2 + 1.
    x = x << 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

/**
 * The generator polynomial for `degree` error-correction codewords, highest power first.
 *
 * Multiplying by `(x + a^i)` moves a term UP a power, so `poly[j]` lands at `next[j]` and
 * its `a^i` copy at `next[j + 1]`. Writing those two the other way round builds the whole
 * polynomial reversed, and a reversed generator is the worst kind of wrong here: every
 * symbol still has the right size, the right patterns and the right data modules, so it
 * looks perfect and no scanner in the world reads it.
 */
function generator(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * Remainder of `data` divided by the generator - the EC codewords, in order.
 *
 * Exported for `scripts/qr-test.mjs` alone, and worth the export: it is the one piece of
 * this file whose answer can be pinned against a symbol made by somebody else's encoder
 * without also agreeing about padding, which encoders differ on harmlessly.
 */
export function qrEcCodewords(data: number[], degree: number): number[] {
  return ecFor(data, degree)
}

function ecFor(data: number[], degree: number): number[] {
  const gen = generator(degree)
  const rem = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor)
  }
  return rem
}

// ---- encoding ----------------------------------------------------------------

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

/** Smallest version that holds these bytes, or 0 if none of ours does. */
function versionFor(len: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) if (qrCapacity(v) >= len) return v
  return 0
}

/** Header, payload, terminator and the alternating pad, as whole codewords. */
function codewordsFor(bytes: number[], version: number): number[] {
  const bits: number[] = []
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, 8) // versions 1-9 count the length in 8 bits
  for (const b of bytes) push(b, 8)

  const capacity = dataCodewords(version) * 8
  // The terminator is up to four zeroes, and simply stops if there is no room for them.
  push(0, Math.min(4, capacity - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    out.push(byte)
  }
  // Pad bytes are specified: these two, alternating, for ever.
  for (let i = 0; out.length < dataCodewords(version); i++) out.push(i % 2 === 0 ? 0xec : 0x11)
  return out
}

/**
 * Split into blocks, error-correct each, and interleave.
 *
 * Interleaving is what makes a QR survive a thumb over one corner: a scratch that destroys
 * a run of the symbol takes one or two codewords from every block rather than all of one.
 */
function interleave(data: number[], version: number): number[] {
  const { ec, blocks } = VERSIONS[version]
  const per = Math.floor(data.length / blocks)
  const long = data.length % blocks // blocks carrying one extra data codeword, at the end
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let at = 0
  for (let b = 0; b < blocks; b++) {
    const size = per + (b >= blocks - long ? 1 : 0)
    const block = data.slice(at, at + size)
    at += size
    dataBlocks.push(block)
    ecBlocks.push(ecFor(block, ec))
  }
  const out: number[] = []
  const widest = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < widest; i++)
    for (const b of dataBlocks) if (i < b.length) out.push(b[i])
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i])
  return out
}

// ---- the symbol --------------------------------------------------------------

type Grid = boolean[][]

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

/** Finders, separators, timing, alignment and the reserved format strips. */
function functionPatterns(version: number): { modules: Grid; fixed: Grid } {
  const size = version * 4 + 17
  const modules = blank(size)
  const fixed = blank(size)
  const set = (row: number, col: number, dark: boolean): void => {
    modules[row][col] = dark
    fixed[row][col] = true
  }

  // Three finders, each with the separator ring that keeps it isolated.
  for (const [r0, c0] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr
        const c = c0 + dc
        if (r < 0 || c < 0 || r >= size || c >= size) continue
        const edge = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
        set(r, c, edge !== 2 && edge <= 3)
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  const centres = ALIGN[version]
  for (const r0 of centres) {
    for (const c0 of centres) {
      // The three that would sit on a finder are not drawn.
      if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6))
        continue
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++)
          set(r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
    }
  }

  // Reserved for the format information, written after a mask has been chosen.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) fixed[8][i] = true
    if (i !== 6) fixed[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    fixed[8][size - 1 - i] = true
    fixed[size - 1 - i][8] = true
  }
  set(size - 8, 8, true) // the module that is always dark

  return { modules, fixed }
}

/** Zig-zag up and down column pairs from the right, skipping the vertical timing line. */
function placeData(modules: Grid, fixed: Grid, codes: number[]): void {
  const size = modules.length
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (fixed[row][col]) continue
        if (bit >= codes.length * 8) continue
        modules[row][col] = ((codes[bit >>> 3] >> (7 - (bit & 7))) & 1) === 1
        bit++
      }
    }
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

/** The four penalties from the specification, added up. Lower wins. */
function penalty(modules: Grid): number {
  const size = modules.length
  let score = 0

  const run = (get: (a: number, b: number) => boolean): void => {
    for (let a = 0; a < size; a++) {
      let count = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          count++
          if (count === 5) score += 3
          else if (count > 5) score += 1
        } else count = 1
      }
    }
  }
  run((r, c) => modules[r][c])
  run((c, r) => modules[r][c])

  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c]
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1])
        score += 3
    }

  // The finder-lookalike, 1:1:3:1:1 with four light modules on one side or the other.
  const A = [true, false, true, true, true, false, true, false, false, false, false]
  const B = [false, false, false, false, true, false, true, true, true, false, true]
  const window = (get: (i: number) => boolean, start: number, pattern: boolean[]): boolean => {
    for (let i = 0; i < pattern.length; i++) if (get(start + i) !== pattern[i]) return false
    return true
  }
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      const row = (i: number): boolean => modules[a][i]
      const col = (i: number): boolean => modules[i][a]
      if (window(row, b, A) || window(row, b, B)) score += 40
      if (window(col, b, A) || window(col, b, B)) score += 40
    }
  }

  let dark = 0
  for (const row of modules) for (const m of row) if (m) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/** 15 bits of format information: error level M, the mask, a BCH tail and the fixed XOR. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask
  let rem = data << 10
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  return ((data << 10) | rem) ^ 0x5412
}

function writeFormat(modules: Grid, mask: number): void {
  const size = modules.length
  const bits = formatBits(mask)
  const at = (i: number): boolean => ((bits >> i) & 1) === 1
  for (let i = 0; i <= 5; i++) modules[i][8] = at(i)
  modules[7][8] = at(6)
  modules[8][8] = at(7)
  modules[8][7] = at(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = at(i)
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = at(i)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = at(i)
}

/**
 * Encode `text`. Throws if it does not fit a version 6 symbol - see the header for why
 * that is the right answer here rather than growing the table.
 */
export function qr(text: string, force?: number): QrCode {
  const bytes = utf8(text)
  const version = versionFor(bytes.length)
  if (!version)
    throw new Error(
      `qr: ${bytes.length} bytes does not fit (max ${qrCapacity(MAX_VERSION)} at version ${MAX_VERSION})`
    )
  const codes = interleave(codewordsFor(bytes, version), version)

  let best: Grid | null = null
  let bestScore = Infinity
  // `force` exists for the test, which pins every mask rather than only the one this
  // symbol happens to score best: a placement bug that only shows under mask 5 is
  // otherwise invisible until somebody's address encodes into it.
  for (let mask = force ?? 0; mask <= (force ?? 7); mask++) {
    const { modules, fixed } = functionPatterns(version)
    placeData(modules, fixed, codes)
    for (let r = 0; r < modules.length; r++)
      for (let c = 0; c < modules.length; c++)
        if (!fixed[r][c] && MASKS[mask](r, c)) modules[r][c] = !modules[r][c]
    writeFormat(modules, mask)
    const score = penalty(modules)
    if (score < bestScore) {
      bestScore = score
      best = modules
    }
  }
  return { size: best!.length, modules: best! }
}

/**
 * One SVG path for the dark modules, in a viewBox of `size + 2 * quiet`.
 *
 * A path rather than a rect per module because a version 5 symbol is 1369 of them, and one
 * element that draws in a single fill is both smaller in the DOM and sharper: adjacent
 * rects hairline against each other when the browser scales them.
 */
export function qrPath(code: QrCode, quiet = 2): string {
  const parts: string[] = []
  for (let r = 0; r < code.size; r++) {
    let c = 0
    while (c < code.size) {
      if (!code.modules[r][c]) {
        c++
        continue
      }
      let end = c
      while (end + 1 < code.size && code.modules[r][end + 1]) end++
      parts.push(`M${c + quiet} ${r + quiet}h${end - c + 1}v1h-${end - c + 1}z`)
      c = end + 1
    }
  }
  return parts.join('')
}
