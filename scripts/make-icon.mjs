// The PaneForge mark, drawn from arithmetic rather than stored as a blob.
//
// The repo had no icon at all - which is why the app shipped with Electron's generic one
// on both platforms, and why there was nothing to hand Discord for the presence artwork.
// A checked-in PNG would have fixed that once; nobody could then have produced a 512 for
// Discord, a 1024 for the Mac and a 256 for the installer without opening an image editor
// this machine does not have. This script is the source, and the PNGs are its output.
//
// Dependency-free on purpose. There is no ImageMagick here (`convert` on PATH is Windows'
// filesystem tool, not the other one), no sharp, and adding a native image dependency to
// an Electron repo for one square of geometry is a build-time cost paid on every install
// forever. Node ships zlib, PNG is a handful of length-prefixed chunks, and the mark is
// rounded rectangles - so it is all here, in about a hundred lines that any later session
// can read.
//
// Anti-aliasing is 4x supersampling and a box downsample. Not because it is clever, but
// because an icon is judged at 16px in a taskbar, and hard edges scaled down by an integer
// factor are the one thing that reads as amateur at that size.
//
//   node scripts/make-icon.mjs            # writes icon.png, icon.svg, build/icon.png
//   node scripts/make-icon.mjs --size 512 --out foo.png

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- the mark, in fractions of the canvas --------------------------------------------
// Everything below is normalised, so the same numbers draw the 16px favicon and the 1024
// Mac icon. Nothing here is in pixels.
const M = {
  radius: 0.222, // the outer squircle-ish corner, close to what macOS masks to anyway
  inset: 0.235, // where the panes start
  gap: 0.043, // between panes - wide enough to survive a 16px downsample
  paneRadius: 0.032,
  split: 0.415, // left pane's share of the width: a tall editor beside a stacked pair
  // Deep slate, matching the app's own window backgroundColor (#101014) so the icon and
  // the thing it launches are recognisably the same object.
  bgTop: [0x18, 0x18, 0x20],
  bgBottom: [0x0b, 0x0b, 0x0f],
  // Forge heat, top to bottom. The name is half the mark.
  emberTop: [0xff, 0xb2, 0x5e],
  emberBottom: [0xf4, 0x3f, 0x0f]
}

const lerp = (a, b, t) => a + (b - a) * t
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]

/** Signed coverage test for a rounded rectangle: inside is true. */
function inRounded(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/** The three panes, as [x, y, w, h] in canvas fractions. */
function panes() {
  const a = M.inset
  const size = 1 - M.inset * 2
  const leftW = (size - M.gap) * M.split
  const rightW = size - M.gap - leftW
  const halfH = (size - M.gap) / 2
  return [
    [a, a, leftW, size],
    [a + leftW + M.gap, a, rightW, halfH],
    [a + leftW + M.gap, a + halfH + M.gap, rightW, halfH]
  ]
}

function render(size) {
  const SS = 4 // supersample factor
  const n = size * SS
  const cells = panes().map(([x, y, w, h]) => [x * n, y * n, w * n, h * n])
  const rOuter = M.radius * n
  const rPane = M.paneRadius * n
  const px = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x * SS + sx + 0.5
          const fy = y * SS + sy + 0.5
          if (!inRounded(fx, fy, 0, 0, n, n, rOuter)) continue
          const t = fy / n
          let c = mix(M.bgTop, M.bgBottom, t)
          for (const [cx, cy, cw, ch] of cells) {
            if (inRounded(fx, fy, cx, cy, cw, ch, rPane)) {
              c = mix(M.emberTop, M.emberBottom, t)
              break
            }
          }
          r += c[0]
          g += c[1]
          b += c[2]
          a += 255
        }
      }
      const total = SS * SS
      const i = (y * size + x) * 4
      // Un-premultiply against coverage so the rounded corner fades the COLOUR out rather
      // than fading it towards black, which is what a straight average would do and what
      // makes a dark icon look like it has a dirty halo on a light background.
      const cov = a / total / 255
      px[i] = cov > 0 ? Math.round(r / (a / 255)) : 0
      px[i + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0
      px[i + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0
      px[i + 3] = Math.round(cov * 255)
    }
  }
  return px
}

// --- PNG container -------------------------------------------------------------------
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // Every row gets filter byte 0. Real filtering would compress better; an icon is tens of
  // kilobytes either way and a wrong filter is a corrupt file nobody notices until macOS
  // refuses the bundle.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The same geometry as vector, for anywhere a PNG is the wrong answer. */
function svg() {
  const pct = (v) => +(v * 1024).toFixed(1)
  const rects = panes()
    .map(
      ([x, y, w, h]) =>
        `  <rect x="${pct(x)}" y="${pct(y)}" width="${pct(w)}" height="${pct(h)}" rx="${pct(M.paneRadius)}" fill="url(#ember)"/>`
    )
    .join('\n')
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(M.bgTop)}"/>
      <stop offset="1" stop-color="${hex(M.bgBottom)}"/>
    </linearGradient>
    <linearGradient id="ember" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(M.emberTop)}"/>
      <stop offset="1" stop-color="${hex(M.emberBottom)}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="${pct(M.radius)}" fill="url(#bg)"/>
${rects}
</svg>
`
}

const args = process.argv.slice(2)
const sizeArg = args.indexOf('--size')
const outArg = args.indexOf('--out')

if (outArg !== -1) {
  const size = sizeArg === -1 ? 1024 : Number(args[sizeArg + 1])
  writeFileSync(args[outArg + 1], encodePng(render(size), size))
  console.log(`wrote ${args[outArg + 1]} (${size}x${size})`)
} else {
  const png = encodePng(render(1024), 1024)
  // Root, because that is where a person looks for something to drag into a browser -
  // Discord's art assets, a README, a store listing.
  writeFileSync(join(root, 'icon.png'), png)
  writeFileSync(join(root, 'icon.svg'), svg())
  // build/ is electron-builder's default buildResources directory: a 1024 icon.png there
  // is picked up for the Windows .ico and the Mac .icns with no configuration at all.
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'icon.png'), png)
  console.log(`wrote icon.png, icon.svg and build/icon.png (1024x1024, ${png.length} bytes)`)
}
