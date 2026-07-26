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
import { app } from 'electron'
import type {
  Project,
  RemoteConfig,
  RemoteFound,
  RemotePeer,
  RemoteState,
  Session,
  StartSessionRequest
} from '../../shared/types'
import type { AgentInfo } from '../../shared/agents'
import { DEFAULT_REMOTE_PORT, getConfig, setConfig } from '../config'
import { Discovery, localAddresses } from './discover'
import { RemoteHost, type HostBackend } from './host'
import { RemoteClient, joinId, splitId } from './client'
import { deriveKey, newCode, type Msg, type PeerIdentity } from './wire'

export { joinId, splitId }

export class Remote extends EventEmitter {
  private discovery: Discovery
  private host: RemoteHost
  private clients = new Map<string, RemoteClient>()
  private started = false

  constructor(backend: HostBackend) {
    super()
    this.me = () => {
      const c = getConfig().remote
      return { id: c.id, name: c.name, platform: process.platform, version: app.getVersion() }
    }
    this.host = new RemoteHost(backend, this.me, () => getConfig().remote.code)
    this.host.on('changed', () => this.changed())
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
    return client.startSession(req)
  }

  projectsOn(device: string): Promise<Project[]> {
    const client = this.clients.get(device)
    if (!client) return Promise.reject(new Error('That device is not connected'))
    return client.projects()
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
        addresses: localAddresses()
      },
      peers: c.peers.map((p) => {
        const client = this.clients.get(p.id)
        return {
          ...p,
          status: client?.status ?? 'off',
          error: client?.error || undefined,
          sessions: client?.list().length ?? 0,
          since: client?.since || undefined,
          seen: beacons.some((b) => b.id === p.id)
        }
      }),
      found,
      guests: this.host.list()
    }
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
