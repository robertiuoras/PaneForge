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
import { readDeskReport, type DeskReport } from '../../shared/discordRpc'
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
import { machineOf } from '../../shared/paneLabel'
import type { ReviewRecord } from '../../shared/reviews'
import { TELL_WAIT_MS, type TellOutcome } from '../../shared/tell'

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

/** What `pf tell` says about an owner that has no tell answer yet - wording fixed by the brief. */
export const OLDER_TELL_REASON =
  'the other computer runs an older PaneForge that sends no receipt; it types the prompt when that chat is ready'

/**
 * What `sessions:draft` answers for one pane: the text in its input box and where it was
 * read (the drawn screen, or the keystrokes the app relayed), or why the computer that runs
 * it could not be asked. Null (no such pane) is answered beside it.
 */
export type PaneDraft = { text: string; certain: boolean; from: 'screen' | 'keystrokes' } | { unavailable: string }

/** What `pf composer` says about an owner from before `draftRead` - it is not asked. */
export const olderDraftReason = (name: string): string =>
  `${name} runs an older PaneForge that cannot say what is typed in its chats; update PaneForge there`

/** An owner's draft answer, checked where it lands; anything else is said to be unreadable. */
export function draftFrom(raw: unknown, name: string): PaneDraft | null {
  if (raw === null) return null
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (typeof d.text === 'string' && typeof d.certain === 'boolean' && (d.from === 'screen' || d.from === 'keystrokes'))
    return { text: d.text, certain: d.certain, from: d.from }
  return { unavailable: `${name} answered, but its answer could not be read` }
}

/**
 * An owner's tell answer, checked where it lands and put back under the device's name.
 * Anything this side cannot read is a failure that says so - never a delivery.
 */
export function outcomeFrom(raw: unknown, peer: string, id: string, title: string): TellOutcome {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const { kind, at, how, receipt, reason, busySince, title: said, id: local, ref } = o
  const theirTitle = typeof said === 'string' ? said : title
  const theirId = typeof local === 'string' && local ? joinId(peer, local) : id
  const theirRef = typeof ref === 'string' && ref ? joinId(peer, ref) : id
  if (kind === 'missing') return { kind: 'missing', ref: theirRef }
  if (kind === 'delivered' && typeof at === 'number' && (how === 'typed' || how === 'steered') && typeof receipt === 'string')
    return { kind: 'delivered', id: theirId, title: theirTitle, at, how, receipt }
  if (kind === 'queued' && typeof reason === 'string')
    return { kind: 'queued', id: theirId, title: theirTitle, ...(typeof busySince === 'number' ? { busySince } : {}), reason }
  if (kind === 'failed' && typeof reason === 'string') return { kind: 'failed', id: theirId, title: theirTitle, reason }
  return { kind: 'failed', id, title, reason: 'the other computer answered, but its answer could not be read, so whether the prompt was sent is not known' }
}

export class RemoteClient extends EventEmitter {
  status: PeerStatus = 'off'
  error = ''
  /** epoch ms the current connection came up */
  since = 0
  sessions: Session[] = []
  /** the version that device's handshake reported, cleared on disconnect */
  peerVersion = ''

  /**
   * Whether somebody is at that device's screen, as it last said.
   *
   * First heard in the handshake, then re-stated by a `presence` frame whenever it
   * changes over there. `undefined` while disconnected, and for a build too old to send
   * it - a row can then say nothing rather than inventing an empty desk.
   */
  peerPerson: boolean | undefined = undefined
  /** what that machine last said about its own panes and its Discord (`shared/discordRpc.ts`) */
  peerDesk: DeskReport | undefined = undefined
  /** what this desk last said about itself, re-sent whenever the link comes back */
  private desk: DeskReport | undefined = undefined

