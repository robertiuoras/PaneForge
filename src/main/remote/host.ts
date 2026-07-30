// This device answering for its own panes.
//
// One TCP listener. A guest that proves it holds the pairing code gets the session
// list, and then whatever it asks to attach to: the scrollback once, live output
// after that, and keystrokes back the other way.
//
// The pty never moves. A pane opened here keeps running here whatever the other
// device does with it - closing the laptop cannot kill an agent mid-turn, and the
// transcript, the history file and the git worktree all stay where the work is.

import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import type { AgentInfo } from '../../shared/agents'
import type { Project, Session, StartSessionRequest, TurnClock } from '../../shared/types'
import { Conn, deriveKey, type Msg, type PeerIdentity } from './wire'

/** Everything the host is allowed to do to this app on a guest's behalf. */
export interface HostBackend {
  list(): Session[]
  buffer(id: string): string
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  redraw(id: string): void
  setBusy(id: string, busy: boolean, tail?: string, clock?: TurnClock): void
  clearAttention(id: string): void
  kill(id: string): void
  restart(id: string): Session | null
  rename(id: string, title: string): void
  switchAgent(id: string, agent: string, model?: string): Session | null
  /**
   * Promise, because a guest's launch goes through the same lane split a local one does
   * and that asks git where the repo is - off the main thread, so the host window keeps
   * drawing while a remote pane is being placed.
   */
  startSession(req: StartSessionRequest): Session | Promise<Session>
  projects(): Promise<Project[]>
  agents(): Promise<AgentInfo[]>
  /** subscribe to pty output; returns an unsubscribe */
  onData(cb: (id: string, data: string) => void): () => void
  onSessions(cb: (sessions: Session[]) => void): () => void
  onAttention(cb: (s: Session) => void): () => void
}

/** A device currently connected to this one, as the Remote dialog lists it. */
export interface Guest {
  id: string
  name: string
  address: string
  since: number
  /** how many of our panes it is watching right now */
  watching: number
}

class GuestConn {
  attached = new Set<string>()
  readonly since = Date.now()
  constructor(readonly conn: Conn) {}
}

export class RemoteHost extends EventEmitter {
  private server: Server | null = null
  private guests = new Set<GuestConn>()
  private unhook: (() => void)[] = []
  /** Why the listener is not up, when it should be. Surfaced in the dialog. */
  error = ''
  port = 0

  constructor(
    private readonly backend: HostBackend,
    private readonly me: () => PeerIdentity,
    private readonly code: () => string
  ) {
    super()
  }

  get listening(): boolean {
    return Boolean(this.server?.listening)
  }

  list(): Guest[] {
    return [...this.guests]
      .filter((g) => g.conn.peer.id)
      .map((g) => ({
        id: g.conn.peer.id,
        name: g.conn.peer.name,
        address: g.conn.address,
        since: g.since,
        watching: g.attached.size
      }))
  }

