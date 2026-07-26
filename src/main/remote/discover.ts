// Finding the other machine without being told its IP.
//
// A tiny UDP broadcast on one port: a device that is hosting announces itself every
// few seconds and answers a "who is there" query straight away. That is the whole of
// it - no mDNS library, no service registration, nothing that survives the app.
//
// The announcement carries no secret. It says a PaneForge is listening at this
// address and what it is called; connecting to it still needs the pairing code.

import { EventEmitter } from 'node:events'
import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

export const DISCOVERY_PORT = 7312

/** Re-announced this often, so a device that just woke up is visible within seconds. */
const ANNOUNCE_MS = 5_000
/** Dropped from the list after this long without a word. */
export const STALE_MS = 20_000

export interface Beacon {
  id: string
  name: string
  platform: string
  version: string
  /** TCP port its remote server listens on */
  port: number
  /** where the packet came from */
  address: string
  /** epoch ms we last heard from it */
  seen: number
}

interface SelfInfo {
  id: string
  name: string
  platform: string
  version: string
  port: number
  /** false while this device is not accepting connections: query only, never announce */
  hosting: boolean
}

export class Discovery extends EventEmitter {
  private sock: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private seen = new Map<string, Beacon>()

  constructor(private info: SelfInfo) {
    super()
  }

  /** Latest sighting of every other device, freshest first, stale ones dropped. */
  list(): Beacon[] {
    const now = Date.now()
    for (const [id, b] of this.seen) if (now - b.seen > STALE_MS) this.seen.delete(id)
    return [...this.seen.values()].sort((a, b) => b.seen - a.seen)
  }

  update(info: Partial<SelfInfo>): void {
    this.info = { ...this.info, ...info }
  }

  start(): void {
    if (this.sock) return
    // reuseAddr because two PaneForge profiles on one machine (the live app and a
    // `npm run try` copy) both want this port and neither should fail to launch.
    const sock = createSocket({ type: 'udp4', reuseAddr: true })
    this.sock = sock
    sock.on('error', () => this.stop())
    sock.on('message', (buf, rinfo) => this.receive(buf, rinfo.address))
    sock.bind(DISCOVERY_PORT, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* some sandboxes refuse; unicast replies still work */
      }
      this.query()
      this.announce()
    })
    this.timer = setInterval(() => this.announce(), ANNOUNCE_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const sock = this.sock
    this.sock = null
    if (!sock) return
    try {
      sock.close()
    } catch {
      /* already closing */
    }
  }

  /** Ask everyone to speak up now - what the Remote dialog does when it opens. */
  query(): void {
    this.blast({ t: 'pf-who', id: this.info.id })
  }

  private announce(): void {
    if (!this.info.hosting) return
    this.blast(this.beacon())
  }

  private beacon(): Record<string, unknown> {
    return {
      t: 'pf-here',
      id: this.info.id,
      name: this.info.name,
      platform: this.info.platform,
      version: this.info.version,
      port: this.info.port
    }
  }

  private receive(buf: Buffer, address: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(buf.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }
    const id = String(msg.id ?? '')
    // Our own broadcast comes straight back to us on every interface.
    if (!id || id === this.info.id) return
    if (msg.t === 'pf-who') {
      // Answer directly rather than broadcasting again: the asker is right there.
      if (this.info.hosting) this.sendTo(this.beacon(), address, DISCOVERY_PORT)
      return
    }
    if (msg.t !== 'pf-here') return
    const port = Number(msg.port ?? 0)
    if (!port) return
    const before = this.seen.get(id)
    this.seen.set(id, {
      id,
      name: String(msg.name ?? 'Unknown device').slice(0, 40),
      platform: String(msg.platform ?? ''),
      version: String(msg.version ?? ''),
      port,
      address,
      seen: Date.now()
    })
    // Only a device appearing, or moving to a new address, is news worth a redraw.
    if (!before || before.address !== address) this.emit('found', this.seen.get(id))
  }

  private blast(msg: Record<string, unknown>): void {
    for (const addr of broadcastAddresses()) this.sendTo(msg, addr, DISCOVERY_PORT)
  }

  private sendTo(msg: Record<string, unknown>, address: string, port: number): void {
    const sock = this.sock
    if (!sock) return
    const buf = Buffer.from(JSON.stringify(msg), 'utf8')
    try {
      sock.send(buf, port, address, () => {
        /* an unreachable interface is normal - VPNs, disconnected adapters */
      })
    } catch {
      /* socket closed under us */
    }
  }
}

/**
 * Per-subnet broadcast addresses as well as the global one. Windows routes
 * 255.255.255.255 out of exactly one interface, so a machine on both Wi-Fi and
 * Ethernet (or with WSL and Docker adapters, which is most of them) would only ever
 * announce on whichever one won.
 */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      const ip = net.address.split('.').map(Number)
      const mask = net.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'))
    }
  }
  return [...out]
}

/** This machine's LAN addresses, shown so the other device can be pointed at one. */
export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}
