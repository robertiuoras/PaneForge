// Can every word in this window be READ?
//
// `test:theme` proves `paletteFor`: 358 assertions that the eleven derived greys keep
// 4.5:1 body and 3:1 secondary, for every preset and hue. Nothing proved the RENDERED
// components, and the two are different questions - a token can be perfect and the
// component can put it on the wrong surface, name a `var()` that does not exist (which
// never errors: in a `color` it inherits something plausible), or paint a literal it
// picked itself. That is how a navy `New session` button shipped at 1.2:1 against a
// panel it had no business being on.
//
// So this asks the real window, twice, in both themes:
//
//   npm run build && npm run try -- --keep --minimized --remote-debugging-port=9333
//   node scripts/contrast-test.mjs
//   PF_PORT=9334 node scripts/contrast-test.mjs      # a second lane's copy
//
// THE BACKDROP IS SAMPLED, NEVER WALKED. An ancestor walk answers `background-color`
// and skips `background-image`, so white text over a gradient - which this stylesheet
// has twenty of - reports as white on white, or as passing over whatever solid colour
// sits three ancestors up. Both readings are fiction. Instead every glyph in the window
// is made transparent at once (`-webkit-text-fill-color`, which leaves backgrounds,
// borders and layout exactly where they were) and ONE screenshot is taken: that image
// is the backdrop, whatever drew it. Each element's own rect is then sampled out of it
// and the WORST pixel is the one used - the pixel whose luminance is closest to the
// text's, because a gradient that passes at one end and fails at the other fails.
//
// The refusals are the feature:
//   - the terminal is not ours. Everything inside `.xterm` is the agent CLI's own
//     colours over the theme's `--term-bg`, and `paletteFor` already guards that pair.
//   - a glyph with no ink is not text. Zero-alpha colour, `visibility: hidden`, a
//     zero-sized rect and an off-screen rect are all skipped, and so is an element
//     whose text is only whitespace.
//   - LARGE text is 3:1, not 4.5:1, by WCAG's own rule (>=24px, or >=18.66px at 700).
//     An icon-font glyph or a rule drawn with a character is not asserted at body level.
//
// It needs a window, so it is not in `npm test`. It skips out loud, like the other
// window tests.

import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()
const PORT = process.env.PF_PORT ?? '9333'

/* ---------------------------------------------------------------- the link */