  start(port: number): void {
    if (this.server) {
      if (this.port === port) return
      this.stop()
    }
    this.error = ''
    this.port = port
    const server = createServer((socket) => void this.greet(socket))
    this.server = server
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.error =
        err.code === 'EADDRINUSE'
          ? `Port ${port} is already taken on this machine. Pick another one.`
          : err.message
      this.server = null
      this.emit('changed')
    })
    server.listen(port, '0.0.0.0', () => {
      this.wire()
      this.emit('changed')
    })
  }

  stop(): void {
    for (const off of this.unhook.splice(0)) off()
    for (const g of this.guests) g.conn.close()
    this.guests.clear()
    const server = this.server
    this.server = null
    if (server) {
      try {
        server.close()
      } catch {
        /* already closing */
      }
    }
    this.emit('changed')
  }

  // -------------------------------------------------------------------------

  private wire(): void {
    if (this.unhook.length) return
    this.unhook.push(
      this.backend.onData((id, data) => {
        for (const g of this.guests) if (g.attached.has(id)) g.conn.send({ t: 'data', id, data })
      })
    )
    this.unhook.push(
      this.backend.onSessions((sessions) => {
        for (const g of this.guests) g.conn.send({ t: 'sessions', list: sessions })
      })
    )
    this.unhook.push(
      this.backend.onAttention((s) => {
        for (const g of this.guests) g.conn.send({ t: 'attention', session: s })
      })
    )
  }

  private async greet(socket: Socket): Promise<void> {
    const conn = new Conn(socket, this.me())
    const guest = new GuestConn(conn)
    conn.on('gone', () => {
      if (this.guests.delete(guest)) this.emit('changed')
    })
    try {
      await conn.accept(await deriveKey(this.code()))
    } catch {
      // Wrong code, wrong version, or a port scanner. Nothing to report to the UI:
      // an open port on a LAN gets knocked on, and a toast per knock is noise.
      conn.close()
      return
    }
    this.guests.add(guest)
    conn.on('msg', (m: Msg) => this.handle(guest, m))
    conn.send({ t: 'sessions', list: this.backend.list() })
    this.emit('changed')
  }

  private handle(guest: GuestConn, m: Msg): void {
    const conn = guest.conn
    const id = typeof m.id === 'string' ? m.id : ''
    try {
      switch (m.t) {
        case 'attach': {
          if (!id) return
          guest.attached.add(id)
          // The whole scrollback in one frame: the guest's xterm writes it and the
          // pane looks exactly as it does here, mid-turn included.
          conn.send({ t: 'buffer', id, data: this.backend.buffer(id) })
          this.emit('changed')
          return
        }
        case 'detach':
          guest.attached.delete(id)
          this.emit('changed')
          return
        case 'write':
          this.backend.write(id, String(m.data ?? ''))
          return
        case 'resize':
          // Honoured, but nothing sends it: this device owns the size of its own
          // panes and a mirror draws itself at whatever cols/rows the session says.
          // Two windows both fitting one pty would trade SIGWINCHes forever, with a
          // full-screen CLI repainting its entire frame every round.
          this.backend.resize(id, Number(m.cols ?? 80), Number(m.rows ?? 24))
          return
        case 'redraw':
          this.backend.redraw(id)
          return
        case 'busy':
          this.backend.setBusy(
            id,
            Boolean(m.busy),
            typeof m.tail === 'string' ? m.tail : '',
            // Sent only when the far end could read the agent's own turn counter off
            // the frame; a mirror never judges busy at all, so this is usually absent.
            m.clock && typeof m.clock === 'object'
              ? (m.clock as unknown as TurnClock)
              : undefined
          )
          return
        case 'ack':
          this.backend.clearAttention(id)
          return
        case 'kill':
          guest.attached.delete(id)
          this.backend.kill(id)
          return
        case 'restart':
          this.backend.restart(id)
          return
        case 'rename':
          this.backend.rename(id, String(m.title ?? ''))
          return
        case 'switch':
          this.backend.switchAgent(id, String(m.agent ?? ''), (m.model as string) || undefined)
          return
        case 'start': {
          const req = m.req as StartSessionRequest
          void Promise.resolve(this.backend.startSession(req)).then((started) =>
            conn.send({ t: 'started', rid: m.rid, session: started })
          )
          return
        }
        case 'projects':
          void this.backend.projects().then((list) => conn.send({ t: 'projects', rid: m.rid, list }))
          return
        case 'agents':
          void this.backend.agents().then((list) => conn.send({ t: 'agents', rid: m.rid, list }))
          return
        case 'ping':
          conn.send({ t: 'pong' })
          return
        default:
          return
      }
    } catch (err) {
      // A guest asking for a pane that has since exited must not take the listener
      // down with it.
      conn.send({ t: 'failed', rid: m.rid, error: (err as Error).message })
    }
  }
}

export type { AgentInfo }
