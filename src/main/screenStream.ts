/**
 * The other machine's screen in a pane: both halves of it, in the main process.
 *
 * SINK (the machine looking): a pane of kind `screen` in the grid. Its renderer owns the
 * RTCPeerConnection; this file only carries its signalling frames to the other machine
 * over the encrypted peer channel and hands the answers back. The pane is listed next to
 * the pty panes (`allSessions()` in index.ts) but lives HERE, not in SessionManager, so no
 * sleep, reclaim, restore or auto-close sweep ever considers it - there is no process to
 * stop, nothing to resume, and a screen view is not reopened on the next launch.
 *
 * SOURCE (the machine being looked at): a hidden capture window (`show: false`, never
 * focusable) that grabs the desktop with `getUserMedia` and answers each viewer's offer,
 * plus a row on this machine's own sessions list saying who is watching. Closing that row
 * ends the view on both machines. Capture starts on the first offer and stops when the
 * last viewer leaves.
 *
 * Decisions (state machine words, zoom, `query session`, candidate rewrite) are in
 * src/shared/screenStream.ts; design in docs/superpowers/specs/2026-09-23-pc-screen-design.md.
 */

import { BrowserWindow, desktopCapturer, ipcMain, screen, type IpcMainEvent } from 'electron'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { hostname, userInfo } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Msg } from './remote/wire'
import { screenLog } from './screenView'
import { screenPeer, type ScreenPeer } from '../shared/screenView'
import {
  SCREEN_FPS,
  consoleReading,
  rewriteCandidate,
  screenPaneTitle,
  wakeCommand,
  watchedTitle
} from '../shared/screenStream'
import type { Session } from '../shared/types'

/** Device id the loopback test mode uses for "the other machine". */
const LOOPBACK = 'loopback'
/** A source view whose viewer has gone quiet this long is dropped and capture stopped. */
const SOURCE_ORPHAN_MS = 30_000
const WAKE_TIMEOUT_MS = 20_000

export interface ScreenRemote {
  screenSend(device: string, m: Msg): 'sent' | 'offline' | 'old'
  screenPeer(device: string): { peer: { name: string }; address: string } | null
}

export interface ScreenEventIn {
  device: string
  name: string
  address: string
  msg: Msg
}

interface SinkView {
  role: 'sink'
  session: Session
  device: string
  machine: string
  /** The source's last `screen:locked`, for `Wake the desktop`. */
  console?: { id: number | null; user: string }
}

interface SourceView {
  role: 'source'
  session: Session
  device: string
  watcher: string
  /** The sink's view id: what every frame to and from that machine is keyed by. */
  view: string
  address: string
  orphanTimer?: ReturnType<typeof setTimeout>
}

type View = SinkView | SourceView

/** Test mode: the sink looks at its own machine, through the real capture window. */
export function loopbackMode(): boolean {
  return process.env.PF_SCREEN_LOOPBACK === '1'
}

/**
 * Test modes for a headless copy: `1` = a capture window that draws a moving test card
 * instead of the desktop; `locked` = answer every offer as a detached console.
 */
function fakeCapture(): boolean {
  return process.env.PF_SCREEN_FAKE === '1'
}
function fakeLocked(): boolean {
  return process.env.PF_SCREEN_FAKE === 'locked'
}

