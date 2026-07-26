// The link between two PaneForge installs: framing, pairing and encryption.
//
// A pane's output is a terminal transcript - API keys get pasted into these, agents
// print file contents into these - so the connection is encrypted end to end even
// though it only ever crosses a LAN. The pairing code is the whole secret: it is
// never sent, only proved, and it derives the traffic keys.
//
// Both ends of this run in the Electron MAIN process (Node), which is why there is
// no HTTP or WebSocket anywhere: a plain TCP socket with length-prefixed frames is
// less code, full duplex, and adds no dependency.

import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

/** Bumped when the frame format or the handshake changes shape. */
export const PROTOCOL = 1

/** Refuse anything absurd before allocating for it: this is a network socket. */
const MAX_FRAME = 8 * 1024 * 1024
/** scrypt cost. ~60ms per handshake, which is the point - the code is six characters. */
const SCRYPT = { N: 16384, r: 8, p: 1 }
const SALT = Buffer.from('paneforge-remote-v1')
/** Handshake must finish inside this or the socket is dropped, opened or not. */
const HANDSHAKE_MS = 10_000

/** Who the other end says it is, once the handshake proved it holds the code. */
export interface PeerIdentity {
  id: string
  name: string
  platform: string
  version: string
}

/** Anything either side may put on the wire. Shapes are checked where they land. */
export interface Msg {
  t: string
  [k: string]: unknown
}

/**
 * Turn a pairing code into the 32 bytes everything else hangs off. Async on purpose:
 * scrypt is deliberately slow and this process owns the window message loop, so the
 * sync form would freeze the UI for the length of every connection attempt.
 */
