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
//
// NOTHING IS MIRRORED UNTIL IT IS PICKED. Connecting used to mirror every pane the
// other device had, and attach to every one of them, the moment the link came up -
// so a desk that paired with itself (which the app used to allow: see `Remote.probe`)
// drew every one of its own panes twice, and a desk paired with a busy machine got
// eight panes it had not asked for, each streaming its output across the network.
// `watch` is that pick. `panes()` still reports everything the device has, because
// the Devices panel has to offer the list you are choosing from.

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import type { AgentInfo } from '../../shared/agents'
import type { AttachIn, AttachResult } from '../../shared/attach'
import type { BackJob } from '../../shared/backJobs'
import {
  HANDOFF_ASK_MS,
  HANDOFF_CHUNK,
  type HandoffItem,
  type HandoffPayload,
  type HandoffResult
} from '../../shared/handoff'
import type { Project, RemotePeer, Session, StartSessionRequest } from '../../shared/types'
import { Conn, deriveKey, type Msg, type PeerIdentity } from './wire'
import { OutBuffer } from '../outBuffer'

/** Same cap the local session manager keeps, for the same reason. */
const BUFFER_LIMIT = 400_000
/** Reconnect backoff: quick at first, then out of the way. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/**
 * A silent link is a dead link; the ping proves the socket, not the agent.
 *
 * Overridable only so the dead-link test can run in seconds instead of a minute.
 */
// Floored: a negative or absurdly small override is truthy, so `||` alone would let
// PF_PING_MS=-5000 through as a NEGATIVE deadline, which every elapsed time exceeds -
// the link would be declared dead on its first tick while it was working perfectly.
const PING_MS = Math.max(50, Number(process.env.PF_PING_MS) || 15_000)
/**
 * How long the far end may say nothing before the link counts as dead.
 *
 * A ping is only half a liveness check - it is worth nothing unless something watches
 * for the answer. A TCP connection whose path disappears (Wi-Fi swap, the VPN dropping,
 * the other machine sleeping, a NAT idle eviction) is closed by nobody: no FIN, no RST,
 * and writes keep succeeding into the OS buffer for minutes. Without this deadline the
 * device stays `online` for as long as that lasts and its mirrored panes simply stop
 * moving, which reads as the far end having died mid-turn when it is still running.
 *
 * Three missed beats, so one lost packet or a busy moment is not a disconnect.
 */