let page
for (let i = 0; i < 20; i++) {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    .then((r) => r.json())
    .catch(() => [])
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
  if (page) break
  await new Promise((r) => setTimeout(r, 500))
}
if (!page) {
  console.log(`SKIP: no debuggable window on port ${PORT}.`)
  console.log('  npm run build && npm run try -- --keep --minimized --remote-debugging-port=9333')
  process.exit(0)
}
// Every lane is told to use 9333, so whichever copy started first owns it - and a probe
// that answers from another checkout's build is a fix "verified" against code that was
// never loaded. The renderer's URL is the file it was loaded from, so it says which.
if (!(page.url ?? '').toLowerCase().startsWith(rootUrl)) {
  console.log(`SKIP: port ${PORT} belongs to another checkout's test copy:`)
  console.log(`  ${page.url}`)
  console.log(`  expected a window loaded from ${root}`)
  console.log(`  npm run try -- --keep --minimized --remote-debugging-port=${Number(PORT) + 1}`)
  process.exit(0)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evalIn = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let bad = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ' - ' + detail : ''}`)
  if (!ok) bad++
}

/* ------------------------------------------------------------ png, by hand */

// No dependency: a CDP screenshot is a PNG and node already carries the only hard part.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let off = 8
  let w = 0
  let h = 0
  let depth = 0
  let color = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      color = data[9]
      if (depth !== 8 || (color !== 2 && color !== 6)) throw new Error(`png ${depth}bit type ${color} unsupported`)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const bpp = color === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`png filter ${filter}`)
      cur[x] = v & 0xff
    }
  }
  return { w, h, bpp, px: out }
}

const chan = (v) => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const lum = (r, g, b) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/* ------------------------------------------------------- the walk, in page */

// Returns one record per element that draws its own text, with the colour it draws in
// and the rect to sample the backdrop from. Nothing here reads a background: that is
// what the screenshot is for.
const walkIn = (rootSel) => `(() => {
  const root = ${JSON.stringify(rootSel)} ? document.querySelector(${JSON.stringify(rootSel)}) : document.body
  if (!root) return []
  const out = []
  const seen = new Set()
  const vw = innerWidth, vh = innerHeight
  const walk = (node) => {
    if (!(node instanceof Element)) return
    // The terminal draws the agent's own colours over --term-bg; paletteFor guards that
    // pair, and a CLI's red-on-black is not this app's decision.
    if (node.classList.contains('xterm') || node.closest?.('.xterm')) return
    const cs = getComputedStyle(node)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    const text = [...node.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue)
      .join('')
      .trim()
    if (text) {
      const r = node.getBoundingClientRect()
      const m = /rgba?\\(([^)]+)\\)/.exec(cs.color)
      const p = m ? m[1].split(',').map((s) => parseFloat(s)) : [0, 0, 0, 1]
      // The element's own opacity is not the whole story: a faint chip inside a faded
      // panel is faded twice, and it is the PRODUCT somebody has to read.
      let alpha = (p[3] ?? 1)
      for (let e = node; e && e !== document.documentElement; e = e.parentElement) {
        const o = parseFloat(getComputedStyle(e).opacity)
        if (!Number.isNaN(o)) alpha *= o
      }
      const size = parseFloat(cs.fontSize) || 16
      const weight = parseInt(cs.fontWeight, 10) || 400
      if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && alpha > 0.02) {
        let path = node.tagName.toLowerCase()
        if (node.className && typeof node.className === 'string') path += '.' + node.className.trim().split(/\\s+/).join('.')
        const key = path + '|' + Math.round(r.x) + ',' + Math.round(r.y)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            path,
            text: text.slice(0, 40),
            rgb: [p[0] | 0, p[1] | 0, p[2] | 0],
            alpha,
            size,
            weight,
            rect: { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.width, vw - r.x), h: Math.min(r.height, vh - r.y) }
          })
        }
      }
    }
    for (const c of node.children) walk(c)
    if (node.shadowRoot) for (const c of node.shadowRoot.children) walk(c)
  }
  walk(root)
  return out
})()`

const HIDE_TEXT = `(() => {
  const s = document.createElement('style')
  s.id = '__pf_contrast_hide'
  // color alone is not enough - -webkit-text-fill-color wins over it, and a text-shadow
  // paints ink of its own. Backgrounds, borders and layout are untouched, so the shot is
  // the backdrop this window really draws.
  s.textContent = '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }'
  document.head.appendChild(s)
  return true
})()`
// A MINIMIZED window does not advance animations, and this app opens every panel with
// one (`.overlay { animation: fade }`, `.dialog { animation: pop }`, both keyed from
// `opacity: 0`). So a test copy launched the only way this repo allows - minimized,
// never `--show`, so it cannot steal the desk - reports the dialog's computed opacity as
// 0 and every word inside it as having no ink. It is on screen; the animation is parked
// on its first frame. Killing animation and transition outright puts each element back on
// its BASE value, which is the state it settles at anyway, and makes the sweep the same
// measurement whether the window is minimized, occluded or in front.
const FREEZE = `(() => {
  const s = document.createElement('style')
  s.id = '__pf_contrast_freeze'
  s.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
  document.head.appendChild(s)
  return true
})()`
const UNFREEZE = `(() => { document.getElementById('__pf_contrast_freeze')?.remove(); return true })()`

const SHOW_TEXT = `(() => { document.getElementById('__pf_contrast_hide')?.remove(); return true })()`

async function backdrop() {
  await evalIn(HIDE_TEXT)
  await new Promise((r) => setTimeout(r, 120))
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await evalIn(SHOW_TEXT)
  const img = decodePng(Buffer.from(shot.data, 'base64'))
  const vw = await evalIn('innerWidth')
  return { img, scale: img.w / vw }
}

// The worst pixel under the glyphs, not the average: a gradient that passes at one end
// and fails at the other fails.
function worstUnder(img, scale, rect, textLum) {
  const x0 = Math.max(0, Math.round(rect.x * scale))
  const y0 = Math.max(0, Math.round(rect.y * scale))
  const x1 = Math.min(img.w, Math.round((rect.x + rect.w) * scale))
  const y1 = Math.min(img.h, Math.round((rect.y + rect.h) * scale))
  if (x1 <= x0 || y1 <= y0) return null
  const stepX = Math.max(1, Math.floor((x1 - x0) / 24))
  const stepY = Math.max(1, Math.floor((y1 - y0) / 12))
  let worst = null
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * img.w + x) * img.bpp
      const px = [img.px[i], img.px[i + 1], img.px[i + 2]]
      const l = lum(px[0], px[1], px[2])
      if (worst === null || Math.abs(l - textLum) < Math.abs(worst.l - textLum)) worst = { l, px }
    }
  }
  return worst
}

/* ------------------------------------------------------------- the screens */

// A gate that only ever sees the sidebar is not a gate. Each screen is opened by the
// control a person would press, and a screen that will not open is REPORTED - a silent
// skip is how a surface stops being covered without anybody noticing.
const SCREENS = [
  { id: 'desk', open: null },
  { id: 'settings', open: /settings/i },
  { id: 'devices', open: /device/i },
  { id: 'history', open: /history/i }
]

const openScreen = (re) => `(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 250))
  const re = ${re}
  const hit = [...document.querySelectorAll('button')].find((b) =>
    re.test((b.title || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + b.textContent))
  if (!hit) return { err: 'no control' }
  hit.click()
  await new Promise((r) => setTimeout(r, 900))
  return { ok: !!document.querySelector('.dialog') }
})()`

const closeScreen = `(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  return true
})()`

/* --------------------------------------------------------------- the sweep */

// Both themes, by driving the app's own config rather than by stamping a class: the
// main window has no `data-theme` - every colour is derived from accent + depth and
// written onto :root by applyTheme, so the only honest way to see the light theme is to
// ask for it the way the Settings screen does.
const THEMES = [
  { id: 'dark  (forge, depth 0.30)', theme: { accent: '#f0a868', tint: 0.22, depth: 0.3, round: 0.5 } },
  { id: 'light (paper, depth 0.98)', theme: { accent: '#8a6a3c', tint: 0.1, depth: 0.98, round: 0.4 } }
]

const before = await evalIn('(async () => (await window.api.getConfig()).theme)()')
const setTheme = (t) => evalIn(`(async () => { await window.api.setConfig({ theme: ${JSON.stringify(t)} }); return true })()`)

// Enough sampled text for a pass to mean anything. A window that had not finished
// drawing would otherwise report a clean sweep over nine words.
const MIN_SAMPLES = 40
let total = 0
const failures = []

try {
  for (const t of THEMES) {
    await setTheme(t.theme)
    await new Promise((r) => setTimeout(r, 500))
    for (const s of SCREENS) {
      if (s.open) {
        const r = await evalIn(openScreen(s.open))
        if (r?.err || !r?.ok) {
          check(false, `${t.id} · ${s.id} opens`, r?.err ?? 'no dialog')
          continue
        }
      }
      // A dialog is walked ON ITS OWN. The desk stays drawn behind it, so walking the
      // whole body reports the sidebar's failures once per screen and buries whichever
      // ones belong to the panel that was opened.
      await evalIn(FREEZE)
      const nodes = await evalIn(walkIn(s.open ? '.dialog' : null))
      const { img, scale } = await backdrop()
      let n = 0
      for (const el of nodes) {
        const large = el.size >= 24 || (el.size >= 18.66 && el.weight >= 700)
        const want = large ? 3 : 4.5
        const tl = lum(el.rgb[0], el.rgb[1], el.rgb[2])
        const w = worstUnder(img, scale, el.rect, tl)
        if (!w) continue
        // Text alpha is composited over the pixel it actually sits on, so a 60% muted
        // grey is judged as the colour a person sees rather than as the one in the rule.
        const fg = el.rgb.map((c, i) => c * el.alpha + w.px[i] * (1 - el.alpha))
        const got = ratio(lum(fg[0], fg[1], fg[2]), w.l)
        n++
        total++
        if (got < want) {
          failures.push(
            `${t.id} · ${s.id}  ${got.toFixed(2)}:1 (needs ${want})  ${el.path}  "${el.text}"  ` +
              `text rgb(${el.rgb}) a=${el.alpha.toFixed(2)} on rgb(${w.px})`
          )
        }
      }
      check(n > 0, `${t.id} · ${s.id} has readable text`, `${n} runs sampled`)
      if (s.open) await evalIn(closeScreen)
    }
  }
} finally {
  if (before) await setTheme(before)
  await evalIn(SHOW_TEXT)
  await evalIn(UNFREEZE)
}

check(total >= MIN_SAMPLES, 'the sweep saw the window', `${total} text runs`)
for (const f of failures) check(false, 'contrast', f)
check(failures.length === 0, `every text run reaches its ratio`, `${total - failures.length}/${total}`)

console.log(bad ? `\n${bad} FAILED` : `\nall ok (${total} text runs, both themes)`)
ws.close()
process.exit(bad ? 1 : 0)
