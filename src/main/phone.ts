/**
 * The phone client: this desk's own UI, served to a browser on this network.
 *
 * The renderer imports nothing from Electron and nothing from Node - it is pure UI over
 * `window.api` - so a phone client is not a second product, it is that object supplied
 * over HTTP (`shared/surface.ts` is the one list, `renderer/src/browserApi.ts` is the
 * other transport). Every call lands in the very handler the window's would, through
 * `ipcTap.ts`. Nothing about a pane moves: the pty, the checkout and the transcript stay
 * on this machine, exactly as in `remote/` - see `docs/design-notes.md`.
 *
 * Decisions worth not re-litigating:
 *
 * - **Server-sent events down, POST up.** No dependency, and the repo has three. A
 *   WebSocket here would mean either a fourth dependency or hand-rolled RFC 6455
 *   framing; SSE reconnects by itself, survives a phone's screen lock, and the one thing
 *   it costs - upstream on a separate request - is a POST we need anyway. Ordering of
 *   `send` calls is preserved by the client, which queues them: a keystroke followed by
 *   a resize must arrive that way round.
 * - **Off until switched on, and a code to get in.** Anything that can type into a pane
 *   can run commands on this machine, so the server does not exist until Settings says
 *   so, and a browser that has not proved the pairing code gets the pairing page and
 *   nothing else - not the UI, not one asset. The code is short because it is typed on a
 *   phone; what stops it being guessed is the lockout (5 tries, then a minute), and the
 *   only thing behind a wrong code is a 40-byte page.
 * - **The cookie is derived, never stored.** `hmac(deviceId, code)`, so a restart does
 *   not sign every phone out and rotating the code in Settings signs all of them out at
 *   once. There is no token file to leak or to keep in step.
 * - **Bytes travel as base64** (`shared/wireJson.ts`): two calls on this surface carry a
 *   Uint8Array and plain JSON silently turns those into `{"0":12,...}`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import type { PhoneState } from '../shared/types'
import { decodeWire, encodeWire } from '../shared/wireJson'

/** How long a phone's cookie is good for. Rotating the code invalidates it sooner. */
const COOKIE_DAYS = 30
/** Wrong codes from one address before it waits. */
const TRY_LIMIT = 5
const LOCK_MS = 60_000
/** A comment down the stream often enough that no proxy or phone calls it dead. */
const KEEPALIVE_MS = 15_000
/** `transcribe` posts a wav. Anything past this is refused rather than buffered. */
const BODY_LIMIT = 24 * 1024 * 1024

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

export interface PhoneDeps {
  /** the built renderer - the same files the window loads */
  staticDir: string
  /** current pairing code, read fresh so a rotation takes effect without a restart */
  code(): string
  /** this device's stable id; with the code it makes the cookie */
  secret(): string
  /** into the real ipcMain.handle body */
  invoke(channel: string, args: unknown[]): Promise<unknown>
  /** into the real ipcMain.on body */
  send(channel: string, args: unknown[]): void
  /** channels a client may reach, which is the app's own surface and nothing else */
  channels: { invoke: string[]; send: string[]; on: string[] }
  /** told whenever the client count or the error changes, for Settings */
  onChange?(): void
}

interface Client {
  res: ServerResponse
  alive: boolean
}

export class PhoneServer {
  private server: Server | null = null
  private clients = new Set<Client>()
  private tries = new Map<string, { n: number; until: number }>()
  private keepalive: NodeJS.Timeout | null = null
  private lastError = ''
  private listening = 0

  constructor(private deps: PhoneDeps) {}

