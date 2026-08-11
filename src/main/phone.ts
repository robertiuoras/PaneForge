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
import { deviceKind, hostOf, originOf } from '../shared/net'
import type { PhoneAsk, PhoneDevice, PhonePeer, PhoneState } from '../shared/types'
import { decodeWire, encodeWire } from '../shared/wireJson'

/**
 * How long a phone's cookie is good for. Effectively permanent: an approved device says
 * "It stays signed in until you sign it out here", and a 30-day silent expiry made that
 * a lie. Revocation is explicit — sign the device out by name, or rotate the code.
 */
const COOKIE_DAYS = 3650
/** Wrong codes from one address before it waits. */
const TRY_LIMIT = 5
const LOCK_MS = 60_000
/** A comment down the stream often enough that no proxy or phone calls it dead. */
const KEEPALIVE_MS = 15_000
/** `transcribe` posts a wav. Anything past this is refused rather than buffered. */
const BODY_LIMIT = 24 * 1024 * 1024
/**
 * How long a request to be let in stands before it expires by itself.
 *
 * Long enough to walk to the desk, short enough that a card nobody answered is gone by
 * the time anybody wonders what it was. The phone polls, so an expiry is visible at both
 * ends rather than being a screen that waits for ever.
 */
const ASK_MS = 120_000
/** Requests one address may raise in ASK_WINDOW_MS. A card is cheap to refuse and
 *  expensive to be shown twenty of. */
const ASK_LIMIT = 5
const ASK_WINDOW_MS = 10 * 60_000

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
  /** devices approved on this desk, with their secrets. Read fresh, same as `code`. */
  devices?(): PhoneDevice[]
  /** a device was approved, or forgotten: persist the new list */
  saveDevices?(list: PhoneDevice[]): void
  /** may a browser ask to be let in, rather than typing the code */
  canAsk?(): boolean
}

interface Client extends PhonePeer {
  res: ServerResponse
  alive: boolean
  /** the approved device this stream belongs to, '' for one that typed the code */
  device: string
}

/** The card's half of a request: everything except the token it is holding for it. */
function askView(a: PhoneAsk & { token?: string }): PhoneAsk {
  const { id, sas, address, kind, origin, at } = a
  return { id, sas, address, kind, origin, at }
}

export class PhoneServer {
  private server: Server | null = null
  private clients = new Set<Client>()
  private tries = new Map<string, { n: number; until: number }>()
  /** the one browser waiting on Approve, plus how it will be answered */
  private asking:
    | (PhoneAsk & { answered: 'yes' | 'no' | null; token: string; ua: string })
    | null = null
  private askTries = new Map<string, { n: number; since: number }>()
  private nextAsk = 1
  private keepalive: NodeJS.Timeout | null = null
  private lastError = ''
  private listening = 0
  private nextPeer = 1

  constructor(private deps: PhoneDeps) {}