export function deriveKey(code: string): Promise<Buffer> {
  const normalised = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return new Promise((resolve, reject) => {
    scrypt(normalised, SALT, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

function mac(key: Buffer, label: string, ...parts: string[]): Buffer {
  const h = createHmac('sha256', key)
  h.update(label)
  for (const p of parts) h.update(p)
  return h.digest()
}

function sameSecret(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * An authenticated, encrypted message channel over one socket.
 *
 * Frames are `uint32 length` + body. Before the handshake finishes the body is plain
 * JSON (there is no key yet); afterwards it is AES-256-GCM with a per-direction key
 * and a counter nonce, so a replayed or reordered frame fails to open.
 */
export class Conn extends EventEmitter {
  peer: PeerIdentity = { id: '', name: '', platform: '', version: '' }
  /** Set once the handshake succeeded; `send` before that is a programming error. */
  ready = false

  private buf: Buffer = Buffer.alloc(0)
  private waiters: ((m: Msg) => void)[] = []
  /**
   * Frames that have arrived but not been consumed yet, kept as raw bodies.
   *
   * They cannot be decoded on arrival. The last handshake frame and the first real
   * one routinely land in a single TCP segment, and the first real one is already
   * encrypted while the keys are still a microtask away - decoding eagerly read
   * ciphertext as JSON, called the connection corrupt and destroyed it a fraction of
   * a second after it came up. Whether it happened at all depended on how the kernel
   * split the packets, which made it look like a flaky network rather than a bug.
   */
  private queued: Buffer[] = []
  private txKey: Buffer | null = null
  private rxKey: Buffer | null = null
  private txSeq = 0
  private rxSeq = 0
  private closed = false

  constructor(
    readonly socket: Socket,
    private readonly me: PeerIdentity
  ) {
    super()
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('error', (err: Error) => this.fail(err.message))
    socket.on('close', () => this.fail('closed'))
  }

  /** The address the other end is on, for the "who is connected" list. */
  get address(): string {
    return this.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
  }

  send(msg: Msg): void {
    if (this.closed) return
    try {
      this.write(Buffer.from(JSON.stringify(msg), 'utf8'))
    } catch {
      /* socket died between the check and the write */
    }
  }

  /**
   * `end()` rather than `destroy()`: the last thing written before a close is often
   * the reason for it ("Wrong pairing code"), and destroying the socket throws that
   * frame away. The other end then reports a bare disconnect instead of the sentence
   * that tells the person what to fix.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.end()
      // Backstop for a peer that never answers the FIN.
      const timer = setTimeout(() => this.socket.destroy(), 2000)
      timer.unref?.()
    } catch {
      /* already gone */
    }
  }

  // -------------------------------------------------------------------------
  // Handshake
  //
  // Three frames. The code itself never crosses the wire in either direction:
  // each side proves it can MAC the other's nonce, and the traffic keys fall out
  // of the same secret plus both nonces, so a recorded session cannot be replayed
  // against a later one.

  /** Server side: greet, verify the client's proof, answer with our own. */
  async accept(key: Buffer): Promise<void> {
    const sn = randomBytes(16).toString('hex')
    this.write(Buffer.from(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: sn, ...this.me }), 'utf8'))
    const reply = await this.next(HANDSHAKE_MS)
    const cn = String(reply.nonce ?? '')
    if (reply.t !== 'auth' || reply.v !== PROTOCOL || !cn) throw new Error('Handshake refused')
    const want = mac(key, 'client', sn, cn)
    if (!sameSecret(Buffer.from(String(reply.proof ?? ''), 'hex'), want)) {
      // Said out loud rather than dropped silently: a wrong code is the normal
      // failure here and the person typing it needs to know which one it was.
      this.write(Buffer.from(JSON.stringify({ t: 'denied', error: 'Wrong pairing code' }), 'utf8'))
      throw new Error('Wrong pairing code')
    }
    this.peer = identityOf(reply)
    this.write(
      Buffer.from(JSON.stringify({ t: 'ok', proof: mac(key, 'host', cn, sn).toString('hex') }), 'utf8')
    )
    this.arm(key, sn, cn, 'host')
  }

  /** Client side: prove we hold the code, then check the answer proves they do too. */
  async connect(key: Buffer): Promise<void> {
    const hello = await this.next(HANDSHAKE_MS)
    if (hello.t !== 'hello') throw new Error('Not a PaneForge device')
    if (hello.v !== PROTOCOL) throw new Error(`That device speaks protocol ${hello.v}, this one speaks ${PROTOCOL}`)
    const sn = String(hello.nonce ?? '')
    if (!sn) throw new Error('Not a PaneForge device')
    this.peer = identityOf(hello)
    const cn = randomBytes(16).toString('hex')
    this.write(
      Buffer.from(
        JSON.stringify({
          t: 'auth',
          v: PROTOCOL,
          nonce: cn,
          proof: mac(key, 'client', sn, cn).toString('hex'),
          ...this.me
        }),
        'utf8'
      )
    )
    const ok = await this.next(HANDSHAKE_MS)
    if (ok.t !== 'ok') throw new Error(String(ok.error ?? 'Refused by that device'))
    if (!sameSecret(Buffer.from(String(ok.proof ?? ''), 'hex'), mac(key, 'host', cn, sn))) {
      // The host failed to prove it holds the code, so something is answering on
      // that address that is not the device you paired with.
      throw new Error('That device could not prove it holds the code')
    }
    this.arm(key, sn, cn, 'client')
  }

  private arm(key: Buffer, sn: string, cn: string, role: 'host' | 'client'): void {
    const c2s = mac(key, 'c2s', sn, cn)
    const s2c = mac(key, 's2c', sn, cn)
    this.txKey = role === 'host' ? s2c : c2s
    this.rxKey = role === 'host' ? c2s : s2c
    this.ready = true
    // Anything already queued is decoded now that the keys exist, and emitted on the
    // next tick rather than this one: `arm()` runs *inside* the promise the caller is
    // awaiting, so the caller attaches its 'msg' listener a microtask later and
    // anything emitted before that lands on nobody. setImmediate is after every
    // microtask; queueMicrotask would still be too early.
    setImmediate(() => this.drain())
  }

  /** Emit queued frames in arrival order. Order matters: the nonce is a counter. */
  private drain(): void {
    while (this.queued.length) {
      const raw = this.queued.shift() as Buffer
      let msg: Msg
      try {
        msg = this.decode(raw)
      } catch {
        return this.fail('Bad frame')
      }
      this.emit('msg', msg)
    }
  }

  // -------------------------------------------------------------------------
  // Framing

  private write(body: Buffer): void {
    let payload = body
    if (this.txKey) {
      const nonce = counter(this.txSeq++)
      const c = createCipheriv('aes-256-gcm', this.txKey, nonce)
      payload = Buffer.concat([c.update(body), c.final(), c.getAuthTag()])
    }
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(payload.length, 0)
    this.socket.write(Buffer.concat([head, payload]))
  }

  private feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.buf.length < 4) return
      const len = this.buf.readUInt32BE(0)
      if (len > MAX_FRAME) return this.fail('Frame too large')
      if (this.buf.length < 4 + len) return
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      // Decoded where it is consumed, never here: see `queued`. A frame handed to a
      // waiter is part of the handshake and still plaintext; one that has to wait is
      // decoded when the keys for it are known to be in place.
      const waiter = this.waiters.shift()
      if (!waiter) {
        // Queue while there is anything ahead of it, or the counter nonces desync.
        this.queued.push(body)
        if (this.ready && this.queued.length === 1) this.drain()
        continue
      }
      let msg: Msg
      try {
        msg = this.decode(body)
      } catch {
        return this.fail('Bad frame')
      }
      waiter(msg)
    }
  }

  /** One frame's bytes to a message: decrypt if armed, parse, sanity-check. */
  private decode(body: Buffer): Msg {
    const msg = JSON.parse(this.plain(body).toString('utf8')) as Msg
    if (!msg || typeof msg.t !== 'string') throw new Error('bad frame')
    return msg
  }

  private plain(body: Buffer): Buffer {
    if (!this.rxKey) return body
    if (body.length < 17) throw new Error('short frame')
    const tag = body.subarray(body.length - 16)
    const d = createDecipheriv('aes-256-gcm', this.rxKey, counter(this.rxSeq++))
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  }

  private next(ms: number): Promise<Msg> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const hand = (m: Msg): void => {
        if (timer) clearTimeout(timer)
        if (m.t === 'denied') reject(new Error(String(m.error ?? 'Refused')))
        else resolve(m)
      }
      // Both sides derive their key from the pairing code before saying anything, and
      // scrypt is deliberately slow, so the other end's first frame routinely lands
      // while this one is still busy with it. Taking the already-arrived frame is not
      // an optimisation: waiting only for the NEXT one meant a handshake whose greeting
      // beat the key derivation sat there until the ten second timeout, and whether it
      // did was a race - the same pairing failed and then succeeded on the retry.
      const waiting = this.queued.shift()
      if (waiting) {
        try {
          return hand(this.decode(waiting))
        } catch {
          return reject(new Error('Bad frame from that device'))
        }
      }
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== hand)
        reject(new Error('No answer from that device'))
      }, ms)
      this.waiters.push(hand)
      if (this.closed) hand({ t: 'denied', error: 'Connection closed' })
    })
  }

  private fail(why: string): void {
    if (this.closed) return
    this.closed = true
    // Wake anything mid-handshake so a dropped socket rejects instead of hanging
    // until the timeout.
    for (const w of this.waiters.splice(0)) w({ t: 'denied', error: why })
    this.emit('gone', why)
    try {
      this.socket.destroy()
    } catch {
      /* already gone */
    }
  }
}

/** 12-byte GCM nonce from a per-direction frame counter. Keys are per connection. */
function counter(n: number): Buffer {
  const b = Buffer.alloc(12)
  b.writeUInt32BE(Math.floor(n / 0x100000000), 4)
  b.writeUInt32BE(n >>> 0, 8)
  return b
}

function identityOf(m: Msg): PeerIdentity {
  return {
    id: String(m.id ?? ''),
    name: String(m.name ?? 'Unknown device').slice(0, 40),
    platform: String(m.platform ?? ''),
    version: String(m.version ?? '')
  }
}

/**
 * Codes people read off one screen and type into another, so the alphabet leaves out
 * every pair that looks alike in a UI font (0/O, 1/I/L, 5/S, 8/B).
 */
export function newCode(): string {
  const alphabet = 'ACDEFGHJKMNPQRTUVWXY34679'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-'
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}
