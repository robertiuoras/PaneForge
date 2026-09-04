/**
 * The machinery behind a login pane: an ssh tunnel, a CDP socket, and a picture.
 *
 * Nothing here reaches the renderer except finished frames and a list of requests. The
 * renderer never speaks CDP - it has no Node, it has no socket, and a browser tab that
 * could open a debugger port would be a hole rather than a feature.
 *
 * Why a tunnel rather than opening the port: Chrome's debugger endpoint refuses a request
 * whose Host header is not a loopback name or a bare IP, and it binds 127.0.0.1 on the
 * machine it runs on. `ssh -N -L <free-local>:127.0.0.1:<port> <host>` keeps BOTH ends on
 * 127.0.0.1, so nothing on the far machine has to be reconfigured, no firewall rule is
 * added, and the debugger is never on a network interface at all.
 *
 * The arithmetic - flow control, coordinates, keys, the words on the card - is in
 * `shared/remoteLogin.ts` so that a test can drive it with no Chrome and no window.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app, clipboard } from 'electron'
// Electron 33's main process is Node 20, which has no global WebSocket - the picture is
// a CDP stream and CDP is a socket, so this is the one dependency the feature added.
import WebSocket from 'ws'
import {
  Pacer,
  STEPS,
  keyEvent,
  imagePathFromText,
  loginPaneTitle,
  mimeForImage,
  pasteImageScript,
  looksSignedIn,
  askAgain,
  machineWord,
  toRemotePoint,
  type FrameMeta,
  type LoginAsk,
  type LoginInput,
  type LoginRequest
} from '../shared/remoteLogin'

const MAX_BYTES = 256 * 1024

export function loginLogPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'remote-login.log')
}

function log(line: string): void {
  try {
    const file = loginLogPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // The log must never be what breaks the sign-in it is recording.
  }
}

export interface LoginDeps {
  /** The request list changed; the desk redraws its card and its pane header. */
  publish(reqs: LoginRequest[]): void
  /** A frame to paint, and the ack id the renderer must hand back once it has. */
  frame(id: string, data: string, meta: FrameMeta, ack: number): void
}

interface Live {
  req: LoginRequest
  ssh?: ChildProcess
  sshErr: string
  localPort: number
  ws?: WebSocket
  nextId: number
  waiting: Map<number, { ok: (v: Record<string, unknown>) => void; no: (e: Error) => void; method: string }>
  pacer: Pacer
  size: { w: number; h: number }
  /** The box on THIS screen, in its own pixels - what the picture is drawn into. */
  box: { w: number; h: number }
  step: number
  lastMeta: FrameMeta | null
  /** The frame that arrived while one was being painted - the newest, never a queue. */
  pendingData: string | null
  hint?: ReturnType<typeof setInterval>
  closed: boolean
}

const live = new Map<string, Live>()
let deps: LoginDeps | null = null
let seq = 0

export function initRemoteLogin(d: LoginDeps): void {
  deps = d
}

function publish(): void {
  deps?.publish(listLogins())
}

export function listLogins(): LoginRequest[] {
  return [...live.values()].map((l) => ({ ...l.req })).sort((a, b) => b.at - a.at)
}

/**
 * What each pane asked for last, so `pf login` on its own can ask again.
 *
 * Kept for as long as the app runs and not written to disk: it is a convenience for the
 * session that is still sitting there, and a pane id from a previous run names nothing.
 */
const lastAsk = new Map<string, LoginAsk>()

