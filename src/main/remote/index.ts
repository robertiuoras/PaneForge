// One object the rest of the main process talks to about other devices.
//
// It owns three things that only make sense together: the listener that answers for
// this device's panes, the clients that mirror other devices' panes into this window,
// and the LAN broadcast that lets the two find each other without an IP being typed.
//
// Session ids are the seam. A mirrored pane's id is `@<device>/<id>`, so `route()`
// can hand any id in the app to the right side without anything above it knowing
// which machine the agent is actually running on.

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { app } from 'electron'
import type {
  Project,
  RemoteAsk,
  RemoteConfig,
  RemoteFound,
  RemotePeer,
  RemoteState,
  RemoteWaiting,
  Session,
  StartSessionRequest
} from '../../shared/types'
import type { AgentInfo } from '../../shared/agents'
import type { HandoffPayload, HandoffResult } from '../../shared/handoff'
import { DEFAULT_REMOTE_PORT, getConfig, setConfig } from '../config'
import { Discovery, localAddresses } from './discover'
import { RemoteHost, type HostBackend } from './host'
import { RemoteClient, joinId, splitId } from './client'
import { dropSelf, isSelfPeer } from './peers'
import { makeInvite, readInvite } from './invite'
import { APPROVE_MS, Conn, deriveKey, newCode, type Msg, type PeerIdentity } from './wire'

export { joinId, splitId }

/** The card's own fields, without the resolver the UI has no business seeing. */
function pickAsk(a: RemoteAsk & { answer(ok: boolean): void }): RemoteAsk {
  return { id: a.id, name: a.name, platform: a.platform, address: a.address, sas: a.sas, at: a.at }
}

/** What came of a pasted invite. `code` is set when the paste was a bare pairing code. */
export interface PairFromText {
  ok: boolean
  error?: string
  code?: string
  name?: string
}

export class Remote extends EventEmitter {
  private discovery: Discovery
  private host: RemoteHost
  private clients = new Map<string, RemoteClient>()
  private started = false
  /**
   * A device asking THIS one to let it in, and the answer it is waiting for.
   *
   * One at a time on purpose. Two cards on screen at once is a person approving whichever
   * is on top, and the whole safety of this path is that the six digits get compared - so
   * a second request while one is open is refused rather than stacked.
   */
  private asking: (RemoteAsk & { answer(ok: boolean): void }) | null = null
  /** A request THIS device sent, while it waits to be approved over there. */
  private waiting: RemoteWaiting | null = null

  constructor(backend: HostBackend) {
    super()
    this.me = () => {
      const c = getConfig().remote
      return { id: c.id, name: c.name, platform: process.platform, version: app.getVersion() }
    }
    this.host = new RemoteHost(backend, this.me, () => getConfig().remote.code)
    this.host.on('changed', () => this.changed())
    this.host.onAsk = (peer, sas, address) => this.onAsked(peer, sas, address)
    this.discovery = new Discovery({ ...this.me(), port: getConfig().remote.port, hosting: false })
    this.discovery.on('found', () => this.changed())
  }

  /** How this device introduces itself on both the listener and every client. */
  private readonly me: () => PeerIdentity

  /** Called once the app is up: brings up whatever the saved config asked for. */
  start(): void {
    if (this.started) return
    this.started = true
    // First launch after upgrading generates this device's id and code in memory;
    // writing them now is what stops them being different on the next launch, which
    // would quietly break every pairing the other device had just made.
    const c = getConfig().remote
    // A device paired with ITSELF mirrors every one of its own panes back into its own
    // window, so every session is on screen twice - which is exactly what a desk here was
    // doing, its peer list holding its own id at its own tailnet address. `pair` refuses
    // that now; this line clears the ones already saved, because the config outlives the
    // bug and nothing else would ever take it back out.
    c.peers = dropSelf(c.peers, c.id)
    setConfig({ remote: c })
    if (c.host) this.host.start(c.port)
    this.discovery.update({ port: c.port, hosting: c.host && c.discoverable })
    this.discovery.start()
    for (const peer of c.peers) {
      const client = this.adopt(peer)
      if (peer.auto) client.connect()
    }
    this.changed()
  }

