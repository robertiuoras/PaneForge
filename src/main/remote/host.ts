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
import {
  HANDOFF_MAX_FILE,
  type HandoffItem,
  type HandoffPayload,
  type HandoffResult
} from '../../shared/handoff'
import type { AttachIn, AttachResult } from '../../shared/attach'
import type { BackJob } from '../../shared/backJobs'
import type { BusyReason } from '../../shared/busy'
import type { Project, Session, StartSessionRequest, TurnClock } from '../../shared/types'
import { WireBatch, type WireFrame } from '../../shared/wireBatch'
import { Conn, deriveKey, type Msg, type PeerIdentity } from './wire'

/** Everything the host is allowed to do to this app on a guest's behalf. */
export interface HostBackend {
  list(): Session[]
  buffer(id: string): string
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number, borrowed?: boolean, viewer?: string): void
  /** Give a pane whose size a guest borrowed back to this desk. */
  returnSize?(id: string, viewer?: string): void
  redraw(id: string): void
  setBusy(id: string, busy: boolean, tail?: string, clock?: TurnClock, reason?: BusyReason): void
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
  /**
   * A guest asking for one of THIS device's panes back. It is the ordinary outward
   * handoff - queue, repo push, refusals and all - aimed at the guest's own device id,
   * which is why it returns `HandoffItem[]` and not a bare ok.
   *
   * Optional so a backend that cannot do it refuses in a sentence rather than throwing.
   */
  handBack?(id: string, device: string): Promise<HandoffItem[]>
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

let guestSeq = 0

class GuestConn {
  /**
   * Who this guest IS, for the pane-size bookkeeping.
   *
   * Per CONNECTION rather than per device on purpose: a device that reconnects is a new
   * window with a new size, and the old connection's borrow is dropped when it goes. Two
   * windows on one machine are two viewers, which is exactly what they are.
   */
  readonly key = `guest:${++guestSeq}`
  /**
   * Every borrow name this connection has used, because one connection is several SCREENS.
   *
   * A paired device draws a pane in its desk window AND may be serving the same pane to a
   * phone, and both fit their own screen. Filed under one key per connection they are one
   * viewer changing its mind, so the phone's 50 columns replaced the window's 157 and the
   * pane came back phone-sized on the machine that owns it. Filed apart they are two
   * borrowers and `shared/paneSize.ts` lends them the smallest grid instead.
   */
  readonly viewers = new Set<string>()
  attached = new Set<string>()
  /** transcripts mid-transfer: a handoff's chunk frames, keyed by its xfer id */
  xfers = new Map<string, { payload: HandoffPayload; rid: number; parts: Buffer[]; size: number }>()
  readonly since = Date.now()
  constructor(readonly conn: Conn) {}

  /** The borrow name for one of that device's screens. Unnamed = the connection itself. */
  viewerKey(viewer?: unknown): string {
    if (typeof viewer !== 'string' || !viewer) return this.key
    const named = `${this.key}/${viewer}`
    this.viewers.add(named)
    return named
  }

