// This device driving another one's panes.
//
// A peer's sessions are mirrored into the local list with their ids namespaced, so
// the rest of the app - the sidebar, the command palette, the pane grid, the
// keyboard shortcuts - treats a pane running on the other machine exactly like one
// running here. Nothing in the renderer knows the difference beyond a badge.
//
// The mirror is deliberately a mirror: the pty, the history file and the working
// copy stay on the device that owns them. Picking work up somewhere else means
// watching and typing from here, not moving the agent.

import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'
import type { AgentInfo } from '../../shared/agents'
import type { Project, RemotePeer, Session, StartSessionRequest } from '../../shared/types'
import { Conn, deriveKey, type Msg, type PeerIdentity } from './wire'
import { OutBuffer } from '../outBuffer'

/** Same cap the local session manager keeps, for the same reason. */
const BUFFER_LIMIT = 400_000
/** Reconnect backoff: quick at first, then out of the way. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** A silent link is a dead link; the ping proves the socket, not the agent. */
const PING_MS = 15_000

export type PeerStatus = 'off' | 'connecting' | 'online' | 'error'

/** Split a namespaced id back into the device and the session it belongs to. */
export function splitId(id: string): { peer: string; local: string } | null {
  if (!id.startsWith('@')) return null
  const cut = id.indexOf('/')
  if (cut < 2) return null
  return { peer: id.slice(1, cut), local: id.slice(cut + 1) }
}

export function joinId(peer: string, local: string): string {
  return `@${peer}/${local}`
}

export class RemoteClient extends EventEmitter {
  status: PeerStatus = 'off'
  error = ''
  /** epoch ms the current connection came up */
  since = 0
  sessions: Session[] = []

  private conn: Conn | null = null
  private socket: Socket | null = null
  private buffers = new Map<string, OutBuffer>()
  private want = false
  private tries = 0
  private timer: NodeJS.Timeout | null = null
  private ping: NodeJS.Timeout | null = null
  private rid = 0
  private pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>()

  constructor(
    public peer: RemotePeer,
    private readonly me: () => PeerIdentity
  ) {
    super()
  }

  get id(): string {
    return this.peer.id
  }

  /** Mirrored sessions, already namespaced and tagged with the device they are on. */
  list(): Session[] {
    return this.sessions
  }

  buffer(localId: string): string {
    return this.buffers.get(localId)?.read() ?? ''
  }

  update(peer: RemotePeer): void {
    const moved = peer.address !== this.peer.address || peer.port !== this.peer.port || peer.code !== this.peer.code
    this.peer = { ...peer, id: this.peer.id }
    // A device that changed address (new Wi-Fi, DHCP) reconnects rather than sitting
    // on a socket to somewhere it no longer is.
    if (moved && this.want) this.reconnect(0)
  }

  connect(): void {
    if (this.want) return
    this.want = true
    this.tries = 0
    this.open()
  }

  disconnect(): void {
    this.want = false
    this.clearTimers()
    this.teardown('off', '')
  }

  send(m: Msg): void {
    this.conn?.send(m)
  }

