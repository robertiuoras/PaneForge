// The browser tab's icon: the bare mark, and nothing behind it.
//
// The bug: the tab showed a white ring around the icon in Chrome and looked right in
// Safari. Nothing was drawing a ring - the page had no `rel=icon` at all, and the icon
// that was reached instead is the PLATED app icon, a dark squircle whose rounded corners
// are transparent. Chrome's tab strip behind those corners is near-white, so at 16px the
// corner reads as a halo; Safari's darker strip hid it.
//
// So the tab gets the panes alone, on transparency. What is pinned here is that the file
// is a real icon (not this server's index.html, which is what a missing /favicon.ico
// returns), that the page asks for it, and that there is no plate left to ring: the
// corners are fully transparent and no pixel is the plate's slate.
//
//   node scripts/favicon-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'src', 'renderer', 'public')

let failed = 0
const ok = (name, cond) => {
  if (cond) return
  failed++
  console.error('FAIL', name)
}

// Generated, not checked in by hand: the script is the source of every icon here. It
// renders into a scratch folder, NOT the checkout: the bytes differ per machine, so a
// render into the repo left five files modified after every `npm test`, and
// `lane.mjs ready` refuses a dirty checkout (2026-09-03).
const scratch = mkdtempSync(join(tmpdir(), 'pf-icon-'))
mkdirSync(join(scratch, 'src', 'renderer', 'public'), { recursive: true })
execFileSync(process.execPath, [join(root, 'scripts', 'make-icon.mjs'), '--root', scratch], { stdio: 'pipe' })
for (const rel of ['icon.png', 'icon.svg', 'build/icon.png', 'src/renderer/public/favicon.ico', 'src/renderer/public/favicon-32.png', 'src/renderer/public/favicon.svg'])
  ok(`make-icon wrote ${rel}`, existsSync(join(scratch, rel)))

// --- the page asks for it -------------------------------------------------------------
const html = readFileSync(join(root, 'src', 'renderer', 'index.html'), 'utf8')
ok('index.html links an svg icon', /<link rel="icon" href="favicon\.svg"/.test(html))
// Not redundant: Chrome asks for /favicon.ico before it has parsed the link tag, and
// phone.ts answers a missing file with index.html - HTML served as an icon.
ok('index.html links an ico fallback', /rel="alternate icon" href="favicon\.ico"/.test(html))

// --- the files are real ---------------------------------------------------------------
for (const f of ['favicon.svg', 'favicon.ico', 'favicon-32.png'])
  ok(`${f} exists`, existsSync(join(pub, f)))

const ico = readFileSync(join(pub, 'favicon.ico'))
ok('ico is an icon directory', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1)
const count = ico.readUInt16LE(4)
ok('ico carries three sizes', count === 3)
for (let i = 0; i < count; i++) {
  const e = 6 + i * 16
  const len = ico.readUInt32LE(e + 8)
  const off = ico.readUInt32LE(e + 12)
  ok(`ico entry ${i} is in the file`, off + len <= ico.length && len > 0)
  ok(`ico entry ${i} is a PNG`, ico.subarray(off, off + 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
}

const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8')
ok('the svg has three panes', (svg.match(/<rect /g) ?? []).length === 3)
// The plate is what caused this. Its slate must not be in the tab's copy at all.
ok('the svg has no plate', !/#18[0-9a-f]{4}|#0b0b0f/i.test(svg))
ok('the svg has no full-bleed rect', !/<rect width="1024"/.test(svg))

// --- and no plate survives in the pixels ----------------------------------------------
/** Decode the one PNG shape make-icon writes: 8-bit RGBA, filter 0 on every row. */
function pixels(file) {
  const buf = readFileSync(file)
  let p = 8
  let size = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const body = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') size = body.readUInt32BE(0)
    if (type === 'IDAT') idat.push(body)
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const from = y * (size * 4 + 1)
    if (raw[from] !== 0) throw new Error('unexpected png filter')
    raw.copy(px, y * size * 4, from + 1, from + 1 + size * 4)
  }
  return { px, size }
}

const { px, size } = pixels(join(pub, 'favicon-32.png'))
const at = (x, y) => {
  const i = (y * size + x) * 4
  return [px[i], px[i + 1], px[i + 2], px[i + 3]]
}

// A corner that is anything but fully transparent is the ring: it is drawn over whatever
// the tab strip is, and the strip is white in Chrome's default theme.
for (const [x, y] of [
  [0, 0],
  [size - 1, 0],
  [0, size - 1],
  [size - 1, size - 1]
])
  ok(`corner ${x},${y} is transparent`, at(x, y)[3] === 0)

let opaque = 0
let dark = 0
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const [r, g, b, a] = at(x, y)
    if (a < 200) continue
    opaque++
    // The plate is #181820 -> #0b0b0f: dark, and blue-ish rather than warm. The mark is
    // ember. Anything opaque and dark means the plate came back.
    if (r < 90 && g < 90 && b < 90) dark++
  }
}
ok('the mark is actually drawn', opaque > size * size * 0.3)
ok('no plate pixels survive', dark === 0)
// Margin: filling the box edge to edge, the three panes touch every side and read as one
// orange square at 16px instead of as a split layout.
let edge = 0
for (let i = 0; i < size; i++) {
  if (at(i, 0)[3] > 0) edge++
  if (at(i, size - 1)[3] > 0) edge++
  if (at(0, i)[3] > 0) edge++
  if (at(size - 1, i)[3] > 0) edge++
}
ok('the mark keeps a margin', edge === 0)

if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('favicon: ok')