/** `a=candidate:` lines inside an SDP, pointed at `address` the same way as trickled ones. */
export function rewriteSdp(sdp: string, address: string): string {
  if (!address) return sdp
  return sdp
    .split(/\r\n/)
    .map((line) => {
      if (!line.startsWith('a=candidate:')) return line
      const next = rewriteCandidate(line.slice(2), address)
      return next === null ? null : `a=${next}`
    })
    .filter((l): l is string => l !== null)
    .join('\r\n')
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`
}

function paneSession(id: string, title: string, screenInfo: NonNullable<Session['screen']>): Session {
  const now = Date.now()
  return {
    id,
    title,
    cwd: '',
    agent: 'screen',
    status: 'idle',
    lastOutput: now,
    lastKeyboard: now,
    createdAt: now,
    openedAt: now,
    screen: screenInfo
  }
}

export class ScreenViews extends EventEmitter {
  private readonly views = new Map<string, View>()
  private win: BrowserWindow | null = null
  private winReady: Promise<BrowserWindow> | null = null

  constructor(
    private readonly remote: ScreenRemote,
    /** Renderer-only delivery: SDP and candidates are not for the phone's event stream. */
    private readonly toWindow: (channel: string, ...args: unknown[]) => void,
    private readonly myName: () => string
  ) {
    super()
    ipcMain.on('screen-src', (e: IpcMainEvent, m: Msg) => {
      if (!this.win || e.sender !== this.win.webContents) return
      this.fromCapture(m)
    })
  }

  /** Every screen pane on this desk, sink or source row. */
  sessions(): Session[] {
    return [...this.views.values()].map((v) => v.session)
  }

  owns(id: string): boolean {
    return this.views.has(id)
  }

  // -------------------------------------------------------------------------
  // Sink

  /**
   * The quick button: a pane showing the paired machine's screen. A second press while
   * one is open answers with that pane rather than opening another.
   */
  open(peers: ScreenPeer[]): { ok: true; id: string } | { ok: false; message: string } {
    let device: string
    let machine: string
    if (loopbackMode()) {
      device = LOOPBACK
      machine = this.myName()
    } else {
      const peer = screenPeer(peers)
      if (!peer) return { ok: false, message: 'No other machine is paired with this one yet.' }
      if (peer.status !== 'online') return { ok: false, message: `${peer.name} is not connected right now.` }
      const id = (peer as ScreenPeer & { id?: string }).id
      if (!id) return { ok: false, message: `${peer.name} could not be found.` }
      device = id
      machine = peer.name
    }
    for (const v of this.views.values()) if (v.role === 'sink' && v.device === device) return { ok: true, id: v.session.id }
    const id = newId('screen')
    this.views.set(id, {
      role: 'sink',
      device,
      machine,
      session: paneSession(id, screenPaneTitle(machine), { role: 'sink', device, machine })
    })
    screenLog(`open: ${id} -> ${machine} (${device})`)
    this.emit('sessions')
    return { ok: true, id }
  }

  /** A frame from a sink pane's renderer, out to the machine it is looking at. */
  signal(id: string, m: Msg): 'sent' | 'offline' | 'old' {
    const v = this.views.get(id)
    if (!v || v.role !== 'sink' || typeof m?.t !== 'string' || !m.t.startsWith('screen:')) return 'offline'
    const res = this.post(v.device, { ...m, view: id, from: 'sink' })
    if (m.t === 'screen:offer') screenLog(`offer ${id} -> ${v.machine}: ${res}`)
    return res
  }

  /** `Wake the desktop`: `tscon <id> /dest:console` on the source, over ssh, on a press. */
  async wake(id: string): Promise<{ ok: boolean; message: string }> {
    const v = this.views.get(id)
    if (!v || v.role !== 'sink') return { ok: false, message: 'That view is closed.' }
    const cmd = wakeCommand(v.console?.id ?? null)
    const user = v.console?.user
    const address = this.remote.screenPeer(v.device)?.address
    if (!cmd || !user || !address) {
      return { ok: false, message: `${v.machine} did not say which desktop to wake. Unlock it there, or use Take control.` }
    }
    screenLog(`wake ${id}: ssh ${user}@${address} ${cmd}`)
    return new Promise((resolve) => {
      execFile(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${address}`, cmd],
        { timeout: WAKE_TIMEOUT_MS, windowsHide: true },
        (err, _out, errOut) => {
          if (err) {
            const why = String(errOut || err.message).trim().split(/\r?\n/).pop() || 'no answer'
            screenLog(`wake ${id} failed: ${why}`)
            resolve({ ok: false, message: `Could not wake ${v.machine}'s desktop: ${why}` })
          } else {
            screenLog(`wake ${id}: done`)
            resolve({ ok: true, message: `${v.machine}'s desktop is back on its screen.` })
          }
        }
      )
    })
  }

  // -------------------------------------------------------------------------
  // Both

  /** The close button on either kind of screen pane. */
  close(id: string): void {
    const v = this.views.get(id)
    if (!v) return
    if (v.role === 'sink') {
      this.post(v.device, { t: 'screen:stop', view: id, by: 'sink', from: 'sink' })
      screenLog(`closed ${id} (${v.machine})`)
    } else {
      this.post(v.device, { t: 'screen:stop', view: v.view, by: 'source', from: 'source' })
      this.stopSource(v, `closed here while ${v.watcher} was watching`)
    }
    this.views.delete(id)
    this.emit('sessions')
  }

  /** Every `screen:*` frame the peer channel delivered, from either connection. */
  onRemote(e: ScreenEventIn): void {
    const m = e.msg
    const view = typeof m.view === 'string' ? m.view : ''
    if (!view) return
    // Every frame says which end sent it: in loopback both ends are this process, and a
    // candidate looks the same in either direction.
    if (m.from === 'source') {
      const sink = this.views.get(view)
      if (sink?.role === 'sink' && sink.device === e.device) this.toSink(sink, e)
      return
    }
    this.asSource(e, view)
  }

  private toSink(v: SinkView, e: ScreenEventIn): void {
    const m = { ...e.msg }
    if (m.t === 'screen:answer' && typeof m.sdp === 'string') m.sdp = rewriteSdp(m.sdp, e.address)
    if (m.t === 'screen:ice' && typeof m.candidate === 'string' && e.address) {
      const c = rewriteCandidate(m.candidate, e.address)
      if (c === null) return
      m.candidate = c
    }
    if (m.t === 'screen:locked') {
      v.console = { id: typeof m.id === 'number' ? m.id : null, user: typeof m.user === 'string' ? m.user : '' }
      screenLog(`locked ${v.session.id}: ${m.detached ? `console detached (session ${m.id})` : m.why || 'capture black or refused'}`)
    }
    if (m.t === 'screen:stop') screenLog(`stopped by ${v.machine}: ${v.session.id}`)
    this.toWindow('screen:signal', v.session.id, m)
  }

  private post(device: string, m: Msg): 'sent' | 'offline' | 'old' {
    if (device === LOOPBACK) {
      const name = this.myName()
      setImmediate(() => this.onRemote({ device: LOOPBACK, name, address: '', msg: m }))
      return 'sent'
    }
    return this.remote.screenSend(device, m)
  }

  // -------------------------------------------------------------------------
  // Source

  private sourceFor(device: string, view: string): SourceView | undefined {
    for (const v of this.views.values()) if (v.role === 'source' && v.device === device && v.view === view) return v
    return undefined
  }

  private asSource(e: ScreenEventIn, view: string): void {
    const m = e.msg
    const v = this.sourceFor(e.device, view)
    if (m.t === 'screen:offer' && typeof m.sdp === 'string') {
      void this.offer(e, view, rewriteSdp(m.sdp, e.address))
      return
    }
    if (!v) return
    if (m.t === 'screen:ice' && typeof m.candidate === 'string') {
      const c = e.address ? rewriteCandidate(m.candidate, e.address) : m.candidate
      if (c === null) return
      this.win?.webContents.send('screen-src', { t: 'ice', view, candidate: c, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex })
      return
    }
    if (m.t === 'screen:stop') {
      this.stopSource(v, `${v.watcher} stopped watching`)
      this.views.delete(v.session.id)
      this.emit('sessions')
    }
  }

  private async offer(e: ScreenEventIn, view: string, sdp: string): Promise<void> {
    const reply = (m: Msg): void => void this.post(e.device, { ...m, view, from: 'source' })
    // A detached console has no desktop to capture: say so before trying, with what the
    // viewer needs to wake it.
    const detached = fakeLocked() ? { id: 1, user: userInfo().username } : await this.consoleDetached()
    if (detached) {
      reply({ t: 'screen:locked', detached: true, id: detached.id, user: detached.user })
      return
    }
    let sourceId = ''
    if (!fakeCapture()) {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        const primary = String(screen.getPrimaryDisplay().id)
        sourceId = (sources.find((s) => s.display_id === primary) ?? sources[0])?.id ?? ''
      } catch (err) {
        screenLog(`getSources failed: ${(err as Error).message}`)
      }
      if (!sourceId) {
        reply({ t: 'screen:locked', why: 'no screen to capture', user: userInfo().username })
        return
      }
    }
    let v = this.sourceFor(e.device, view)
    if (!v) {
      const id = newId('screen-src')
      const me = this.myName()
      v = {
        role: 'source',
        device: e.device,
        watcher: e.name,
        view,
        address: e.address,
        session: paneSession(id, watchedTitle(me, e.name), { role: 'source', device: e.device, machine: e.name })
      }
      this.views.set(id, v)
      this.emit('sessions')
      screenLog(`watched: ${e.name} (${e.device}) view ${view}`)
    }
    this.armOrphan(v)
    try {
      const win = await this.captureWindow()
      win.webContents.send('screen-src', { t: 'offer', view, sdp, sourceId, fake: fakeCapture(), fps: SCREEN_FPS })
    } catch (err) {
      screenLog(`capture window failed: ${(err as Error).message}`)
      reply({ t: 'screen:refused', message: `${this.myName()} could not start showing its screen.` })
    }
  }

  /** What the capture window said, relayed to the viewer it concerns. */
  private fromCapture(m: Msg): void {
    const view = typeof m.view === 'string' ? m.view : ''
    let v: SourceView | undefined
    for (const x of this.views.values()) if (x.role === 'source' && x.view === view) v = x
    if (!v) return
    const reply = (out: Msg): void => void this.post(v!.device, { ...out, view, from: 'source' })
    switch (m.t) {
      case 'answer':
        reply({ t: 'screen:answer', sdp: m.sdp })
        return
      case 'ice':
        reply({ t: 'screen:ice', candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex })
        return
      case 'failed':
        screenLog(`capture failed for ${v.watcher}: ${String(m.message)}`)
        reply({ t: 'screen:locked', why: String(m.message ?? 'capture refused'), user: userInfo().username })
        return
      case 'black':
        screenLog(`capture is black for ${v.watcher}`)
        void this.consoleId().then((id) => reply({ t: 'screen:locked', why: 'black', id, user: userInfo().username }))
        return
      case 'state':
        screenLog(`view ${view} (${v.watcher}): ${String(m.state)}`)
        if (m.state === 'connected') this.clearOrphan(v)
        else if (m.state === 'failed' || m.state === 'disconnected' || m.state === 'closed') this.armOrphan(v)
        return
    }
  }

  /** A viewer that went away without saying so (lid shut, link gone) stops the capture. */
  private armOrphan(v: SourceView): void {
    this.clearOrphan(v)
    v.orphanTimer = setTimeout(() => {
      if (!this.views.has(v.session.id)) return
      this.stopSource(v, `${v.watcher} went quiet`)
      this.views.delete(v.session.id)
      this.emit('sessions')
    }, SOURCE_ORPHAN_MS)
    v.orphanTimer.unref?.()
  }

  private clearOrphan(v: SourceView): void {
    if (v.orphanTimer) clearTimeout(v.orphanTimer)
    v.orphanTimer = undefined
  }

  private stopSource(v: SourceView, why: string): void {
    this.clearOrphan(v)
    screenLog(`stop source view ${v.view}: ${why}`)
    this.win?.webContents.send('screen-src', { t: 'stop', view: v.view })
    const left = [...this.views.values()].some((x) => x.role === 'source' && x !== v)
    if (!left) this.closeCaptureWindow()
  }

  private async consoleDetached(): Promise<{ id: number | null; user: string } | null> {
    if (process.platform !== 'win32') return null
    const text = await querySession()
    const user = userInfo().username
    const r = consoleReading(text, user)
    return r.detached ? { id: r.id, user } : null
  }

  private async consoleId(): Promise<number | null> {
    if (process.platform !== 'win32') return null
    return consoleReading(await querySession(), userInfo().username).id
  }

  private captureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed() && this.winReady) return this.winReady
    const win = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 320,
      height: 200,
      title: 'PaneForge screen capture',
      webPreferences: {
        // No remote content is ever loaded here: about:blank plus the script below, which
        // needs ipcRenderer to talk to this file. A separate in-memory partition keeps the
        // app window's permission handlers and storage out of it.
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        partition: 'screen-source'
      }
    })
    this.win = win
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.winReady = null
      }
    })
    this.winReady = win
      .loadURL('about:blank')
      .then(() => win.webContents.executeJavaScript(`(${captureScript.toString()})()`))
      .then(() => win)
    return this.winReady
  }

  private closeCaptureWindow(): void {
    const w = this.win
    this.win = null
    this.winReady = null
    if (w && !w.isDestroyed()) w.destroy()
  }

  /** Quit: tell every viewer, close the capture. */
  shutdown(): void {
    for (const v of this.views.values()) {
      if (v.role === 'source') this.post(v.device, { t: 'screen:stop', view: v.view, by: 'source', from: 'source' })
      else this.post(v.device, { t: 'screen:stop', view: v.session.id, by: 'sink', from: 'sink' })
    }
    this.views.clear()
    this.closeCaptureWindow()
  }
}