  /** Start answering. Resolves once the port is really bound, or with `error` set. */
  async start(port: number, bind = '0.0.0.0'): Promise<Omit<PhoneState, 'tunnel'>> {
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

  /**
   * Everything this server knows. NOT the tunnel: that is a separate child process with a
   * separate switch, and `main/index.ts` merges the two into the one `PhoneState` the
   * panel redraws - so a server that has never heard of cloudflared stays testable on its
   * own, and there is one repaint rather than two.
   */
  state(): Omit<PhoneState, 'tunnel'> {
    const port = this.listening || 0
    const live = new Set([...this.clients].map((c) => c.device).filter(Boolean))
    return {
      on: !!this.server,
      port,
      code: this.deps.code(),
      urls: this.server ? phoneUrls(port) : [],
      clients: this.clients.size,
      peers: [...this.clients].map(({ id, address, kind, origin, since }) => ({
        id,
        address,
        kind,
        origin,
        since
      })),
      // The token never leaves this process, so the view is built by dropping it rather
      // than by remembering not to mention it.
      devices: (this.deps.devices?.() ?? []).map(({ token: _t, ...d }) => ({
        ...d,
        live: live.has(d.id)
      })),
      ask: this.asking && !this.asking.answered ? askView(this.asking) : null,
      asking: this.deps.canAsk?.() ?? true,
      error: this.lastError || undefined
    }
  }

  // ---- being let in without a code ---------------------------------------------

  /**
   * Answer the browser that is waiting. Called from the card on this desk.
   *
   * Approving MINTS the device: a fresh 32-byte token, kept here and set as that
   * browser's cookie when it next polls. That is the difference between this and the
   * pairing code - the code makes one cookie that every phone shares, so it can only be
   * revoked for all of them at once and there is no list of who is in.
   */
  answerAsk(ok: boolean): void {
    const ask = this.asking
    if (!ask || ask.answered) return
    ask.answered = ok ? 'yes' : 'no'
    if (ok) {
      const list = this.deps.devices?.() ?? []
      this.deps.saveDevices?.([
        ...list,
        {
          id: ask.id,
          kind: ask.kind,
          address: ask.address,
          origin: ask.origin,
          at: Date.now(),
          seen: 0,
          token: ask.token
        }
      ])
    }
    this.deps.onChange?.()
  }

  /**
   * Sign one device out - or every one of them, with `*`. Its cookie stops matching at
   * once, because `who()` looks the token up in this list on every single request, and its
   * stream is ended rather than left drawing a desk it is no longer allowed to see.
   */
  forgetDevice(id: string): void {
    const list = this.deps.devices?.() ?? []
    this.deps.saveDevices?.(id === '*' ? [] : list.filter((d) => d.id !== id))
    for (const c of [...this.clients]) {
      if (!c.device || (id !== '*' && c.device !== id)) continue
      c.alive = false
      try {
        c.res.end()
      } catch {
        /* already gone */
      }
      this.clients.delete(c)
    }
    this.deps.onChange?.()
  }

  private async ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(this.deps.canAsk?.() ?? true)) return this.plain(res, 403, 'asking is off')
    const who = addressOf(req)
    const now = Date.now()
    const seen = this.askTries.get(who)
    const win = seen && now - seen.since < ASK_WINDOW_MS ? seen : { n: 0, since: now }
    // An expired request is not a live one: it must not hold the single slot for ever.
    if (this.asking && (this.asking.answered || now - this.asking.at > ASK_MS)) this.asking = null
    if (this.asking) {
      // The same browser asking again gets its own request back rather than a refusal -
      // a reload while waiting is the normal case, not a second device.
      if (this.asking.address === who) return this.json(res, 200, askView(this.asking))
      return this.plain(res, 409, 'another device is already asking')
    }
    if (win.n >= ASK_LIMIT) return this.plain(res, 429, 'too many requests')
    this.askTries.set(who, { n: win.n + 1, since: win.since })
    const ua = String(req.headers['user-agent'] ?? '')
    this.asking = {
      id: `d${now.toString(36)}${this.nextAsk++}`,
      // Four digits, generated HERE and shown in both places. Not a secret: what it
      // proves is that the phone in your hand is the one the card is about.
      sas: String(randomBytes(2).readUInt16BE(0) % 10000).padStart(4, '0'),
      address: who,
      kind: deviceKind(ua),
      origin: originOf(who),
      at: now,
      answered: null,
      token: randomBytes(32).toString('hex'),
      ua
    }
    this.deps.onChange?.()
    this.json(res, 200, askView(this.asking))
  }

  /**
   * "Has it been approved yet?" - polled by the waiting page.
   *
   * The cookie is set HERE rather than when Approve is pressed, because the desk has no
   * way to reach that browser: the request it is waiting on is the only door back.
   */
  private askState(req: IncomingMessage, res: ServerResponse, id: string): void {
    const ask = this.asking
    if (!ask || ask.id !== id) return this.json(res, 200, { state: 'gone' })
    if (Date.now() - ask.at > ASK_MS && !ask.answered) {
      this.asking = null
      this.deps.onChange?.()
      return this.json(res, 200, { state: 'gone' })
    }
    if (ask.answered === 'no') {
      this.asking = null
      this.deps.onChange?.()
      return this.json(res, 200, { state: 'no' })
    }
    if (ask.answered !== 'yes') return this.json(res, 200, { state: 'waiting' })
    // Approved: hand this browser its own cookie and let go of the slot.
    this.asking = null
    this.deps.onChange?.()
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `pf=${ask.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`
    })
    res.end('{"state":"yes"}')
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
    // Both halves of being let in without a code, and both of them before the auth check:
    // a browser that has not been approved yet is exactly who is asking.
    if (path === '/pf/ask' && req.method === 'POST') return await this.ask(req, res)
    if (path === '/pf/ask') return this.askState(req, res, url.searchParams.get('id') ?? '')
    if (!this.authed(req)) {
      // Anything under /pf is machinery: say no rather than handing back a page.
      if (path.startsWith('/pf/')) return this.plain(res, 401, 'pair first')
      return this.pairPage(res)
    }
    if (path === '/pf/events') return this.events(req, res)
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

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    const address = addressOf(req)
    const device = this.who(req)?.device ?? ''
    if (device) {
      // "Last seen" is the stream, not the request: a device that opened the page and
      // walked away is not one that is watching.
      const list = this.deps.devices?.() ?? []
      const now = Date.now()
      this.deps.saveDevices?.(list.map((d) => (d.id === device ? { ...d, seen: now } : d)))
    }
    const client: Client = {
      res,
      alive: true,
      device,
      id: `p${this.nextPeer++}`,
      address,
      kind: deviceKind(req.headers['user-agent'] ?? ''),
      origin: originOf(address),
      since: Date.now()
    }
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
    return this.who(req) !== null
  }

  /**
   * Which device this request is, or null for one that may not be here.
   *
   * Two kinds of cookie are good, and they are the two ways in: the derived one, which is
   * `hmac(deviceId, code)` and identical on every browser that ever typed the code, and a
   * device token minted when somebody pressed Approve. Both are 64 hex characters and
   * both are compared in constant time; the difference is that a token can be taken away
   * from one device without touching the others.
   */
  private who(req: IncomingMessage): { device: string } | null {
    const cookie = /(?:^|;\s*)pf=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')
    if (!cookie) return null
    const got = Buffer.from(cookie[1], 'hex')
    const same = (hex: string): boolean => {
      const want = Buffer.from(hex, 'hex')
      return got.length === want.length && timingSafeEqual(got, want)
    }
    if (same(this.token())) return { device: '' }
    for (const d of this.deps.devices?.() ?? []) if (same(d.token)) return { device: d.id }
    return null
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
export function phoneUrls(port: number, nets = networkInterfaces()): string[] {
  const out: string[] = []
  for (const [, list] of Object.entries(nets)) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      out.push(`http://${net.address}:${port}`)
    }
  }
  // The QR encodes the FIRST of these, and what a phone's camera opens must be an address
  // a plain phone can reach: the LAN. A tailnet address (100.64.0.0/10) answers only for
  // a phone that runs Tailscale itself — leading with it is what made the QR a dead link
  // on every ordinary phone the moment this desk had a tailscale interface up.
  const rank = (u: string): number =>
    originOf(hostOf(u)) === 'this network' ? 0 : isTailscale(u) ? 1 : 2
  out.sort((a, b) => rank(a) - rank(b))
  return out
}