  /** Every pane that device has, whether or not this one is mirroring it. */
  private available: Session[] = []
  /** The panes this device chose to mirror, by their id ON that device. */
  private watching = new Set<string>()
  /**
   * The last grid each screen here borrowed on the far end, keyed by pane and screen.
   *
   * Only so the borrow can be RE-STATED when the answer to "is anybody at this desk"
   * changes: an idle mirrored pane repaints never, so without a stored frame the owner
   * would keep whatever presence it was told the first time - see `restatePresence`.
   */
  private lent = new Map<string, { localId: string; cols: number; rows: number; viewer?: string; person?: boolean }>()

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
   * Whether every pane that device has is mirrored, now and as it opens more.
   *
   * ON unless this device chose otherwise. A peer that never said (`undefined`) mirrors
   * everything: a pane over there is then already a card here, and pressing it shows its
   * screen with no wait for a mirror to attach. Only a peer that picked panes by hand
   * (`setWatch`, which writes `false`) mirrors just its pick.
   */
  mirrorsAll(): boolean {
    return this.peer.mirrorAll !== false
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
    if (this.mirrorsAll()) this.peer = { ...this.peer, mirrorAll: false }
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
    if (this.mirrorsAll()) for (const s of this.available) this.watching.add(s.id)
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

  send(m: Msg): boolean {
    if (!this.conn?.ready) return false
    this.conn.send(m)
    return true
  }

  /**
   * Give the pane owner one prompt intent, so text and submission cannot be split by a
   * reconnect. Older owners did not advertise that operation, so keep their exact
   * two-keystroke protocol until both devices have upgraded.
   */
  sendPrompt(localId: string, text: string): boolean {
    if (!this.conn?.ready) return false
    if (this.conn.peer.promptSubmit === true) {
      this.conn.send({ t: 'prompt', id: localId, text })
      return true
    }
    const conn = this.conn
    conn.send({ t: 'write', id: localId, data: text })
    const timer = setTimeout(() => {
      // Never send the Return into a replacement connection: its owner cannot know
      // whether the text frame reached the old one before it died.
      if (this.conn === conn && conn.ready) conn.send({ t: 'write', id: localId, data: '\r' })
    }, 600)
    timer.unref()
    return true
  }

  /**
   * A message somebody is WATCHING for went out and nothing came back: is this link alive?
   *
   * Closing a pane is that message - the row only goes when the far end's next pane list
   * arrives - and a socket that dies silently is not noticed until DEAD_MS (45s), so the
   * press looked ignored for three quarters of a minute and got pressed again. Nothing
   * heard at all since the action went out is a dead link, torn down here so the reconnect
   * starts now; a link that has spoken since is alive, and the action really did fail over
   * there. Answers whether it is alive.
   */
  proveAlive(since: number): boolean {
    if (!this.conn) return false
    if (this.heard >= since) return true
    this.teardown('error', 'That device stopped answering')
    this.retry()
    return false
  }

  /**
   * Which of the mirrored panes each screen here is actually DRAWING, by viewer key.
   *
   * A screen that has never said is absent, and absent means everything it borrowed is
   * on it - the reading an older window or a phone that says nothing gets.
   */
  private shown = new Map<string, Set<string>>()
  /** Whether a person is at this desk, as last stated - see `restatePresence`. */
  private person: boolean | undefined = undefined

  /**
   * What the far end is told about who is behind a borrow: somebody, when a person is at
   * this desk AND the screen holding it is drawing that pane. With every pane of a device
   * mirrored, each hidden mirror still holds a borrow over there, and a borrow with a
   * person behind it keeps that pane off the owner's idle clock - eight hidden mirrors
   * would have held eight PC panes open for as long as the Mac was awake.
   */
  private personBehind(localId: string, viewer?: string): boolean | undefined {
    if (this.person === false) return false
    const drawn = this.shown.get(viewer ?? '')
    if (drawn && !drawn.has(localId)) return false
    return this.person
  }

  /**
   * Ask the host to draw one of its panes at OUR grid, as a borrow it can undo.
   *
   * Only for a pane we are watching: a resize is the one message that changes something
   * on the other machine's own screen, so it may not be sent about a pane this device
   * is not even drawing.
   */
  resizeOn(localId: string, cols: number, rows: number, viewer?: string, person?: boolean): void {
    if (!this.watching.has(localId)) return
    if (person !== undefined) this.person = person
    const behind = this.personBehind(localId, viewer)
    this.lent.set(`${localId} ${viewer ?? ''}`, { localId, cols, rows, viewer, person: behind })
    this.conn?.send({ t: 'resize', id: localId, cols, rows, borrowed: true, viewer, person: behind })
  }

  /**
   * One screen here says which of its panes are on it. Only a borrow whose answer CHANGED
   * is re-stated, so a window repeating itself every few seconds sends nothing.
   */
  setVisible(viewer: string, localIds: string[]): void {
    this.shown.set(viewer, new Set(localIds))
    this.restate()
  }

  private restate(): void {
    for (const l of this.lent.values()) {
      if (!this.watching.has(l.localId)) continue
      const behind = this.personBehind(l.localId, l.viewer)
      if (behind === l.person) continue
      l.person = behind
      this.conn?.send({ t: 'resize', id: l.localId, cols: l.cols, rows: l.rows, borrowed: true, viewer: l.viewer, person: behind })
    }
  }

  /**
   * Nobody is at this desk any more, or somebody is again.
   *
   * A borrow the far end holds for us is what stops IT closing that pane on its own idle
   * clock, and a mirror's borrow has no heartbeat to carry the news - it is re-stated only
   * when the pane repaints, which an idle pane never does. So the same frame goes out
   * again with the answer changed, and the owner's clock starts or stops within one tick.
   * An older host ignores the extra field, which leaves exactly what shipped before it.
   */
  restatePresence(person: boolean): void {
    this.person = person
    this.restate()
  }

  /**
   * Tell that device whether somebody is at THIS desk.
   *
   * Separate from `restatePresence`, which re-states borrows and so says nothing at all
   * while no pane is being mirrored. This one is about the desk itself, and the far end
   * draws it on our row in its Devices list.
   */
  sendPresence(person: boolean): void {
    this.conn?.send({ t: 'presence', person })
  }

  /** Tell that machine this desk's own numbers and whether it reaches Discord. */
  sendDesk(report: DeskReport): void {
    this.desk = report
    this.conn?.send({ t: 'desk', report })
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
    // 30 s, not the 15 s default: the PC answered in 9.8 s and 12.1 s and once not within
    // 15 s (2026-10-01), and a list that times out used to refuse `pf open --on` outright.
    return this.ask<Project[]>({ t: 'projects' }, 30_000)
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

  /** The owning machine's disk transcript, not this mirror's 400 KB live tail. */
  log(localId: string, bytes?: number): Promise<string> {
    return this.ask<string>({ t: 'log', id: localId, bytes }, 15_000).catch((err: Error) => {
      throw new Error(`${this.peer.name} cannot provide remote history: ${err.message}`)
    })
  }

  /**
   * Replace one mirror from the owner's transcript in wire order. Unlike `log`, this
   * deliberately emits reset before resolving, so callers never race a later data frame.
   */
  replayHistory(localId: string): Promise<boolean> {
    return this.ask<boolean>({ t: 'replay', id: localId }, 15_000).catch((err: Error) => {
      throw new Error(`${this.peer.name} cannot replay remote history: ${err.message}`)
    })
  }

  /**
   * `pf tell` to one of that machine's panes, answered with what happened to the prompt.
   *
   * The owner runs its own `tellPane` and replies with the outcome, so the line printed here
   * is the owner's knowledge, not a guess: s42-mus4a344 (2026-10-03) printed "told" for a
   * prompt that never left this desk. An owner from before this answer exists gets the one
   * `prompt` intent it understands, and the outcome says that no receipt is coming.
   * Ids cross bare; the outcome comes back under `@<device>/`.
   */
  tellPane(localId: string, text: string): Promise<TellOutcome> {
    const id = joinId(this.peer.id, localId)
    const title = this.available.find((s) => s.id === localId)?.title ?? ''
    if (!this.conn?.ready) return Promise.resolve<TellOutcome>({ kind: 'failed', id, title, reason: `${this.peer.name} is not connected right now` })
    if (this.conn.peer.tellReceipt !== true) {
      if (!this.sendPrompt(localId, text)) return Promise.resolve<TellOutcome>({ kind: 'failed', id, title, reason: `${this.peer.name} is not connected right now` })
      return Promise.resolve<TellOutcome>({ kind: 'queued', id, title, reason: OLDER_TELL_REASON })
    }
    // The owner waits up to TELL_WAIT_MS for its own receipt; the extra 15 s is the link.
    return this.ask<unknown>({ t: 'tell', ref: localId, id: localId, text }, TELL_WAIT_MS + 15_000).then(
      (raw) => outcomeFrom(raw, this.peer.id, id, title),
      (err: Error) => ({
        kind: 'failed' as const,
        id,
        title,
        // A timeout or a dropped link leaves the prompt's fate over there unknown, and
        // "failed" must not read as "safe to send again".
        reason: /did not answer|Connection lost/.test(err.message)
          ? `${err.message} - the prompt may still be waiting there, so check that chat before sending it again`
          : err.message
      })
    )
  }

  /**
   * `pf composer` on one of that machine's panes, mirrored here or not: the owner reads its
   * own input box (`sessions:draft` there) and answers. Before this, the app looked for an
   * `@device/` id among this desk's own panes and `pf` said "is not running" (s54, 2026-10-03).
   */
  draftOf(localId: string): Promise<PaneDraft | null> {
    if (!this.conn?.ready) return Promise.resolve({ unavailable: `${this.peer.name} is not connected right now` })
    if (this.conn.peer.draftRead !== true) return Promise.resolve({ unavailable: olderDraftReason(this.peer.name) })
    return this.ask<unknown>({ t: 'draft', id: localId }).then(
      (raw) => draftFrom(raw, this.peer.name),
      (err: Error) => ({ unavailable: err.message })
    )
  }

  /** Checked on every pane list the owner sends; see `gone`. */
  private listWaits = new Set<() => void>()

  /**
   * True once a pane list FROM the owner no longer has `localId`; false if `ms` passes first.
   * Only the owner's own list counts: this desk hides a row it asked to close
   * (`Remote.closeOn`), and a dropped link empties the list, so neither is proof it closed.
   */
  gone(localId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.available.some((s) => s.id === localId)) finish(true)
      }
      const finish = (v: boolean): void => {
        clearTimeout(timer)
        this.listWaits.delete(check)
        resolve(v)
      }
      const timer = setTimeout(() => finish(false), ms)
      this.listWaits.add(check)
    })
  }

  /** Save Keep open on the machine that actually owns the pane. */
  setKeepOpen(localId: string, keep: boolean): Promise<boolean> {
    return this.ask<boolean>({ t: 'keep', id: localId, keep }, 10_000).catch((err: Error) => {
      throw new Error(`${this.peer.name} could not change Keep open: ${err.message}`)
    })
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
  takeBack(localId: string, now = false): Promise<HandoffItem[]> {
    // `now` is dropped on the floor by a host older than it, which then queues the pane
    // as before - the report says so, and nothing is killed either way.
    return this.ask<HandoffItem[]>(now ? { t: 'takeback', id: localId, now: true } : { t: 'takeback', id: localId }, HANDOFF_ASK_MS)
  }

  handoff(payload: HandoffPayload, file: Buffer | null): Promise<HandoffResult> {
    if (payload.spec.agent !== 'shell' && !this.canResumeHandoff(payload.spec.agent || 'claude')) {
      return Promise.reject(new Error('Update PaneForge on the receiving device before opening a conversation there. The original stays here.'))
    }
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

  canResumeHandoff(agent: string): boolean {
    return this.status === 'online' && this.conn?.peer.handoffResume?.includes(agent) === true
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
    this.peerVersion = conn.peer.version || ''
    this.peerPerson = conn.peer.person
    if (conn.peer.id && conn.peer.id !== this.peer.id) this.emit('identified', conn.peer)
    conn.on('msg', (m: Msg) => this.receive(m))
    if (this.desk) conn.send({ t: 'desk', report: this.desk })
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
        for (const check of [...this.listWaits]) check()
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
      case 'typed': {
        const id = String(m.id ?? '')
        const line = String(m.line ?? '')
        if (id && line.trim().length > 1)
          this.emit('typed', joinId(this.peer.id, id), line, m.origin === 'app' ? 'app' : 'person')
        return
      }
      case 'buffer': {
        const id = String(m.id ?? '')
        this.buffers.set(id, new OutBuffer(BUFFER_LIMIT))
        // The owner can prepend mode restoration to a full-sized tail. Let OutBuffer
        // parse that prefix before clipping, or native scrolling is lost on attach.
        this.buffers.get(id)!.push(String(m.data ?? ''))
        // A reconnect replaces the scrollback wholesale, so the pane has to redraw
        // from it rather than append to what it already had.
        this.emit('reset', joinId(this.peer.id, id))
        return
      }
      case 'presence':
        // Somebody arrived at that desk, or left it. `status` is what the manager turns
        // into a redraw of the Devices list.
        this.peerPerson = typeof m.person === 'boolean' ? m.person : undefined
        this.emit('status')
        return
      case 'desk':
        this.peerDesk = readDeskReport(m.report)
        this.emit('desk')
        return
      case 'attention':
        this.emit('attention', this.tag(m.session as Session))
        return
      case 'reviews':
        this.emit('reviews', Array.isArray(m.list) ? m.list as ReviewRecord[] : [])
        if (typeof m.cursor === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(m.cursor)) this.conn?.send({ t: 'reviews', cursor: m.cursor })
        return
      case 'review':
        this.emit('review', m.review as ReviewRecord)
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
      case 'log':
        this.settle(m, Buffer.from(String(m.data ?? ''), 'base64').toString('utf8'))
        return
      case 'replay': {
        const id = String(m.id ?? '')
        const raw = Buffer.from(String(m.data ?? ''), 'base64').toString('utf8')
        const buffer = new OutBuffer(BUFFER_LIMIT)
        buffer.push(raw)
        this.buffers.set(id, buffer)
        // Keep this synchronous and before settle: any later data frame appends after
        // this reset, while the renderer writes the full snapshot it receives here.
        this.emit('reset', joinId(this.peer.id, id), raw)
        this.settle(m, true)
        return
      }
      case 'kept':
        this.settle(m, m.keep === true)
        return
      case 'told':
        this.settle(m, m.outcome)
        return
      case 'drafted':
        this.settle(m, m.draft)
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
        if (m.t.startsWith('screen:')) this.emit('screen', m)
        return
    }
  }

  /**
   * The screen view's frames go out on this connection when it is up. Returns the other
   * end's identity so the caller can tell an older build (no `screenView`) from a yes.
   */
  sendScreen(m: Msg): PeerIdentity | null {
    if (this.status !== 'online' || !this.conn?.ready) return null
    this.conn.send(m)
    return this.conn.peer
  }

  /** Who is on the other end right now, or null when not connected. */
  identity(): PeerIdentity | null {
    return this.status === 'online' && this.conn?.ready ? this.conn.peer : null
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

  /**
   * Stamp the device onto a session and namespace its id. The owner's `number` rides
   * through untouched; `machine` is read off the handshake, so the card can say "Mac 3".
   */
  private tag(s: Session): Session {
    const platform = this.conn?.peer.platform
    return {
      ...s,
      id: joinId(this.peer.id, s.id),
      remote: { device: this.peer.id, name: this.peer.name, ...(platform && platform !== 'unknown' ? { machine: machineOf(platform) } : {}) }
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
    this.peerVersion = ''
    this.peerPerson = undefined
    this.peerDesk = undefined
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