  stop(): void {
    this.discovery.stop()
    this.host.stop()
    for (const c of this.clients.values()) c.disconnect()
    this.clients.clear()
  }

  // -------------------------------------------------------------------------
  // What the rest of the app asks

  /** Every mirrored pane, from every connected device. */
  sessions(): Session[] {
    const out: Session[] = []
    for (const c of this.clients.values()) out.push(...c.list())
    return out
  }

  /** Does this id belong to another device? */
  owns(id: string): boolean {
    const cut = splitId(id)
    return Boolean(cut && this.clients.has(cut.peer))
  }

  buffer(id: string): string {
    const cut = splitId(id)
    if (!cut) return ''
    return this.clients.get(cut.peer)?.buffer(cut.local) ?? ''
  }

  /** Forward a pane message to the device that owns it. Silent if it went away. */
  send(id: string, msg: Msg): void {
    const cut = splitId(id)
    if (!cut) return
    this.clients.get(cut.peer)?.send({ ...msg, id: cut.local })
  }

  /** Start a pane on another device - the "new session over there" path. */
  startOn(device: string, req: StartSessionRequest): Promise<Session> {
    const client = this.clients.get(device)
    if (!client) return Promise.reject(new Error('That device is not connected'))
    return client.startSession(req).then((s) => {
      this.rememberWatch(client)
      return s
    })
  }

  projectsOn(device: string): Promise<Project[]> {
    const client = this.clients.get(device)
    if (!client) return Promise.reject(new Error('That device is not connected'))
    return client.projects()
  }

  /** Deliver one pane's handoff to a device. See `main/handoff.ts` for what one is. */
  handoffTo(device: string, payload: HandoffPayload, file: Buffer | null): Promise<HandoffResult> {
    const client = this.clients.get(device)
    if (!client || client.status !== 'online') {
      return Promise.reject(new Error('That device is not connected'))
    }
    return client.handoff(payload, file).then((r) => {
      this.rememberWatch(client)
      return r
    })
  }

  /** Keep a pick the link made on its own (a launch, a handoff) across restarts. */
  private rememberWatch(client: RemoteClient): void {
    this.savePeer({ ...client.peer, watch: client.watched() })
    this.changed()
  }

  /** The name a handoff commit mentions - the device's, or its id when unpaired. */
  peerName(device: string): string {
    return getConfig().remote.peers.find((p) => p.id === device)?.name || device
  }

  agentsOn(device: string): Promise<AgentInfo[]> {
    const client = this.clients.get(device)
    if (!client) return Promise.reject(new Error('That device is not connected'))
    return client.agents()
  }

  // -------------------------------------------------------------------------
  // Settings, as the dialog drives them

  state(): RemoteState {
    const c = getConfig().remote
    const beacons = this.discovery.list()
    const paired = new Set(c.peers.map((p) => p.id))
    const found: RemoteFound[] = beacons
      .filter((b) => !paired.has(b.id))
      .map((b) => ({
        id: b.id,
        name: b.name,
        address: b.address,
        port: b.port,
        platform: b.platform,
        version: b.version,
        seen: b.seen
      }))
    return {
      self: {
        id: c.id,
        name: c.name,
        code: c.code,
        port: c.port,
        hosting: this.host.listening,
        error: this.host.error || undefined,
        addresses: localAddresses(),
        pairByAsking: c.pairByAsking !== false
      },
      peers: c.peers.map((p) => {
        const client = this.clients.get(p.id)
        const watched = new Set(client?.watched() ?? p.watch ?? [])
        return {
          ...p,
          status: client?.status ?? 'off',
          error: client?.error || undefined,
          panes: (client?.panes() ?? []).map((s) => ({
            id: s.id,
            title: s.title,
            cwd: s.cwd,
            agent: s.agent,
            status: s.status,
            watched: watched.has(s.id)
          })),
          sessions: client?.list().length ?? 0,
          since: client?.since || undefined,
          seen: beacons.some((b) => b.id === p.id)
        }
      }),
      found,
      guests: this.host.list(),
      asking: this.asking ? { ...pickAsk(this.asking) } : undefined,
      waiting: this.waiting ?? undefined
    }
  }