function isTailscale(url: string): boolean {
  const m = /^http:\/\/100\.(\d+)\./.exec(url)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

/**
 * No vowels and no lookalikes: it is read off a screen and typed once.
 *
 * **Six is a LAN number, not a secret.** 27 characters to the sixth is 387 million, which
 * nobody walks through the front door of a private address - the lockout is five tries per
 * address and there is nothing behind a wrong one but a 40-byte page. Put a public https
 * address in front of the same door and that arithmetic changes: attempts come from as
 * many addresses as the attacker likes, the per-address lockout stops counting for them,
 * and 387 million at a thousand a second is about four and a half days for a shell on this
 * machine. So the tunnel lengthens it rather than trusting the lockout - and it costs
 * nothing, because the QR carries the code and nobody types it.
 */
export function newPhoneCode(length = 6): string {
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXZ'
  // rejection-sampled: `% 27` over 256 favours the first 13 letters by about 1.2x, which
  // is a real bias in a secret this short.
  const out: string[] = []
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 243) continue
      out.push(alphabet[b % alphabet.length])
      if (out.length === length) break
    }
  }
  return out.join('')
}

function sameCode(typed: string, real: string): boolean {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const a = Buffer.from(clean(typed))
  const b = Buffer.from(clean(real))
  if (!b.length || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Node hands back an IPv4-mapped IPv6 address (`::ffff:192.168.1.5`) whenever the listener
 * is dual-stack, which is every time it binds `0.0.0.0`. Normalising here rather than at
 * the two call sites matters: this string is BOTH the lockout key and what the panel
 * prints, and the two must be the same address or a phone can be locked out under one
 * spelling and shown under another.
 */
function addressOf(req: IncomingMessage): string {
  const socket = normalise(req.socket.remoteAddress ?? '?')
  // Behind the tunnel EVERY phone arrives from 127.0.0.1: cloudflared holds the TLS
  // connection and re-issues the request locally. Believing the socket there collapses
  // every device on earth into one identity, and this string is the ask slot, the lockout
  // key and the words the panel prints - so a second phone scanning while a first waited
  // was handed the first one's request and its four digits, five scans from anywhere in the
  // world locked the door for ten minutes, and a phone on a train was labelled "this
  // machine", which is the one label that turns the card's internet warning off.
  //
  // The header is believed ONLY from loopback, which is the one hop we put there ourselves.
  // A local process could spoof it, and that grants nothing: it is already inside the trust
  // boundary (it can read the pairing code out of config.json, which is what `pf-ctl` does)
  // and the only thing it could buy is an escape from a rate limit it never had to obey.
  if (!isLoopback(socket)) return socket
  const forwarded =
    header(req, 'cf-connecting-ip') ||
    // The left-most entry of `x-forwarded-for` is the client; the rest are the proxies.
    header(req, 'x-forwarded-for').split(',')[0].trim()
  const claimed = normalise(forwarded)
  // Shape-checked before it is believed: this string is printed in the panel and in the
  // card, and a header is written by whoever sent the request.
  const looksLikeAddress = /^[0-9a-fA-F.:]{3,45}$/.test(claimed)
  return looksLikeAddress && !isLoopback(claimed) ? claimed : socket
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

function normalise(raw: string): string {
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(raw)
  return mapped ? mapped[1] : raw
}

function isLoopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
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
main{width:min(320px,86vw);text-align:center}
h1{font-size:17px;font-weight:600;letter-spacing:.02em;margin:0 0 4px}
p{margin:0 0 22px;opacity:.6;font-size:14px}
input{width:100%;box-sizing:border-box;font:600 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
letter-spacing:.28em;text-align:center;text-transform:uppercase;padding:16px 12px;border-radius:12px;
border:1px solid #3a3327;background:#1f1c14;color:#f3ece0}
input:focus{outline:2px solid #f0a868;outline-offset:1px}
button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;background:#f0a868;
color:#211a10;font:600 16px/1 inherit}
.bad{margin-top:14px;color:#f08a7a;font-size:14px;min-height:20px}
.sas{font:700 44px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;
margin:6px 0 2px;text-indent:.22em}
.dots{display:inline-flex;gap:5px;margin-top:16px}
.dots i{width:6px;height:6px;border-radius:50%;background:#f0a868;opacity:.25;
animation:b 1.2s ease-in-out infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes b{40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.6}}
[hidden]{display:none!important}
</style></head><body>
<main id=wait hidden>
<h1>PaneForge</h1><p id=waitsay>Check this number on the desk, then press Approve there.</p>
<div class=sas id=sas></div>
<div class=dots><i></i><i></i><i></i></div>
<div class=bad id=asked></div>
</main>
<main id=manual hidden><form id=f>
<h1>PaneForge</h1><p>Type the code from Settings &rarr; Devices</p>
<input id=c autocomplete=off autocapitalize=characters spellcheck=false inputmode=text maxlength=16>
<button>Connect</button><div class=bad id=e></div></form></main>
<main id=busy hidden><p>Connecting&hellip;</p></main>
<script>
var el=function(id){return document.getElementById(id)}
var f=el('f'),c=el('c'),e=el('e')
function show(id){['wait','manual','busy'].forEach(function(k){el(k).hidden=k!==id})}
function pair(code){return fetch('/pf/pair',{method:'POST',body:JSON.stringify({code:code})})}
function fail(r){e.textContent=r&&r.status===429?'Too many tries. Wait a minute.':'That code is not right.'
c.value='';c.focus()}
function typeIt(msg){show('manual');if(msg)e.textContent=msg;c.focus()}
f.onsubmit=function(ev){ev.preventDefault();e.textContent=''
pair(c.value).then(function(r){if(r.ok){location.reload();return}fail(r)})
.catch(function(){e.textContent='No answer from the desk.'})}

/* Being let in with nothing typed. The desk raises a card carrying the same four digits
   this page shows; the poll below is the only way back to this browser, so the cookie
   arrives on it rather than on the press. A refusal, an expiry or asking being switched
   off all land on the code form rather than on a dead end. */
function askToGetIn(){show('wait')
fetch('/pf/ask',{method:'POST'}).then(function(r){
if(!r.ok)return typeIt(r.status===429?'Too many requests from here. Wait a few minutes, or type the code.':'')
return r.json().then(function(a){el('sas').textContent=a.sas.slice(0,2)+' '+a.sas.slice(2)
poll(a.id)})}).catch(function(){typeIt('No answer from the desk.')})}
function poll(id){setTimeout(function(){
fetch('/pf/ask?id='+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(s){
if(s.state==='yes'){show('busy');location.replace(location.pathname);return}
if(s.state==='no')return typeIt('That was refused on the desk.')
if(s.state==='gone')return typeIt('That request timed out.')
poll(id)}).catch(function(){poll(id)})},1200)}

var scanned=(location.hash||'').replace(/^#/,'').replace(/[^A-Za-z0-9]/g,'')
if(scanned){show('busy')
pair(scanned).then(function(r){
if(r.ok){location.replace(location.pathname);return}
/* A stale code in an old QR is not a dead end: ask instead. */
askToGetIn()}).catch(function(){typeIt('No answer from the desk.')})}else{askToGetIn()}
</script></body></html>`