  /** Request/response for the few calls that answer something (projects, agents, start). */
  ask<T>(m: Msg, ms = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.conn?.ready) return reject(new Error(`${this.peer.name} is not connected`))
      const rid = ++this.rid
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error(`${this.peer.name} did not answer`))
      }, ms)
      this.pending.set(rid, {
        ok: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        no: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.conn.send({ ...m, rid })
    })
  }

  projects(): Promise<Project[]> {
    return this.ask<Project[]>({ t: 'projects' })
  }

  agents(): Promise<AgentInfo[]> {
    return this.ask<AgentInfo[]>({ t: 'agents' })
  }

  async startSession(req: StartSessionRequest): Promise<Session> {
    const s = await this.ask<Session>({ t: 'start', req })
    return this.tag(s)
  }

  // -------------------------------------------------------------------------

  private open(): void {
    this.clearTimers()
    this.setStatus('connecting', '')
    const socket = connect({ host: this.peer.address, port: this.peer.port })
    this.socket = socket
    socket.setTimeout(12_000, () => socket.destroy(new Error('No answer from that device')))
    socket.once('connect', () => {
      socket.setTimeout(0)
      void this.handshake(socket)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      this.teardown('error', friendly(err, this.peer))
      this.retry()
    })
  }

  private async handshake(socket: Socket): Promise<void> {
    const conn = new Conn(socket, this.me())
    try {
      await conn.connect(await deriveKey(this.peer.code))
    } catch (err) {
      const why = (err as Error).message
      conn.close()
      this.teardown('error', why)
      // A wrong code or a version mismatch will not become right by trying again, and
      // a client that hammers a listener every few seconds forever is how a typo turns
      // into a background process knocking on a port all day. Anything else - the
      // device asleep, the network away - is worth waiting for.
      if (fatal(why)) this.want = false
      else this.retry()
      return
    }
    if (!this.want) return conn.close()
    this.conn = conn
    this.tries = 0
    this.since = Date.now()
    // The id in the config was a guess until now (typed in, or read off a broadcast);
    // the handshake is the first time the device has actually said who it is.
    if (conn.peer.id && conn.peer.id !== this.peer.id) this.emit('identified', conn.peer)
    conn.on('msg', (m: Msg) => this.receive(m))
    conn.on('gone', (why: string) => {
      for (const p of this.pending.values()) p.no(new Error('Connection lost'))
      this.pending.clear()
      if (!this.want) return
      this.teardown('error', why === 'closed' ? 'That device went away' : why)
      this.retry()
    })
    this.ping = setInterval(() => conn.send({ t: 'ping' }), PING_MS)
    this.ping.unref()
    this.setStatus('online', '')
  }

  private receive(m: Msg): void {
    switch (m.t) {
      case 'sessions': {
        const list = (m.list as Session[]) ?? []
        this.sessions = list.map((s) => this.tag(s))
        // Everything visible is attached: the renderer keeps every pane mounted, so
        // "only stream what is on screen" would mean streaming all of them anyway.
        for (const s of list) this.attach(s.id)
        for (const id of [...this.buffers.keys()]) {
          if (!list.some((s) => s.id === id)) this.buffers.delete(id)
        }
        this.emit('sessions')
        return
      }
      case 'data': {
        const id = String(m.id ?? '')
        const data = String(m.data ?? '')
        // Same O(chunk) append the local sessions use: a mirrored pane streams exactly
        // as hard as a local one, and rebuilding the whole 400 KB tail per chunk here
        // cost the same as it did there.
        let buf = this.buffers.get(id)
        if (!buf) this.buffers.set(id, (buf = new OutBuffer(BUFFER_LIMIT)))
        buf.push(data)
        this.emit('data', joinId(this.peer.id, id), data)
        return
      }
      case 'buffer': {
        const id = String(m.id ?? '')
        this.buffers.set(id, new OutBuffer(BUFFER_LIMIT))
        this.buffers.get(id)!.push(String(m.data ?? '').slice(-BUFFER_LIMIT))
        // A reconnect replaces the scrollback wholesale, so the pane has to redraw
        // from it rather than append to what it already had.
        this.emit('reset', joinId(this.peer.id, id))
        return
      }
      case 'attention':
        this.emit('attention', this.tag(m.session as Session))
        return
      case 'started':
        this.settle(m, m.session)
        return
      case 'projects':
        this.settle(m, m.list)
        return
      case 'agents':
        this.settle(m, m.list)
        return
      case 'failed': {
        const p = this.pending.get(Number(m.rid));
        if (p) {
          this.pending.delete(Number(m.rid))
          p.no(new Error(String(m.error ?? 'That device refused')))
        }
        return
      }
      default:
        return
    }
  }

  private settle(m: Msg, value: unknown): void {
    const rid = Number(m.rid ?? 0)
    const p = this.pending.get(rid)
    if (!p) return
    this.pending.delete(rid)
    p.ok(value)
  }

  private attach(localId: string): void {
    if (this.buffers.has(localId)) return
    this.buffers.set(localId, new OutBuffer(BUFFER_LIMIT))
    this.conn?.send({ t: 'attach', id: localId })
  }

  /** Stamp the device onto a session and namespace its id. */
  private tag(s: Session): Session {
    return {
      ...s,
      id: joinId(this.peer.id, s.id),
      remote: { device: this.peer.id, name: this.peer.name }
    }
  }

  private setStatus(status: PeerStatus, error: string): void {
    if (this.status === status && this.error === error) return
    this.status = status
    this.error = error
    this.emit('status')
  }

  private teardown(status: PeerStatus, error: string): void {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    this.conn?.close()
    this.conn = null
    try {
      this.socket?.destroy()
    } catch {
      /* already gone */
    }
    this.socket = null
    this.since = 0
    if (this.sessions.length) {
      this.sessions = []
      this.buffers.clear()
      this.emit('sessions')
    }
    this.setStatus(status, error)
  }

  private retry(): void {
    if (!this.want) return
    this.reconnect(BACKOFF_MS[Math.min(this.tries++, BACKOFF_MS.length - 1)])
  }

  private reconnect(delay: number): void {
    this.clearTimers()
    this.timer = setTimeout(() => this.open(), delay)
    this.timer.unref()
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** Failures that retrying cannot fix: the pairing itself is wrong. */
function fatal(why: string): boolean {
  return /pairing code|protocol|prove it holds|not a paneforge/i.test(why)
}

/** Socket errors are unreadable; these are the three that actually happen. */
function friendly(err: NodeJS.ErrnoException, peer: RemotePeer): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${peer.address}:${peer.port}. Turn on "Let my other devices connect" over there.`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${peer.address} is not reachable from this network.`
    case 'ETIMEDOUT':
      return `${peer.address} did not answer. A firewall is the usual reason.`
    case 'ENOTFOUND':
      return `No device called ${peer.address}.`
    default:
      return err.message
  }
}
