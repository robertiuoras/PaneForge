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
import { HANDOFF_MAX_FILE, type HandoffPayload, type HandoffResult } from '../../shared/handoff'
import type { AttachIn, AttachResult } from '../../shared/attach'
import type { BackJob } from '../../shared/backJobs'
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
  /** a pane another device is handing to this one - pull, restore, start */
  receiveHandoff(payload: HandoffPayload, file: Buffer | null): Promise<HandoffResult>
  projects(): Promise<Project[]>
  agents(): Promise<AgentInfo[]>
  /**
   * What this machine is running that no pane owns - see `shared/backJobs.ts`.
   *
   * Read here, on this device, because it is a question about THIS process table. Asked
   * only when a guest asks: it is a whole `ps -Ao command=`, so it is never on a timer and
   * never rides the `remote:changed` message the pane list travels on.
   */
  jobs(): Promise<BackJob[]>
  /** files a guest wants put in front of one of THIS device’s panes */
  attachFiles(files: AttachIn[]): AttachResult
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
  /** transcripts mid-transfer: a handoff's chunk frames, keyed by its xfer id */
  xfers = new Map<string, { payload: HandoffPayload; rid: number; parts: Buffer[]; size: number }>()
  readonly since = Date.now()
  constructor(readonly conn: Conn) {}
}

export class RemoteHost extends EventEmitter {
  private server: Server | null = null
  private guests = new Set<GuestConn>()
  /**
   * Sockets that have connected but are not guests yet - mid-handshake, or sitting on an
   * Approve card waiting for a person.
   *
   * Tracked because `server.close()` does not touch a socket that is already open, and a
   * pairing request can legitimately be open for two minutes. Without this, switching
   * hosting off left the device at the other end staring at "waiting for approval" until
   * its own budget ran out, with nothing left here that could ever answer it.
   */
  private pending = new Set<Conn>()
  private unhook: (() => void)[] = []
  /** Why the listener is not up, when it should be. Surfaced in the dialog. */
  error = ''
  port = 0

  /**
   * Asked whether a device with no code may have one. Set by `Remote`, which puts the
   * request and its six digits on screen and resolves when somebody answers.
   *
   * Left null the listener still answers pairing requests - it refuses them by name,
   * which is the honest reply for a window that cannot show anybody a card.
   */
  onAsk: ((peer: PeerIdentity, sas: string, address: string) => Promise<boolean>) | null = null

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
    for (const c of this.pending) c.close()
    this.pending.clear()
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
    this.pending.add(conn)
    conn.on('gone', () => {
      this.pending.delete(conn)
      if (this.guests.delete(guest)) this.emit('changed')
    })
    try {
      const how = await conn.accept(
        await deriveKey(this.code()),
        this.onAsk ? (peer, sas) => this.onAsk!(peer, sas, conn.address) : undefined,
        this.code()
      )
      // A pairing request is not a session: the joiner has the code now and comes back
      // through the ordinary path. Leaving this socket open would put a guest in the list
      // that has proved nothing.
      if (how === 'asked') {
        this.pending.delete(conn)
        conn.close()
        return
      }
    } catch {
      // Wrong code, wrong version, a refused pairing request, or a port scanner. Nothing
      // to report to the UI: an open port on a LAN gets knocked on, and a toast per knock
      // is noise.
      this.pending.delete(conn)
      conn.close()
      return
    }
    this.pending.delete(conn)
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
        case 'handoff': {
          const payload = m.payload as HandoffPayload
          const rid = Number(m.rid ?? 0)
          if (!payload || typeof payload !== 'object' || !payload.spec) {
            conn.send({ t: 'failed', rid, error: 'Malformed handoff' })
            return
          }
          // A transcript is announced here and arrives as chunk frames; the work
          // starts once the last one lands. No transcript means start now.
          if (payload.xfer && payload.transcript) {
            if (payload.transcript.size > HANDOFF_MAX_FILE) {
              conn.send({ t: 'failed', rid, error: 'Transcript too large to hand off' })
              return
            }
            guest.xfers.set(String(payload.xfer), { payload, rid, parts: [], size: 0 })
            return
          }
          this.runHandoff(conn, rid, payload, null)
          return
        }
        case 'handoffdata': {
          const x = guest.xfers.get(String(m.xfer ?? ''))
          if (!x) return
          const part = Buffer.from(String(m.data ?? ''), 'base64')
          x.size += part.length
          if (x.size > HANDOFF_MAX_FILE) {
            guest.xfers.delete(String(m.xfer))
            conn.send({ t: 'failed', rid: x.rid, error: 'Transcript too large to hand off' })
            return
          }
          x.parts.push(part)
          if (m.last) {
            guest.xfers.delete(String(m.xfer))
            this.runHandoff(conn, x.rid, x.payload, Buffer.concat(x.parts))
          }
          return
        }
        case 'projects':
          void this.backend.projects().then((list) => conn.send({ t: 'projects', rid: m.rid, list }))
          return
        case 'agents':
          void this.backend.agents().then((list) => conn.send({ t: 'agents', rid: m.rid, list }))
          return
        case 'jobs':
          // A refusal here is a `failed` frame by way of the catch below, which the guest
          // turns into a sentence. An empty list means "nothing running", and a read that
          // could not happen must never share that shape - see the note in `Remote.jobsOn`.
          void this.backend.jobs().then((list) => conn.send({ t: 'jobslist', rid: m.rid, list }))
          return
        case 'files': {
          // The bytes are written here because here is where the pty is. A refusal is a
          // sentence in the result rather than a `failed` frame: the caller is a person
          // who just pasted something and wants to be told why, not a stack.
          const files = Array.isArray(m.files) ? (m.files as AttachIn[]) : []
          conn.send({ t: 'filesdone', rid: m.rid, result: this.backend.attachFiles(files) })
          return
        }
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

  /** Run a received handoff and answer by rid - a refusal is a sentence, not a hang. */
  private runHandoff(conn: Conn, rid: number, payload: HandoffPayload, file: Buffer | null): void {
    void Promise.resolve(this.backend.receiveHandoff(payload, file))
      .then((result) => conn.send({ t: 'handoffdone', rid, result }))
      .catch((err: Error) => conn.send({ t: 'failed', rid, error: err.message }))
  }
}

export type { AgentInfo }