  /** Every name this guest may be holding a borrow under. */
  viewerKeys(): string[] {
    return [this.key, ...this.viewers]
  }
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
  /**
   * Output waiting to go out, gathered per pane.
   *
   * The link used to put every scrap a program printed into its own encrypted message -
   * 11,704 a second from one pane, measured 2026-09-03, which cost 516ms of this
   * machine's time and 5.5 MB on the wire to move 3.5 MB of text. Gathered into 16ms the
   * same recording is 55 messages, 123ms and 4.5 MB. See src/shared/wireBatch.ts.
   */
  private readonly batch = new WireBatch()
  private batchTimer: ReturnType<typeof setTimeout> | null = null
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
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.batch.drain()
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
      this.backend.onData((id, data) => this.gather(id, data))
    )
    this.unhook.push(
      this.backend.onSessions((sessions) => {
        // A pane's last words have to be on the wire before the list says it ended, or
        // they arrive after the other device has already drawn the pane as finished.
        this.flush(this.batch.drain())
        for (const g of this.guests) g.conn.send({ t: 'sessions', list: sessions })
      })
    )
    this.unhook.push(
      this.backend.onAttention((s) => {
        for (const g of this.guests) g.conn.send({ t: 'attention', session: s })
      })
    )
  }

  /**
   * One scrap of a pane's output, on its way to whoever is watching that pane.
   *
   * A pane nobody is mirroring is dropped here rather than gathered: its text is already
   * kept by this machine, and holding a second copy for a device that never asked for it
   * would grow for as long as the pane runs.
   */
  private gather(id: string, data: string): void {
    let watched = false
    for (const g of this.guests) {
      if (g.attached.has(id)) {
        watched = true
        break
      }
    }
    if (!watched) {
      this.batch.forget(id)
      return
    }
    const now = Date.now()
    const immediate = this.batch.push(id, data, now)
    if (immediate.length) this.flush(immediate)
    this.arm()
  }

  /** Put gathered output on the wire, to every device watching that pane. */
  private flush(frames: WireFrame[]): void {
    for (const f of frames) {
      for (const g of this.guests) if (g.attached.has(f.id)) g.conn.send({ t: 'data', id: f.id, data: f.data })
    }
  }

  /**
   * One timer, set only while something is waiting.
   *
   * A repeating timer would tick 62 times a second for the life of the app on a machine
   * nobody is mirroring anything from; this one exists only between the first scrap and
   * the moment the last pane's text goes out.
   */
  private arm(): void {
    if (this.batchTimer) return
    const wait = this.batch.nextDue(Date.now())
    if (wait === null) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      this.flush(this.batch.due(Date.now()))
      if (!this.batch.idle) this.arm()
    }, wait)
    this.batchTimer.unref?.()
  }

  private async greet(socket: Socket): Promise<void> {
    const conn = new Conn(socket, this.me())
    const guest = new GuestConn(conn)
    this.pending.add(conn)
    conn.on('gone', () => {
      this.pending.delete(conn)
      if (this.guests.delete(guest)) {
        // A guest that vanished cannot detach, so its borrows are returned here too.
        for (const id of guest.attached)
          for (const key of guest.viewerKeys()) this.backend.returnSize?.(id, key)
        this.emit('changed')
      }
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

  /**
   * Answer a request whose work is a promise, and answer it EVEN WHEN IT REJECTS.
   *
   * The `try`/`catch` around the switch below is synchronous, so it never sees a rejected
   * promise: `void this.backend.jobs().then(send)` on its own leaves the guest waiting the
   * full 20s of its own timeout and then failing with "did not answer", about a machine
   * that answered instantly and said no. `runHandoff` already had the `.catch`; the four
   * other request/response cases did not, so they share this instead of repeating it.
   */
  private answer(conn: Conn, m: Msg, work: Promise<unknown> | unknown, key: string, value: (v: unknown) => Msg): void {
    void Promise.resolve(work)
      .then((v) => conn.send({ ...value(v), rid: m.rid }))
      .catch((err: Error) => conn.send({ t: 'failed', rid: m.rid, error: err.message || `${key} failed` }))
  }

  private handle(guest: GuestConn, m: Msg): void {
    const conn = guest.conn
    const id = typeof m.id === 'string' ? m.id : ''
    try {
      switch (m.t) {
        case 'attach': {
          if (!id) return
          // Anything gathered for this pane goes to the devices already watching it
          // FIRST. The history this device is about to be sent already contains that
          // text, so releasing it afterwards would show it twice.
          this.flush(this.batch.drain(id))
          guest.attached.add(id)
          // The whole scrollback in one frame: the guest's xterm writes it and the
          // pane looks exactly as it does here, mid-turn included.
          conn.send({ t: 'buffer', id, data: this.backend.buffer(id) })
          this.emit('changed')
          return
        }
        case 'detach':
          guest.attached.delete(id)
          // Whatever that guest borrowed goes back to this desk the moment it looks
          // away - the same contract a phone has. Without this, one look from another
          // machine would leave this pane at somebody else's width for ever.
          for (const key of guest.viewerKeys()) this.backend.returnSize?.(id, key)
          this.emit('changed')
          return
        case 'unborrow':
          // ONE of that device's screens let go - its phone went back to the list, say -
          // while the device itself is still mirroring the pane. Only that screen's borrow
          // ends; what the others asked for still holds.
          if (!id) return
          this.backend.returnSize?.(id, guest.viewerKey(m.viewer))
          return
        case 'write':
          this.backend.write(id, String(m.data ?? ''))
          return
        case 'resize':
          // A mirror asking to BORROW the size, which is what stops the far end drawing
          // this desk's grid at the wrong scale. Borrowed, never owned: this desk keeps
          // `deskCols/deskRows` and gets them back on detach or when the guest goes.
          // The old ping-pong worry does not apply - a mirror fits itself to its own
          // window and asks for that, so it never chases the number it was sent.
          // Named, so two devices mirroring one pane are two borrowers rather than one
          // that keeps changing its mind - `shared/paneSize.ts` lends them the smallest
          // grid of the two instead of flipping the pty between their windows.
          this.backend.resize(
            id,
            Number(m.cols ?? 80),
            Number(m.rows ?? 24),
            m.borrowed === true,
            guest.viewerKey(m.viewer)
          )
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
          // The asking desk's address rides on the request: its Chrome is the one this pane
          // may drive (`shared/peerChrome.ts`).
          const req = { ...(m.req as StartSessionRequest), fromAddress: conn.address }
          this.answer(conn, m, this.backend.startSession(req), 'start', (session) => ({ t: 'started', session }))
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
        // "Bring it back here". The pane lives on THIS machine, so this machine is the
        // one that can move it: the guest only names the pane, and the device it goes to
        // is the one on the other end of this socket - never a device id in the frame,
        // which a guest could otherwise point anywhere.
        case 'takeback': {
          const rid = Number(m.rid ?? 0)
          const device = conn.peer.id
          if (!device) {
            conn.send({ t: 'failed', rid, error: 'That device has not identified itself' })
            return
          }
          if (!this.backend.handBack) {
            conn.send({ t: 'failed', rid, error: 'This machine cannot send a pane back yet' })
            return
          }
          void this.backend
            .handBack(id, device)
            .then((items) => conn.send({ t: 'takebackdone', rid, items }))
            .catch((err: Error) => conn.send({ t: 'failed', rid, error: err.message }))
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
          this.answer(conn, m, this.backend.projects(), 'projects', (list) => ({ t: 'projects', list }))
          return
        case 'agents':
          this.answer(conn, m, this.backend.agents(), 'agents', (list) => ({ t: 'agents', list }))
          return
        case 'jobs':
          // A read that could not happen comes back as a `failed` frame, which the guest
          // turns into a sentence. It may never arrive as an empty list: `[]` means this
          // machine is running nothing, which is the answer being checked - see the note
          // in `Remote.jobsOn`.
          this.answer(conn, m, this.backend.jobs(), 'jobs', (list) => ({ t: 'jobslist', list }))
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
