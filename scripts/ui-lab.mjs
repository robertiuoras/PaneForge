// The app tests its own screen with no window on any screen.
//
// Five window suites (view-test, contrast-test, ask-render-test, ask-click-test,
// renderwatch-live) and probe.mjs each carried their own copy of the same ~25-line raw
// CDP block: find the debuggable page on /json/list, skip the shelf page, check the URL
// is this checkout's, open a WebSocket, evaluate by id. This is that block, written
// once, plus the pieces every one of them re-derived on their own (a PNG decoder,
// launching a copy, opening a pane).
//
// The point of `launch({ headless: true })` is that none of this needs `--show` or a
// window on Robert's screen at all: `--headless` (src/main/profile.ts `headlessMode`)
// paints the renderer into an offscreen bitmap Chromium still composites, so
// `screenshot()` returns real pixels with nothing ever shown.
//
//   node scripts/ui-lab.mjs shot --out /tmp/x.png [--selector .dialog] [--width 1280] [--height 800]
//   node scripts/ui-lab.mjs eval "document.title"
//   node scripts/ui-lab.mjs panes

import { spawn, spawnSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()

/* ---------------------------------------------------------------- launching a copy */

// Runs `npm run try` for this checkout and waits until its CDP port answers. Returns the
// child so the caller can `close()` it; `--close` (test-app.mjs) also reaches it by
// checkout, so a caller that forgets to close still gets swept by the next `npm run try`.
export function launch({ headless = true, port = process.env.PF_PORT ?? '9333', keep } = {}) {
  const args = [
    headless ? '--headless' : '--show',
    `--remote-debugging-port=${port}`,
    ...(keep ? ['--keep'] : [])
  ]
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'try.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8'
  })
  if (r.status !== 0) throw new Error(`launch failed: ${r.stdout ?? ''}${r.stderr ?? ''}`)
  return { port }
}

export function closeLaunched() {
  spawnSync(process.execPath, [join(root, 'scripts', 'try.mjs'), '--close'], { cwd: root, stdio: 'ignore' })
}

/* -------------------------------------------------------------------- the CDP link */

// Finds the debuggable page on this checkout's launch, waiting for it to appear. Never
// the `shelf` page, and never another checkout's copy sharing the port by accident - the
// renderer's own URL says which build loaded, so a mismatch is refused with the fix.
export async function page(port = process.env.PF_PORT ?? '9333') {
  let found
  for (let i = 0; i < 20; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    found = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
    if (found) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!found) {
    throw new SkipError(
      `no debuggable window on port ${port}.\n` +
        `  npm run try -- --headless --remote-debugging-port=${port}`
    )
  }
  if (!(found.url ?? '').toLowerCase().startsWith(rootUrl)) {
    throw new SkipError(
      `port ${port} belongs to another checkout's test copy:\n` +
        `  ${found.url}\n  expected a window loaded from ${root}\n` +
        `  npm run try -- --headless --remote-debugging-port=${Number(port) + 1}`
    )
  }
  return found
}

// A page that could not be found is not a failure of the code under test - it means the
// caller never launched a copy, or launched it on another port. Every suite built on this
// module skips out loud the same way the originals did, rather than failing red.
export class SkipError extends Error {}

export class Link {
  constructor(ws) {
    this.ws = ws
    this.pending = new Map()
    this.seq = 0
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    })
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.seq
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }

  // Fires twice and keeps the second. A copy that just repainted composites lazily, so
  // the FIRST frame back is routinely the one before it - `contrast-test.mjs` found this
  // as black-on-black rows that nobody had ever seen. The throwaway shot forces the
  // frame; the one actually read is the one after it.
  async screenshot({ format = 'png', clip } = {}) {
    const params = { format, captureBeyondViewport: false, ...(clip ? { clip } : {}) }
    await this.send('Page.captureScreenshot', params)
    await new Promise((r) => setTimeout(r, 200))
    const shot = await this.send('Page.captureScreenshot', params)
    return Buffer.from(shot.data, 'base64')
  }

  async rect(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent?.trim().slice(0, 200) ?? '' }
    })()`)
  }

  // Device metrics override, not a window resize - the same mechanism
  // `scripts/probe.mjs` and CLAUDE.md's "Checking a layout change" recipe use.
  async resize(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
  }

  async clearResize() {
    await this.send('Emulation.clearDeviceMetricsOverride')
  }

  async click(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)
  }

  async type(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    }
  }

  async openPane({ cwd, agent = 'shell', ...rest } = {}) {
    return this.evaluate(
      `(async () => window.api.startSession(${JSON.stringify({ cwd, agent, ...rest })}))()`
    )
  }

  async panes() {
    return this.evaluate(`(async () => window.api.listSessions())()`)
  }

  close() {
    this.ws.close()
  }
}

export async function connect(port = process.env.PF_PORT ?? '9333') {
  const p = await page(port)
  const ws = new WebSocket(p.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  return new Link(ws)
}

/* ------------------------------------------------------------------- png, by hand */

// No dependency: a CDP screenshot is a PNG and node already carries the only hard part.
// Moved here verbatim from contrast-test.mjs, the first caller.
export function decodePng(buf) {
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

// Every distinct RGB(A) pixel is one colour - a blank composited frame is exactly one
// entry. Used by ui-lab-test.mjs as the "did this screenshot actually paint anything"
// control, and available to any suite that wants the same reading.
export function pixels(buf) {
  const img = decodePng(buf)
  const colours = new Set()
  for (let i = 0; i + img.bpp <= img.px.length; i += img.bpp) {
    colours.add(img.px[i] + ',' + img.px[i + 1] + ',' + img.px[i + 2])
  }
  return { img, distinctColours: colours.size }
}

/* -------------------------------------------------------------------------- CLI */

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = (name, fallback) => {
    const i = rest.indexOf(`--${name}`)
    return i === -1 ? fallback : rest[i + 1]
  }
  const port = arg('port', process.env.PF_PORT ?? '9333')

  if (cmd === 'shot') {
    const link = await connect(port)
    const w = arg('width')
    const h = arg('height')
    if (w || h) await link.resize(Number(w) || 1280, Number(h) || 800)
    const selector = arg('selector')
    let clip
    if (selector) {
      const r = await link.rect(selector)
      if (!r) {
        console.error(`SKIP: no element matches ${selector}`)
        link.close()
        process.exit(0)
      }
      clip = { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 }
    }
    const png = await link.screenshot({ clip })
    if (w || h) await link.clearResize()
    const out = arg('out', join(root, 'tmp', 'ui-lab-shot.png'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, png)
    console.log(`wrote ${out} (${png.length} bytes)`)
    link.close()
    return
  }

  if (cmd === 'eval') {
    const link = await connect(port)
    const result = await link.evaluate(rest.filter((a) => !a.startsWith('--'))[0] ?? rest[0])
    console.log(JSON.stringify(result, null, 2))
    link.close()
    return
  }

  if (cmd === 'panes') {
    const link = await connect(port)
    console.log(JSON.stringify(await link.panes(), null, 2))
    link.close()
    return
  }

  console.log('usage: node scripts/ui-lab.mjs <shot|eval|panes> [--port 9333] ...')
  process.exit(1)
}

// Only when invoked directly, never when imported by a suite.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    if (e instanceof SkipError) {
      console.log(`SKIP: ${e.message}`)
      process.exit(0)
    }
    console.error(e)
    process.exit(1)
  })
}