function querySession(): Promise<string> {
  return new Promise((resolve) => {
    execFile('query', ['session'], { timeout: 5000, windowsHide: true }, (_err, out) => resolve(String(out ?? '')))
  })
}

/** The short machine name, when the peer config has none. */
export function machineName(configured: string): string {
  return configured || hostname().split('.')[0]
}

/**
 * Runs INSIDE the hidden capture window (stringified and executed there). One capture
 * stream shared by every viewer; one RTCPeerConnection per viewer. Kept dependency-free
 * and plain JS: it is not bundled, it is `toString()`-ed.
 */
/* eslint-disable */
function captureScript(): void {
  const { ipcRenderer } = (window as any).require('electron')
  const pcs = new Map<string, RTCPeerConnection>()
  let stream: MediaStream | null = null
  let fakeTimer: any = null
  const out = (m: any): void => ipcRenderer.send('screen-src', m)

  async function capture(m: any): Promise<MediaStream> {
    if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return stream
    if (m.fake) {
      // A moving test card: a clock and a sweeping bar, so a frozen picture is visible.
      const c = document.createElement('canvas')
      c.width = 1280
      c.height = 720
      const g = c.getContext('2d') as CanvasRenderingContext2D
      let n = 0
      fakeTimer = setInterval(() => {
        n++
        g.fillStyle = '#1d2330'
        g.fillRect(0, 0, c.width, c.height)
        g.fillStyle = '#f0a868'
        g.fillRect((n * 12) % c.width, 300, 120, 120)
        g.fillStyle = '#ffffff'
        g.font = '64px sans-serif'
        g.fillText(`test screen ${new Date().toISOString().slice(11, 19)}`, 60, 120)
      }, 1000 / m.fps)
      stream = (c as any).captureStream(m.fps) as MediaStream
    } else {
      stream = await (navigator.mediaDevices as any).getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: m.sourceId,
            maxWidth: 3840,
            maxHeight: 2160,
            maxFrameRate: m.fps
          }
        }
      })
    }
    const track = (stream as MediaStream).getVideoTracks()[0]
    // Text on a desktop matters more than motion: keep it sharp, let the frame rate give.
    try {
      ;(track as any).contentHint = 'detail'
    } catch {}
    return stream as MediaStream
  }

  /** Locked or secure desktop: capture "works" and every pixel is black. */
  function looksBlack(s: MediaStream): Promise<boolean> {
    return new Promise((resolve) => {
      const v = document.createElement('video')
      v.muted = true
      v.srcObject = s
      void v.play().catch(() => {})
      setTimeout(() => {
        try {
          const c = document.createElement('canvas')
          c.width = 64
          c.height = 36
          const g = c.getContext('2d') as CanvasRenderingContext2D
          g.drawImage(v, 0, 0, 64, 36)
          const px = g.getImageData(0, 0, 64, 36).data
          let max = 0
          for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2])
          resolve(v.videoWidth > 0 && max < 10)
        } catch {
          resolve(false)
        }
        v.srcObject = null
      }, 1500)
    })
  }

  function stopAll(): void {
    if (pcs.size) return
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    if (fakeTimer) clearInterval(fakeTimer)
    fakeTimer = null
  }

  ipcRenderer.on('screen-src', async (_e: unknown, m: any) => {
    if (m.t === 'offer') {
      const old = pcs.get(m.view)
      if (old) {
        old.close()
        pcs.delete(m.view)
      }
      try {
        const s = await capture(m)
        const pc = new RTCPeerConnection({ iceServers: [] })
        pcs.set(m.view, pc)
        pc.onicecandidate = (ev) => {
          if (ev.candidate) out({ t: 'ice', view: m.view, candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex })
        }
        pc.onconnectionstatechange = () => out({ t: 'state', view: m.view, state: pc.connectionState })
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        const track = s.getVideoTracks()[0]
        const tr = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video')
        if (tr) {
          tr.direction = 'sendonly'
          await tr.sender.replaceTrack(track)
        } else pc.addTrack(track, s)
        await pc.setLocalDescription(await pc.createAnswer())
        out({ t: 'answer', view: m.view, sdp: pc.localDescription?.sdp })
        try {
          const sender = pc.getSenders().find((x) => x.track === track)
          if (sender) {
            const p = sender.getParameters() as any
            p.degradationPreference = 'maintain-resolution'
            await sender.setParameters(p)
          }
        } catch {}
        if (!m.fake && (await looksBlack(s))) out({ t: 'black', view: m.view })
      } catch (err: any) {
        out({ t: 'failed', view: m.view, message: String(err?.message || err) })
      }
      return
    }
    if (m.t === 'ice') {
      const pc = pcs.get(m.view)
      if (pc) pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex }).catch(() => {})
      return
    }
    if (m.t === 'stop') {
      pcs.get(m.view)?.close()
      pcs.delete(m.view)
      stopAll()
    }
  })
}
/* eslint-enable */