  /** Start answering. Resolves once the port is really bound, or with `error` set. */
  async start(port: number, bind = '0.0.0.0'): Promise<PhoneState> {
    await this.stop()
    this.lastError = ''
    const server = createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.plain(res, 500, String(err instanceof Error ? err.message : err))
      })
    })
    // A phone that locks its screen leaves a half-open socket; without this they pile up.
    server.keepAliveTimeout = 120_000
    server.headersTimeout = 125_000
    await new Promise<void>((resolve) => {
      server.once('error', (err: Error) => {
        this.lastError = err.message
        this.server = null
        resolve()
      })
      server.listen(port, bind, () => {
        this.server = server
        this.listening = port
        resolve()
      })
    })
    if (this.server) {
      this.keepalive = setInterval(() => this.tick(), KEEPALIVE_MS)
      // A timer in the main process must never be the reason the app cannot quit.
      this.keepalive.unref?.()
    }
    this.deps.onChange?.()
    return this.state()
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    for (const c of this.clients) {
      c.alive = false
      try {
        c.res.end()
      } catch {
        /* a client that is already gone is the normal case here */
      }
    }
    this.clients.clear()
    const server = this.server
    this.server = null
    this.listening = 0
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // close() waits for live sockets; the SSE ones were just ended, and anything
      // slower must not hold a quit open.
      setTimeout(resolve, 500).unref?.()
    })
    this.deps.onChange?.()
  }

  get running(): boolean {
    return !!this.server
  }

  state(): PhoneState {
    const port = this.listening || 0
    return {
      on: !!this.server,
      port,
      code: this.deps.code(),
      urls: this.server ? phoneUrls(port) : [],
      clients: this.clients.size,
      error: this.lastError || undefined
    }
  }

  /** One of main's own pushes, on its way to every paired browser. */
  broadcast(channel: string, args: unknown[]): void {
    if (!this.clients.size) return
    if (!this.deps.channels.on.includes(channel)) return
    const frame = `data: ${encodeWire({ channel, args })}\n\n`
    for (const c of this.clients) {
      if (!c.alive) continue
      try {
        c.res.write(frame)
      } catch {
        c.alive = false
      }
    }
  }

  private tick(): void {
    for (const c of [...this.clients]) {
      if (!c.alive) {
        this.clients.delete(c)
        continue
      }
      try {
        c.res.write(': ping\n\n')
      } catch {
        c.alive = false
        this.clients.delete(c)
      }
    }
  }

  // ---- request routing -------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/pf/pair' && req.method === 'POST') return await this.pair(req, res)
    if (!this.authed(req)) {
      // Anything under /pf is machinery: say no rather than handing back a page.
      if (path.startsWith('/pf/')) return this.plain(res, 401, 'pair first')
      return this.pairPage(res)
    }
    if (path === '/pf/events') return this.events(res)
    if (path === '/pf/call' && req.method === 'POST') return await this.call(req, res)
    if (path === '/pf/send' && req.method === 'POST') return await this.fire(req, res)
    return this.static(path, res)
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = addressOf(req)
    const lock = this.tries.get(who)
    if (lock && lock.until > Date.now()) return this.plain(res, 429, 'too many tries')
    const body = await readBody(req).catch(() => '')
    let typed = ''
    try {
      typed = String((JSON.parse(body || '{}') as { code?: string }).code ?? '')
    } catch {
      typed = ''
    }
    if (!sameCode(typed, this.deps.code())) {
      const n = (lock?.n ?? 0) + 1
      this.tries.set(who, { n, until: n >= TRY_LIMIT ? Date.now() + LOCK_MS : 0 })
      return this.plain(res, 403, 'wrong code')
    }
    this.tries.delete(who)
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `pf=${this.token()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`
    })
    res.end('{"ok":true}')
  }

  private events(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    const client: Client = { res, alive: true }
    this.clients.add(client)
    res.write('retry: 2000\n\n')
    res.write(`data: ${encodeWire({ channel: 'phone:hello', args: [] })}\n\n`)
    res.on('close', () => {
      client.alive = false
      this.clients.delete(client)
      this.deps.onChange?.()
    })
    this.deps.onChange?.()
  }

  private async call(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const msg = await this.readWire<{ id?: number; channel?: string; args?: unknown[] }>(req, res)
    if (!msg) return
    const { id = 0, channel = '', args = [] } = msg
    if (!this.deps.channels.invoke.includes(channel)) {
      return this.json(res, 400, { id, error: `unknown channel ${channel}` })
    }
    try {
      const value = await this.deps.invoke(channel, args)
      this.json(res, 200, { id, value })
    } catch (err) {
      this.json(res, 200, { id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async fire(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const msg = await this.readWire<{ calls?: { channel: string; args: unknown[] }[] }>(req, res)
    if (!msg) return
    // A batch, because typing is one of these per keystroke and they must stay in order.
    for (const c of msg.calls ?? []) {
      if (!this.deps.channels.send.includes(c.channel)) continue
      try {
        this.deps.send(c.channel, c.args ?? [])
      } catch {
        /* a desktop-only gesture refusing is not the request's failure */
      }
    }
    this.json(res, 200, { ok: true })
  }

  private static(path: string, res: ServerResponse): void {
    const dir = this.deps.staticDir
    if (!existsSync(dir)) {
      return this.plain(res, 503, 'this build has no renderer on disk yet - run npm run build')
    }
    const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(
      /^([/\\])+/,
      ''
    )
    // What stops `/../../secret` is the normalize ABOVE, not this line: the path always
    // starts with `/`, and normalizing an absolute path folds away every `..` that would
    // leave the root - `/assets/../../x` becomes `/x`. Kept as a backstop for the day the
    // input stops being absolute, which is the change that would otherwise open the disk.
    if (rel.startsWith('..' + sep) || rel === '..') return this.plain(res, 403, 'no')
    let file = join(dir, rel)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html')
    if (!existsSync(file)) return this.plain(res, 404, 'not found')
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // The renderer's file names are content-hashed; index.html must not be cached.
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=86400'
    })
    createReadStream(file).pipe(res)
  }

  // ---- plumbing --------------------------------------------------------------

  private token(): string {
    return createHmac('sha256', this.deps.secret()).update(this.deps.code()).digest('hex')
  }

  private authed(req: IncomingMessage): boolean {
    const cookie = /(?:^|;\s*)pf=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')
    if (!cookie) return false
    const a = Buffer.from(cookie[1], 'hex')
    const b = Buffer.from(this.token(), 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async readWire<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
    try {
      const body = await readBody(req)
      return decodeWire(body || '{}') as T
    } catch (err) {
      this.plain(res, 413, err instanceof Error ? err.message : 'bad body')
      return null
    }
  }

  private json(res: ServerResponse, code: number, value: unknown): void {
    const body = encodeWire(value)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  }

  private plain(res: ServerResponse, code: number, text: string): void {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  }

  private pairPage(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAIR_PAGE)
  }
}

/** Addresses a phone on this network can actually type, best first. */
export function phoneUrls(port: number): string[] {
  const out: string[] = []
  for (const [, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      out.push(`http://${net.address}:${port}`)
    }
  }
  // A tailnet address (100.64.0.0/10) reaches the phone off this network too, so it
  // is the one worth reading out first.
  out.sort((a, b) => Number(isTailscale(b)) - Number(isTailscale(a)))
  return out
}

function isTailscale(url: string): boolean {
  const m = /^http:\/\/100\.(\d+)\./.exec(url)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

/** Six characters, no vowels and no lookalikes: it is read off a screen and typed once. */
export function newPhoneCode(): string {
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXZ'
  const bytes = randomBytes(6)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

function sameCode(typed: string, real: string): boolean {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const a = Buffer.from(clean(typed))
  const b = Buffer.from(clean(real))
  if (!b.length || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function addressOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? '?'
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The only thing an unpaired browser is given. Deliberately one file with no assets: it
 * is what the open internet would see if this port were ever exposed, so it holds no
 * hint of what is behind it and nothing that has to be kept in step with the app.
 *
 * **The code may arrive in the URL fragment**, which is what the QR in Settings encodes -
 * `http://<address>:<port>/#<code>` - so a camera does the pairing and nothing is typed.
 * A fragment rather than a query on purpose: a browser never sends it to the server, so
 * the code stays out of the access log, out of any proxy in front of this, and out of the
 * `Referer` of anything the app later loads. The page posts it exactly as a person would,
 * which means the same lockout counts it, and drops it out of the address bar afterwards.
 * A wrong or stale one just falls through to the form rather than dead-ending.
 */
const PAIR_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>PaneForge</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17150f;color:#f3ece0;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
form{width:min(320px,86vw);text-align:center}
h1{font-size:17px;font-weight:600;letter-spacing:.02em;margin:0 0 4px}
p{margin:0 0 22px;opacity:.6;font-size:14px}
input{width:100%;box-sizing:border-box;font:600 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
letter-spacing:.28em;text-align:center;text-transform:uppercase;padding:16px 12px;border-radius:12px;
border:1px solid #3a3327;background:#1f1c14;color:#f3ece0}
input:focus{outline:2px solid #f0a868;outline-offset:1px}
button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;background:#f0a868;
color:#211a10;font:600 16px/1 inherit}
.bad{margin-top:14px;color:#f08a7a;font-size:14px;min-height:20px}
.busy form{visibility:hidden}
.busy #w{display:block}
#w{display:none;position:fixed;inset:0;display:none;place-items:center;font-size:14px;opacity:.7}
.busy #w{display:grid}
</style></head><body><form id=f>
<h1>PaneForge</h1><p>Type the code from Settings &rarr; Phone</p>
<input id=c autocomplete=off autocapitalize=characters spellcheck=false inputmode=text maxlength=8>
<button>Connect</button><div class=bad id=e></div></form><div id=w>Connecting&hellip;</div><script>
var f=document.getElementById('f'),c=document.getElementById('c'),e=document.getElementById('e')
function pair(code){return fetch('/pf/pair',{method:'POST',body:JSON.stringify({code:code})})}
function fail(r){e.textContent=r&&r.status===429?'Too many tries. Wait a minute.':'That code is not right.'
c.value='';c.focus()}
f.onsubmit=function(ev){ev.preventDefault();e.textContent=''
pair(c.value).then(function(r){if(r.ok){location.reload();return}fail(r)})
.catch(function(){e.textContent='No answer from the desk.'})}
var scanned=(location.hash||'').replace(/^#/,'').replace(/[^A-Za-z0-9]/g,'')
if(scanned){document.documentElement.className='busy'
pair(scanned).then(function(r){
if(r.ok){location.replace(location.pathname);return}
document.documentElement.className='';fail(r);c.focus()})
.catch(function(){document.documentElement.className=''
e.textContent='No answer from the desk.'})}else{c.focus()}
</script></body></html>`