/** A script says it cannot get past a login. Nothing is opened yet - a person decides that. */
export function requestLogin(input: {
  site?: string
  url?: string
  host?: string
  port?: number
  machine?: string
  from?: string
  /** The asking pane wants the picture in front now, not a card to click. */
  open?: boolean
}): LoginRequest {
  // Everything the pane leaves out is what that same pane said last time - see `askAgain`.
  const from = input.from?.trim() || undefined
  const resolved = askAgain(from ? lastAsk.get(from) : undefined, {
    site: input.site,
    url: input.url,
    host: input.host,
    port: input.port,
    machine: input.machine
  })
  if (!resolved.ok) throw new Error(resolved.why)
  const site = resolved.ask.site
  const url = resolved.ask.url
  const host = resolved.ask.host
  input = { ...input, port: resolved.ask.port, machine: resolved.ask.machine }
  if (from) lastAsk.set(from, resolved.ask)
  // The same site on the same machine asked twice is ONE card, not a pile of them: a
  // sweep that runs every ten minutes would otherwise paper the desk over a weekend.
  const already = [...live.values()].find(
    (l) => l.req.site === site && l.req.host === host && l.req.state !== 'failed'
  )
  if (already) {
    already.req.url = url
    if (input.open) already.req.show = true
    publish()
    return { ...already.req }
  }
  const req: LoginRequest = {
    id: `login-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    site,
    url,
    host,
    port: Number(input.port) || 9333,
    machine: input.machine?.trim() || machineWord(host, process.platform),
    at: Date.now(),
    state: 'waiting',
    from,
    show: input.open === true
  }
  live.set(req.id, {
    req,
    sshErr: '',
    localPort: 0,
    nextId: 1,
    waiting: new Map(),
    pacer: new Pacer(),
    size: { w: 1280, h: 800 },
    box: { w: 1280, h: 800 },
    step: 0,
    lastMeta: null,
    pendingData: null,
    closed: false
  })
  log(`asked site=${site} host=${host ?? 'local'} port=${req.port} url=${url}`)
  publish()
  return { ...req }
}

/** A free port on THIS machine, asked for by binding one and giving it straight back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function alive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

const TUNNEL_BUDGET_MS = 15_000

async function openTunnel(l: Live): Promise<void> {
  const host = l.req.host
  if (!host) {
    l.localPort = l.req.port
    if (!(await alive(l.localPort)))
      throw new Error(
        `nothing is answering on 127.0.0.1:${l.localPort} - the automation Chrome is not running on this machine`
      )
    return
  }
  const local = await freePort()
  l.localPort = local
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=5',
    '-N',
    '-L',
    `${local}:127.0.0.1:${l.req.port}`,
    host
  ]
  const ssh = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  l.ssh = ssh
  ssh.stderr?.on('data', (b: Buffer) => {
    l.sshErr = (l.sshErr + b.toString()).slice(-2000)
  })
  ssh.on('exit', (code) => {
    if (!l.closed && l.req.state !== 'failed') {
      fail(l, `the connection to ${host} closed (ssh exit ${code}). ${l.sshErr.trim()}`)
    }
  })
  log(`tunnel 127.0.0.1:${local} -> ${host}:${l.req.port}`)
  const until = Date.now() + TUNNEL_BUDGET_MS
  while (Date.now() < until) {
    if (l.closed) return
    if (await alive(local)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `${host} did not answer on port ${l.req.port} within 15s - is the automation Chrome running there? ${l.sshErr.trim()}`
  )
}

function fail(l: Live, message: string): void {
  l.req.state = 'failed'
  l.req.error = message
  log(`FAILED ${l.req.id}: ${message}`)
  stop(l)
  publish()
}

/** The page to drive: the one already showing that site, else a new tab. */
async function pageSocket(l: Live): Promise<string> {
  const base = `http://127.0.0.1:${l.localPort}`
  const wanted = new URL(l.req.url).host
  const list = (await (await fetch(`${base}/json/list`)).json()) as Array<{
    type: string
    url: string
    webSocketDebuggerUrl?: string
  }>
  const match = list.find((t) => {
    if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false
    try {
      return new URL(t.url).host === wanted
    } catch {
      return false
    }
  })
  if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl
  const made = (await (
    await fetch(`${base}/json/new?${encodeURIComponent(l.req.url)}`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl?: string }
  if (!made.webSocketDebuggerUrl) throw new Error('Chrome would not open a tab for that address')
  return made.webSocketDebuggerUrl
}

function send(l: Live, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const ws = l.ws
  if (!ws) return Promise.reject(new Error('not connected'))
  const id = l.nextId++
  return new Promise((ok, no) => {
    l.waiting.set(id, { ok, no, method })
    try {
      ws.send(JSON.stringify({ id, method, params }))
    } catch (e) {
      l.waiting.delete(id)
      no(e instanceof Error ? e : new Error(String(e)))
    }
    // A CDP call that never answers must not leave a promise pinned for the session's life.
    setTimeout(() => {
      if (l.waiting.delete(id)) no(new Error(`${method} did not answer`))
    }, 10_000)
  })
}

/** Fire and forget - a keystroke's reply is of no interest and waiting on it adds a round trip. */
function tell(l: Live, method: string, params: Record<string, unknown> = {}): void {
  try {
    l.ws?.send(JSON.stringify({ id: l.nextId++, method, params }))
  } catch {
    /* the socket is going away; the card will say so */
  }
}

/**
 * A tab that is still opening the page has no picture to send yet, and Chrome says so by
 * refusing the screencast: `Page.startScreencast` answers "Not attached to an active
 * page" for as long as the navigation is in flight. Measured 2026-09-03 on this Mac while
 * proving the view in a real window - EVERY open failed within 60ms of the navigate, the
 * card read "Not attached to an active page", and nothing in the app ever retried. So the
 * ask is repeated for a few seconds, and only a refusal that is not that one, or one that
 * outlives the wait, reaches the card.
 */
const CAST_WAIT_MS = 8000

async function startCast(l: Live): Promise<void> {
  const s = STEPS[l.step]
  const params = {
    format: 'jpeg',
    quality: s.quality,
    // Capped at the BOX, never the viewport: zoomed out, the far page is laid out at
    // twice the column's width, and sending twice the pixels the column can draw buys
    // nothing but bytes on the link this whole file exists to economise.
    maxWidth: Math.min(s.maxWidth, Math.max(320, Math.round(l.box.w))),
    maxHeight: Math.min(s.maxHeight, Math.max(240, Math.round(l.box.h))),
    everyNthFrame: 1
  }
  const until = Date.now() + CAST_WAIT_MS
  for (;;) {
    try {
      await send(l, 'Page.startScreencast', params)
      return
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (l.closed || Date.now() >= until || !/not attached to an active page/i.test(message)) throw e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

const FAKE_LAG_MS = Number(process.env.PF_REMOTE_LOGIN_FAKE_LAG_MS ?? 0)

export async function openLogin(id: string): Promise<{ ok: boolean; error?: string }> {
  const l = live.get(id)
  if (!l) return { ok: false, error: 'that sign-in request is gone' }
  // The window has it now, so nothing has to be raised again on the next list.
  l.req.show = false
  if (l.req.state === 'open' || l.req.state === 'signed in') return { ok: true }
  l.req.state = 'opening'
  l.req.error = undefined
  publish()
  try {
    await openTunnel(l)
    if (l.closed) return { ok: false, error: 'closed' }
    const url = await pageSocket(l)
    await connect(l, url)
    // Which tab, in the log: the picture can fail on a target that is no longer a live
    // page, and without this line nothing said which one had been picked.
    log(`connected ${url}`)
    await send(l, 'Page.enable')
    await send(l, 'Runtime.enable')
    await applySize(l)
    await send(l, 'Page.navigate', { url: l.req.url }).catch(() => ({}))
    await startCast(l)
    l.req.state = 'open'
    log(`open ${l.req.id} step=${l.step} size=${l.size.w}x${l.size.h} lag-stub=${FAKE_LAG_MS}ms`)
    watchUrl(l)
    publish()
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    fail(l, message)
    return { ok: false, error: message }
  }
}

function connect(l: Live, url: string): Promise<void> {
  return new Promise((ok, no) => {
    // A frame at quality 60 across a 1440px page is a few hundred kilobytes; the default
    // 100 MB cap is plenty, and the perMessageDeflate a JPEG cannot compress is not.
    const ws = new WebSocket(url, { perMessageDeflate: false })
    l.ws = ws
    const guard = setTimeout(() => no(new Error('Chrome did not accept the debugger connection')), 10_000)
    ws.on('open', () => {
      clearTimeout(guard)
      ok()
    })
    ws.on('error', (e: Error) => {
      clearTimeout(guard)
      no(new Error(`the debugger connection failed: ${e.message}`))
    })
    ws.on('close', () => {
      if (!l.closed && l.req.state !== 'failed') fail(l, 'the browser closed the connection')
    })
    ws.on('message', (d: Buffer | ArrayBuffer | Buffer[]) => onMessage(l, d.toString()))
  })
}

function onMessage(l: Live, raw: string): void {
  let msg: {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: Record<string, unknown>
    error?: { message?: string }
  }
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof msg.id === 'number') {
    const w = l.waiting.get(msg.id)
    if (!w) return
    l.waiting.delete(msg.id)
    // The call's own name goes in the message. Without it the card read "Not attached to
    // an active page" and nothing said WHICH request that answered, so proving the view in
    // a real window on 2026-09-03 cost an hour of guessing between five calls in a row.
    if (msg.error) w.no(new Error(`${w.method}: ${msg.error.message ?? 'CDP error'}`))
    else w.ok(msg.result ?? {})
    return
  }
  if (msg.method === 'Page.screencastFrame') {
    const p = msg.params as unknown as { data: string; metadata: FrameMeta; sessionId: number }
    l.lastMeta = p.metadata
    const deliver = l.pacer.frame(p.sessionId, Date.now())
    if (deliver !== null) deps?.frame(l.req.id, p.data, p.metadata, deliver)
    else l.pendingData = p.data
    // A frame that arrived while one was still being painted is never drawn and never
    // acked: Chrome sends the next only after an ack, so the queue cannot grow behind us.
  }
}

async function applySize(l: Live): Promise<void> {
  await send(l, 'Emulation.setDeviceMetricsOverride', {
    width: Math.max(320, Math.round(l.size.w)),
    height: Math.max(240, Math.round(l.size.h)),
    deviceScaleFactor: 1,
    mobile: false
  })
}

/** The renderer painted the frame it was given. This is the only thing that asks for another. */
export function paintedFrame(id: string, ack: number): void {
  const l = live.get(id)
  if (!l || !l.ws) return
  const finish = (): void => {
    const before = l.pacer.step
    const { rtt, next } = l.pacer.painted(Date.now())
    l.req.rtt = Math.round(rtt)
    l.req.step = l.pacer.step
    tell(l, 'Page.screencastFrameAck', { sessionId: ack })
    if (next !== null && l.lastMeta && l.pendingData) {
      deps?.frame(l.req.id, l.pendingData, l.lastMeta, next)
      l.pendingData = null
    }
    if (l.pacer.step !== before) {
      l.step = l.pacer.step
      const s = STEPS[l.step]
      log(
        `step ${before} -> ${l.step} (quality ${s.quality}, ${s.maxWidth}px) median rtt ${Math.round(
          l.pacer.medianRtt()
        )}ms id=${l.req.id}`
      )
      l.pacer.reset()
      void send(l, 'Page.stopScreencast')
        .then(() => startCast(l))
        .catch(() => {
          /* a step change that fails leaves the old cast running, which is the safe half */
        })
    }
    publish()
  }
  // The dev-window lag rig: the ack path is exactly where real lag lands, so stubbing it
  // here exercises the same code a slow link would, with no network shaping to install.
  if (FAKE_LAG_MS > 0) setTimeout(finish, FAKE_LAG_MS)
  else finish()
}

export function resizeLogin(id: string, w: number, h: number, boxW?: number, boxH?: number): void {
  const l = live.get(id)
  if (!l || !(w > 0) || !(h > 0)) return
  const box = { w: boxW && boxW > 0 ? boxW : w, h: boxH && boxH > 0 ? boxH : h }
  const same = Math.abs(l.size.w - w) < 8 && Math.abs(l.size.h - h) < 8
  const sameBox = Math.abs(l.box.w - box.w) < 8 && Math.abs(l.box.h - box.h) < 8
  l.box = box
  if (same && sameBox) return
  // Recorded whatever the state is. The view mounts and reports its size while `openLogin`
  // is still opening the tunnel, and a size DROPPED there is never asked for again - a
  // ResizeObserver only speaks when the box changes - so the page stayed at the default
  // 1280x800 and the picture was squashed into a 479px column for the whole session.
  l.size = { w, h }
  if (!l.ws || l.req.state === 'opening' || l.req.state === 'waiting' || l.req.state === 'failed') return
  void applySize(l)
    .then(() => send(l, 'Page.stopScreencast'))
    .then(() => startCast(l))
    .catch(() => {
      /* a resize that loses a race is fixed by the next one */
    })
}


/** A picture bigger than this is not a screenshot, and a CDP call is not a file upload. */
const MAX_PASTE_BYTES = 12 * 1024 * 1024

/**
 * What is on THIS machine's clipboard, put into the far page.
 *
 * Text was all that ever travelled, so a copied screenshot arrived as
 * `file:///Users/.../shot.png` - a name that means nothing on the other computer, typed
 * into a comment box (Robert, 2026-09-04). A picture now travels as bytes and is
 * delivered as the page's own `paste` event; only when there is no picture is the text
 * sent, which is the old behaviour unchanged.
 */
function pasteClipboard(l: Live): void {
  let found: { base64: string; mime: string; name: string } | null = null
  const text = clipboard.readText()
  const path = text ? imagePathFromText(text) : null
  if (path) {
    // A file copied in Finder is a PATH on the clipboard and nothing else, so the bytes
    // are read here rather than asked of `readImage`, which returns nothing for it.
    try {
      if (statSync(path).size <= MAX_PASTE_BYTES) {
        found = {
          base64: readFileSync(path).toString('base64'),
          mime: mimeForImage(path) ?? 'image/png',
          name: path.split(/[\\/]/).pop() || 'pasted.png'
        }
      }
    } catch {
      /* an unreadable path is not a picture; the text below is still true */
    }
  }
  if (!found) {
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      const png = img.toPNG()
      if (png.length <= MAX_PASTE_BYTES) {
        found = { base64: png.toString('base64'), mime: 'image/png', name: 'pasted.png' }
      }
    }
  }
  if (!found) {
    if (text) tell(l, 'Input.insertText', { text })
    return
  }
  const bytes = found.base64.length
  log(`paste picture ${found.mime} ${bytes}b64 id=${l.req.id}`)
  void send(l, 'Runtime.evaluate', {
    expression: pasteImageScript(found.base64, found.mime, found.name),
    awaitPromise: false,
    userGesture: true,
    returnByValue: true
  }).catch(() => {
    // A page that will not take the event is not an error worth a card; the text is the
    // honest fallback, and it is what used to happen every time.
    if (text) tell(l, 'Input.insertText', { text })
  })
}

export function loginInput(id: string, ev: LoginInput): void {
  const l = live.get(id)
  if (!l || !l.ws || l.req.state === 'failed') return
  if (ev.kind === 'text') {
    tell(l, 'Input.insertText', { text: ev.text })
    return
  }
  if (ev.kind === 'paste') {
    pasteClipboard(l)
    return
  }
  if (ev.kind === 'key') {
    // Windows Chrome has no Meta accelerator, so a Mac's Cmd has to arrive as a Ctrl or
    // every shortcut typed at the PC's browser does nothing at all.
    const toWindows = Boolean(l.req.host)
    tell(l, 'Input.dispatchKeyEvent', {
      ...keyEvent(ev.k, ev.type, { mapMetaToCtrl: toWindows })
    } as unknown as Record<string, unknown>)
    return
  }
  const meta = l.lastMeta
  if (!meta) return
  const p = toRemotePoint({ x: ev.x, y: ev.y }, { width: ev.w, height: ev.h }, meta)
  const params: Record<string, unknown> = {
    type: ev.type,
    x: p.x,
    y: p.y,
    button: ev.button ?? 'none',
    buttons: ev.buttons ?? 0,
    clickCount: ev.clickCount ?? 0,
    modifiers: ev.modifiers ?? 0
  }
  if (ev.type === 'mouseWheel') {
    params.deltaX = ev.deltaX ?? 0
    params.deltaY = ev.deltaY ?? 0
  }
  tell(l, 'Input.dispatchMouseEvent', params)
}

/**
 * Does it look signed in yet? A hint in the header and nothing more - the person presses
 * Done, because a redirect is not a promise that the password was accepted.
 */
function watchUrl(l: Live): void {
  const start = l.req.url
  clearInterval(l.hint)
  l.hint = setInterval(() => {
    if (l.req.state !== 'open') return
    void send(l, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      .then((r) => {
        const now = String((r.result as { value?: string } | undefined)?.value ?? '')
        if (now && looksSignedIn(start, now)) {
          l.req.state = 'signed in'
          log(`looks signed in ${l.req.id}: ${now}`)
          publish()
        }
      })
      .catch(() => {
        /* the page is mid-navigation; ask again in two seconds */
      })
  }, 2000)
}

function stop(l: Live): void {
  clearInterval(l.hint)
  l.hint = undefined
  try {
    l.ws?.close()
  } catch {
    /* already gone */
  }
  l.ws = undefined
  // Chrome and the tab stay up on the far machine: the signed-in session IS the deliverable.
  try {
    l.ssh?.kill()
  } catch {
    /* already gone */
  }
  l.ssh = undefined
  l.waiting.clear()
  l.pacer.reset()
}

/** Done, or Close: the view goes away, the sign-in stays where it was typed. */
export function closeLogin(id: string): void {
  const l = live.get(id)
  if (!l) return
  l.closed = true
  if (l.ws) void send(l, 'Page.stopScreencast').catch(() => ({}))
  stop(l)
  log(`closed ${l.req.id} state=${l.req.state}`)
  live.delete(id)
  publish()
}

/** Not now: the card goes, the job that asked is not told anything new. */
export function dismissLogin(id: string): void {
  closeLogin(id)
}

export function loginTitle(id: string): string {
  const l = live.get(id)
  return l ? loginPaneTitle(l.req) : 'Sign in'
}

/** Quitting must not leave an ssh child behind. */
export function shutdownLogins(): void {
  for (const id of [...live.keys()]) closeLogin(id)
}