const DEAD_MS = PING_MS * 3

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

  /** Every pane that device has, whether or not this one is mirroring it. */
  private available: Session[] = []
  /** The panes this device chose to mirror, by their id ON that device. */
  private watching = new Set<string>()

  private conn: Conn | null = null
  private socket: Socket | null = null
  private buffers = new Map<string, OutBuffer>()
  private want = false
  private tries = 0
  private timer: NodeJS.Timeout | null = null
  private ping: NodeJS.Timeout | null = null
  private rid = 0
  private pending = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>()
  /** epoch ms the far end last said anything at all - see DEAD_MS. */
  private heard = 0

  constructor(
    public peer: RemotePeer,
    private readonly me: () => PeerIdentity
  ) {
    super()
    for (const id of peer.watch ?? []) this.watching.add(id)
  }

  get id(): string {
    return this.peer.id
  }

  /** Mirrored sessions, already namespaced and tagged with the device they are on. */
  list(): Session[] {
    return this.sessions
  }

  /** Every pane on that device, mirrored or not - what the Devices panel offers. */
  panes(): Session[] {
    return this.available
  }

  /** The ids on that device this one is mirroring. */
  watched(): string[] {
    return [...this.watching]
  }

  /**
   * Choose what to mirror. Ids are the OTHER device's, as `panes()` reports them.
   *
   * Streams follow the pick both ways: a newly watched pane is attached (its scrollback
   * arrives, then live output), and one dropped is detached over the wire rather than
   * merely hidden here - the point of picking is that an unwatched pane costs nothing.
   */
  setWatch(ids: string[]): void {
    const next = new Set(ids)
    for (const id of this.watching) {
      if (next.has(id)) continue
      this.buffers.delete(id)
      this.conn?.send({ t: 'detach', id })
    }
    this.watching = next
    if (this.peer.mirrorAll) this.peer = { ...this.peer, mirrorAll: false }
    this.applyWatch()
  }

  /** Mirror everything this device has, now and as it opens more. */
  setMirrorAll(on: boolean): void {
    this.peer = { ...this.peer, mirrorAll: on }
    if (!on) {
      for (const id of this.watching) this.conn?.send({ t: 'detach', id })
      this.watching.clear()
    }
    this.applyWatch()
  }

  private applyWatch(): void {
    if (this.peer.mirrorAll) for (const s of this.available) this.watching.add(s.id)
    const live = new Set(this.available.map((s) => s.id))
    for (const id of [...this.watching]) if (!live.has(id)) this.watching.delete(id)
    for (const id of this.watching) this.attach(id)
    for (const id of [...this.buffers.keys()]) if (!this.watching.has(id)) this.buffers.delete(id)
    this.sessions = this.available.filter((s) => this.watching.has(s.id)).map((s) => this.tag(s))
    this.emit('sessions')
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

  /**
   * Ask the host to draw one of its panes at OUR grid, as a borrow it can undo.
   *
   * Only for a pane we are watching: a resize is the one message that changes something
   * on the other machine's own screen, so it may not be sent about a pane this device
   * is not even drawing.
   */
  resizeOn(localId: string, cols: number, rows: number, viewer?: string): void {
    if (!this.watching.has(localId)) return
    this.conn?.send({ t: 'resize', id: localId, cols, rows, borrowed: true, viewer })
  }

  /**
   * One screen here has let go of a pane we are still watching.
   *
   * Detaching returns every borrow this connection holds, which is right when the pane
   * stops being drawn at all and wrong when only the PHONE looked away - the window is
   * still mirroring it. An older host does not know this message and ignores it, which
   * leaves exactly the behaviour that shipped before it.
   */
  returnSizeOn(localId: string, viewer?: string): void {
    if (!this.watching.has(localId)) return
    this.conn?.send({ t: 'unborrow', id: localId, viewer })
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

  /**
   * What that machine is running outside its panes - see `shared/backJobs.ts`.
   *
   * A whole process table is read over there to answer this, so it is asked when somebody
   * opens the panel and never on a tick. A device that does not answer rejects, and the
   * caller says so: an empty list is "nothing is running", which is a completely different
   * fact about a machine that is meant to be working.
   */
  jobs(): Promise<BackJob[]> {
    return this.ask<BackJob[]>({ t: 'jobs' }, 20_000)
  }

  /**
   * Save files beside a mirrored pane, on the device that owns it.
   *
   * The bytes go over rather than the path, because the path is the thing that does not
   * survive the crossing: a screenshot on this desk is at a location the other machine has
   * never had. Capped well under the link's frame by `tooBig` before it gets here.
   */
  attachFiles(localId: string, files: AttachIn[]): Promise<AttachResult> {
    return this.ask<AttachResult>({ t: 'files', id: localId, files })
  }

  async startSession(req: StartSessionRequest): Promise<Session> {
    const s = await this.ask<Session>({ t: 'start', req })
    // A pane opened from here is one this device asked for, so it is mirrored without
    // being picked twice - "New pane" that opened nothing visible would read as a failure.
    this.watch(s.id)
    return this.tag(s)
  }

  /** Add one pane to the mirror, the way opening or receiving it implies. */
  watch(localId: string): void {
    if (!localId || this.watching.has(localId)) return
    this.watching.add(localId)
    this.attach(localId)
    if (this.available.some((s) => s.id === localId)) this.applyWatch()
  }

  /**
   * Hand one pane over. The payload goes out under the ordinary rid, and the
   * transcript follows it as chunk frames tied together by `xfer` - the wire
   * caps a frame at 8 MB and a transcript is routinely bigger. The answer only
   * comes once the far end's pane is actually running, so the timeout is the
   * long one: a clone on a cold repo is part of what it is waiting for.
   */
  /**
   * Ask that device to hand one of ITS panes back to this one.
   *
   * The direction is the whole design. A handoff is always PUSHED by the machine that
   * owns the pty, because that is where the repo, the transcript and the process are - so
   * bringing a pane back cannot be a pull. It is a request, and the far end then runs the
   * ordinary handoff it would have run had somebody pressed the button over there: same
   * repo push, same transcript, same mid-turn queue, same refusals, all reported by name.
   * Nothing new travels over this link.
   *
   * An older build has no case for this frame and simply drops it, so the answer is a
   * timeout rather than a refusal - which is why the sentence the caller shows says the
   * machine did not answer rather than that it said no.
   */
  takeBack(localId: string): Promise<HandoffItem[]> {
    return this.ask<HandoffItem[]>({ t: 'takeback', id: localId }, HANDOFF_ASK_MS)
  }

  handoff(payload: HandoffPayload, file: Buffer | null): Promise<HandoffResult> {
    const body: HandoffPayload = { ...payload }
    if (!file || file.length === 0) {
      file = null
      delete body.transcript
      delete body.xfer
    } else {
      body.xfer = randomBytes(8).toString('hex')
    }
    // The desk that hands work over keeps watching it, which is the whole promise of the
    // feature - so the pane that comes back is picked for us, and nothing else is.
    const answer = this.ask<HandoffResult>({ t: 'handoff', payload: body }, HANDOFF_ASK_MS).then((r) => {
      if (r?.ok && r.session?.id) this.watch(r.session.id)
      return r
    })
    if (file && body.xfer) {
      for (let off = 0; off < file.length; off += HANDOFF_CHUNK) {
        this.send({
          t: 'handoffdata',
          xfer: body.xfer,
          data: file.subarray(off, off + HANDOFF_CHUNK).toString('base64'),
          last: off + HANDOFF_CHUNK >= file.length
        })
      }
    }
    return answer
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
      // OS-level backstop under the DEAD_MS check: probes a silent path even while this
      // side has nothing to send, so a half-open socket eventually errors on its own.
      socket.setKeepAlive(true, PING_MS)
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
    this.heard = Date.now()
    this.ping = setInterval(() => {
      // Check BEFORE sending: a link that has answered nothing for three beats is gone,
      // and one more ping into it proves nothing. Destroying the socket is what turns a
      // silently frozen mirror back into a visible 'reconnecting', because `gone` fires
      // the same teardown+retry a clean disconnect does.
      if (Date.now() - this.heard >= DEAD_MS) {
        this.teardown('error', 'That device stopped answering')
        this.retry()
        return
      }
      conn.send({ t: 'ping' })
    }, PING_MS)
    this.ping.unref()
    this.setStatus('online', '')
  }

  private receive(m: Msg): void {
    // Anything at all counts as proof of life, `pong` included - it falls through the
    // switch below unhandled, and this stamp is the whole reason the host sends it.
    this.heard = Date.now()
    switch (m.t) {
      case 'sessions': {
        this.available = (m.list as Session[]) ?? []
        // Only what was picked is attached. A pane nobody asked for is listed and left
        // alone: no scrollback fetched, no live output crossing the network for it.
        this.applyWatch()
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
      case 'handoffdone':
        this.settle(m, m.result)
        return
      // The far end ran the handoff we asked it for. `items` is one entry per pane, the
      // same shape a local `Hand off` reports, so a queued pane reads as queued here too.
      case 'takebackdone':
        this.settle(m, m.items)
        return
      case 'projects':
        this.settle(m, m.list)
        return
      case 'agents':
        this.settle(m, m.list)
        return
      case 'jobslist':
        this.settle(m, m.list)
        return
      case 'filesdone':
        this.settle(m, m.result)
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
    this.available = []
    // `watching` deliberately survives: it is what this device chose to mirror, and a
    // reconnect should bring those panes back rather than make the choice again.
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