  // -------------------------------------------------------------------------
  // Pairing by asking, rather than by typing what is on the other screen
  //
  // See `wire.ts` for why the six digits are the authentication and the button is not.

  /**
   * A device on the network wants in. Put it on screen and wait for a person.
   *
   * Refused outright while this device is not hosting or not discoverable: a listener that
   * is off is off, and one that has been asked to stay off the broadcast has been asked not
   * to invite strangers either.
   */
  private onAsked(peer: PeerIdentity, sas: string, address: string): Promise<boolean> {
    const c = getConfig().remote
    if (!c.host || !c.pairByAsking) return Promise.resolve(false)
    if (this.asking) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const answer = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.asking?.answer === answer) this.asking = null
        this.changed()
        resolve(ok)
      }
      // The card cannot outlive the socket's own budget, or it sits on screen offering to
      // approve something that has already given up.
      const timer = setTimeout(() => answer(false), APPROVE_MS - 5_000)
      timer.unref?.()
      this.asking = {
        id: peer.id,
        name: peer.name,
        platform: peer.platform,
        address,
        sas,
        at: Date.now(),
        answer
      }
      this.changed()
    })
  }

  /** Approve or refuse the request on screen. Anything else is a refusal. */
  answerPair(ok: boolean): void {
    this.asking?.answer(ok)
  }

  /**
   * Ask a device found on the network to let this one in.
   *
   * Returns '' when the pair went through. The six digits reach the UI through `waiting`
   * as soon as they are known - long before this resolves - because comparing them with
   * the other screen is what the person does WHILE this is waiting.
   */
  async askToPair(input: { address: string; port: number; name?: string }): Promise<string> {
    if (this.waiting) return 'Already waiting on a pairing request. Cancel it first.'
    const address = input.address.trim()
    if (!address) return 'Enter the other device’s address.'
    const port = Math.floor(input.port) || DEFAULT_REMOTE_PORT
    let code = ''
    try {
      code = await this.requestCode(address, port, input.name)
    } catch (err) {
      this.waiting = null
      this.changed()
      return (err as Error).message || 'That device did not answer.'
    }
    this.waiting = null
    this.changed()
    // From here it is an ordinary pairing with a code, which is what keeps every stored
    // peer, every reconnect and `New code` behaving exactly as before.
    return await this.pair({ address, port, code, name: input.name })
  }

  /** Stop waiting on a request this device sent. The socket's own timeout does the rest. */
  cancelAsk(): void {
    this.waiting = null
    this.changed()
  }

  private requestCode(address: string, port: number, name?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = netConnect({ host: address, port })
      const conn = new Conn(socket, this.me())
      socket.setTimeout(APPROVE_MS)
      socket.on('timeout', () => conn.close())
      conn
        .askPair((sas, peer) => {
          this.waiting = {
            name: peer.name || name || address,
            address,
            platform: peer.platform,
            sas,
            at: Date.now()
          }
          this.changed()
        })
        .then((code) => {
          conn.close()
          resolve(code)
        })
        .catch((err: Error) => {
          conn.close()
          reject(err)
        })
    })
  }

  setHosting(on: boolean): void {
    const c = this.patch({ host: on })
    if (on) this.host.start(c.port)
    else this.host.stop()
    this.discovery.update({ hosting: on && c.discoverable, port: c.port })
    this.changed()
  }

  setPort(port: number): void {
    const clamped = Math.min(65535, Math.max(1024, Math.floor(port) || DEFAULT_REMOTE_PORT))
    const c = this.patch({ port: clamped })
    if (c.host) this.host.start(clamped)
    this.discovery.update({ port: clamped })
    this.changed()
  }

  setPairByAsking(on: boolean): void {
    this.patch({ pairByAsking: on })
    // A request already on screen was allowed under the old setting; switching this off is
    // an answer to it, and the honest answer is no.
    if (!on) this.answerPair(false)
    this.changed()
  }

  setDiscoverable(on: boolean): void {
    const c = this.patch({ discoverable: on })
    this.discovery.update({ hosting: c.host && on })
    this.changed()
  }

  rotateCode(): void {
    this.patch({ code: newCode() })
    // Everyone paired against the old code is now wrong, and their sockets are
    // already authenticated, so they have to be cut rather than left running.
    this.host.stop()
    if (getConfig().remote.host) this.host.start(getConfig().remote.port)
    this.changed()
  }

  rename(name: string): void {
    const clean = name.trim().slice(0, 40)
    if (!clean) return
    this.patch({ name: clean })
    this.discovery.update({ name: clean })
    this.changed()
  }

  /**
   * Prove the address and the code before saving anything. Pairing that "succeeded"
   * and then sat in an error state is the thing this avoids: if the code is wrong,
   * the dialog says so while the person still has it on screen.
   */
  async pair(input: { address: string; port: number; code: string; name?: string }): Promise<string> {
    const address = input.address.trim()
    if (!address) return 'Enter the other device’s address.'
    const port = Math.floor(input.port) || DEFAULT_REMOTE_PORT
    const code = input.code.trim().toUpperCase()
    if (code.replace(/[^A-Z0-9]/g, '').length < 6) return 'That pairing code looks too short.'
    // A code that does not even derive is not worth opening a socket for.
    try {
      await deriveKey(code)
    } catch {
      return 'That pairing code is not valid.'
    }
    const probe: RemotePeer = {
      id: `pending-${randomBytes(4).toString('hex')}`,
      name: input.name?.trim() || address,
      address,
      port,
      code,
      auto: true
    }
    const error = await this.probe(probe)
    if (error) return error
    return ''
  }

  /**
   * The one line to copy. Everything the other device needs to reach this one, packed
   * so that pairing is a paste rather than three typed fields. See `invite.ts` for why
   * carrying the code in it is no more exposed than showing it on screen, and for the
   * expiry that is the thing it adds.
   */
  invite(): string {
    const c = getConfig().remote
    return makeInvite({ name: c.name, addresses: localAddresses(), port: c.port, code: c.code })
  }

  /**
   * Pair from whatever was pasted.
   *
   * An invite carries every address the other device answers on, and only that device
   * knows which of them this one can route to - a laptop on Wi-Fi and a desktop on
   * Ethernet often share neither subnet nor a working `.local` name. So they are tried in
   * order and the first that answers wins, rather than making the person guess. A refusal
   * from every one of them reports the LAST error, which is the one about the network
   * rather than the one about the code.
   */
  async pairFromText(text: string): Promise<PairFromText> {
    const read = readInvite(text)
    if (read.kind === 'none')
      return { ok: false, error: 'That is not a PaneForge invite. Press “Copy invite” on the other device.' }
    if (read.kind === 'expired')
      return {
        ok: false,
        error: `That invite${read.name ? ` from ${read.name}` : ''} has expired. Press “Copy invite” over there again.`
      }
    // A bare code is not enough to reach anything, but it is what the person had before
    // this existed - so it fills the field in rather than being rejected.
    if (read.kind === 'code') return { ok: false, code: read.code, error: '' }
    const inv = read.invite
    let last = ''
    for (const address of inv.addresses) {
      const error = await this.pair({ address, port: inv.port, code: inv.code, name: inv.name })
      if (!error) return { ok: true, name: inv.name }
      last = error
    }
    return {
      ok: false,
      name: inv.name,
      error: last || `Could not reach ${inv.name || 'that device'} on any address in its invite.`
    }
  }

  forget(id: string): void {
    const client = this.clients.get(id)
    client?.disconnect()
    this.clients.delete(id)
    this.patch({ peers: getConfig().remote.peers.filter((p) => p.id !== id) })
    this.changed()
  }

  setConnected(id: string, on: boolean): void {
    const client = this.clients.get(id)
    if (!client) return
    if (on) client.connect()
    else client.disconnect()
    this.patch({
      peers: getConfig().remote.peers.map((p) => (p.id === id ? { ...p, auto: on } : p))
    })
    this.changed()
  }

  scan(): void {
    this.discovery.query()
  }

  /**
   * Pick which of a device's panes this window mirrors. `all` mirrors whatever it has,
   * now and later; otherwise `ids` is the whole pick, replacing the previous one.
   *
   * Saved on the peer, so a reconnect - or the next launch - brings back the same panes
   * rather than asking again or, as before, mirroring the lot.
   */
  setWatch(device: string, ids: string[], all = false): void {
    const client = this.clients.get(device)
    if (!client) return
    if (all) client.setMirrorAll(true)
    else client.setWatch(ids)
    this.savePeer({ ...client.peer, watch: client.watched(), mirrorAll: all })
    this.changed()
  }

  // -------------------------------------------------------------------------

  /**
   * Connect once with a throwaway client to learn the device's real id, then keep it.
   * The id is what session namespacing hangs off, and only the handshake knows it.
   */
  private probe(peer: RemotePeer): Promise<string> {
    return new Promise((resolve) => {
      const client = new RemoteClient(peer, this.me)
      let settled = false
      const done = (err: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          client.disconnect()
          resolve(err)
          return
        }
        resolve('')
      }
      const timer = setTimeout(() => {
        client.disconnect()
        done('That device did not answer in time.')
      }, 20_000)
      client.on('identified', (identity: PeerIdentity) => {
        // Pairing with yourself is always a mistake and never a harmless one: the link
        // comes up, every local pane arrives back mirrored, and the window lists the same
        // work twice with no way to tell which copy is the real one. The handshake is the
        // first moment the far end's id is known, so it is the first moment this can be
        // caught - an address check could not, a machine answers on several.
        if (isSelfPeer(identity.id, getConfig().remote.id)) {
          client.disconnect()
          done('That is this device. Pair the OTHER machine with it.')
          return
        }
        const known = this.clients.get(identity.id)
        if (known) {
          // Re-pairing a device we already have: update it in place rather than
          // ending up with the same machine listed twice under two ids.
          client.disconnect()
          const next: RemotePeer = { ...known.peer, address: peer.address, port: peer.port, code: peer.code, auto: true }
          this.savePeer(next)
          known.update(next)
          known.connect()
          done('')
          return
        }
        const next: RemotePeer = {
          ...peer,
          id: identity.id,
          name: peer.name === peer.address && identity.name ? identity.name : peer.name
        }
        client.peer = next
        this.savePeer(next)
        this.hold(identity.id, client)
        done('')
      })
      client.on('status', () => {
        if (client.status === 'error') done(client.error || 'Could not connect to that device.')
      })
      client.connect()
    })
  }

  /** Build (or reuse) the client for a saved peer. */
  private adopt(peer: RemotePeer): RemoteClient {
    const existing = this.clients.get(peer.id)
    if (existing) {
      existing.update(peer)
      return existing
    }
    const client = new RemoteClient(peer, this.me)
    this.hold(peer.id, client)
    return client
  }

  private hold(id: string, client: RemoteClient): void {
    this.clients.set(id, client)
    client.on('sessions', () => {
      this.emit('sessions')
      this.changed()
    })
    client.on('data', (sessionId: string, data: string) => this.emit('data', sessionId, data))
    client.on('reset', (sessionId: string) => this.emit('reset', sessionId))
    client.on('attention', (s: Session) => this.emit('attention', s))
    client.on('status', () => this.changed())
  }

  private savePeer(peer: RemotePeer): void {
    const peers = getConfig().remote.peers.filter((p) => p.id !== peer.id)
    this.patch({ peers: [...peers, peer] })
  }

  private patch(p: Partial<RemoteConfig>): RemoteConfig {
    const next = { ...getConfig().remote, ...p }
    setConfig({ remote: next })
    return next
  }

  private changed(): void {
    this.emit('changed', this.state())
  }
}
