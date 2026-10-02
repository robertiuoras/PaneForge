/**
 * The other machine's screen, drawn in a pane: every decision that does not need a window.
 *
 * The picture itself is WebRTC between the two PaneForge installs (the sink's pane and a
 * hidden capture window on the source), signalled over the encrypted peer channel that
 * already exists - see docs/superpowers/specs/2026-09-23-pc-screen-design.md, "v1". This
 * file is the part both ends and the tests share: what state a view is in and what it
 * says, the zoom arithmetic, reading `query session` for a detached console, the quality
 * line, and the one rewrite that makes a direct connection possible across a tailnet.
 *
 * Pure: scripts/screen-stream-test.mjs asserts every branch without Electron.
 */

/** Chromium's desktop capture is capped near 30 fps (electron/electron#24808). */
export const SCREEN_FPS = 30
/** No picture this long after asking = the connection is not going to happen. */
export const CONNECT_TIMEOUT_MS = 10_000
/** A dropped link keeps the last frame this long before it is called a failure. */
export const RECONNECT_MS = 20_000
/** One quiet retry after a failed connect; the second failure is said out loud. */
export const MAX_RETRIES = 1
/** How often the footer re-reads the connection's numbers. */
export const STATS_EVERY_MS = 1000

// ---------------------------------------------------------------------------
// The view's life

export type ScreenPhase = 'idle' | 'offering' | 'connected' | 'reconnecting' | 'failed' | 'ended'

/** Why a view is not showing a picture, in the words the card uses. */
export type ScreenFailure =
  | 'offline' // the machine is not connected to this one
  | 'old' // PaneForge there predates the in-app view
  | 'connect' // no picture within CONNECT_TIMEOUT_MS, retried once
  | 'locked' // capture refused or black: locked screen or detached console
  | 'lost' // link dropped and did not come back within RECONNECT_MS
  | 'refused' // the source said no for a reason of its own (message carried)

export interface ScreenState {
  phase: ScreenPhase
  failure: ScreenFailure | null
  /** Retries spent on the current attempt. */
  retries: number
  /** When the current phase started, for its deadline. */
  since: number
  /** The source's own sentence for a `refused`, shown verbatim. */
  detail?: string
  /** Who ended it, for History: `closed by <machine>`. */
  endedBy?: 'me' | 'source'
}

export type ScreenEvent =
  | { t: 'start' }
  | { t: 'refuse'; why: 'offline' | 'old' | 'refused'; detail?: string }
  | { t: 'picture' } // the first frame arrived (or arrived again after a drop)
  | { t: 'locked' } // the source reported capture failed / the console is detached
  | { t: 'drop' } // the connection went away while showing a picture
  | { t: 'tick' } // a clock tick: deadlines are judged here and nowhere else
  | { t: 'retry' } // the person pressed Try again
  | { t: 'stop'; by: 'me' | 'source' }

export function screenStart(now: number): ScreenState {
  return { phase: 'idle', failure: null, retries: 0, since: now }
}

/**
 * One step of the view's life. Returns the SAME object when nothing changed, so a React
 * caller can hand it straight to setState without a render.
 *
 * `retry` in the result of a `tick` is how the caller learns it must ask again: the phase
 * goes back to `offering` with `retries` one higher, and a caller that sees `since` move
 * while still offering sends a fresh request.
 */
export function stepScreen(s: ScreenState, e: ScreenEvent, now: number): ScreenState {
  if (s.phase === 'ended') return s
  switch (e.t) {
    case 'start':
      return { phase: 'offering', failure: null, retries: 0, since: now }
    case 'refuse':
      return { ...s, phase: 'failed', failure: e.why, since: now, detail: e.detail }
    case 'picture':
      if (s.phase === 'connected') return s
      return { phase: 'connected', failure: null, retries: 0, since: now }
    case 'locked':
      return { ...s, phase: 'failed', failure: 'locked', since: now, detail: undefined }
    case 'drop':
      if (s.phase === 'connected') return { ...s, phase: 'reconnecting', since: now }
      if (s.phase === 'offering') return tick({ ...s, since: now - CONNECT_TIMEOUT_MS }, now)
      return s
    case 'tick':
      return tick(s, now)
    case 'retry':
      if (s.phase !== 'failed') return s
      return { phase: 'offering', failure: null, retries: 0, since: now }
    case 'stop':
      return { ...s, phase: 'ended', since: now, endedBy: e.by }
  }
}

function tick(s: ScreenState, now: number): ScreenState {
  if (s.phase === 'offering' && now - s.since >= CONNECT_TIMEOUT_MS) {
    if (s.retries < MAX_RETRIES) return { ...s, retries: s.retries + 1, since: now }
    return { ...s, phase: 'failed', failure: 'connect', since: now }
  }
  if (s.phase === 'reconnecting' && now - s.since >= RECONNECT_MS) {
    return { ...s, phase: 'failed', failure: 'lost', since: now }
  }
  return s
}

// ---------------------------------------------------------------------------
// Words. The machine is named; the transport never is.

export function screenPaneTitle(machine: string): string {
  return `${machine}'s screen`
}

/** What the source machine's own sessions list says while somebody is looking. */
export function watchedTitle(machine: string, watcher: string): string {
  return `${machine}'s screen, being watched from ${watcher}`
}

/** The card's headline for a view with no picture. `null` = nothing to say. */
export function screenMessage(s: ScreenState, machine: string): string | null {
  if (s.phase === 'offering') return `Connecting to ${machine}…`
  if (s.phase === 'reconnecting') return 'Reconnecting…'
  if (s.phase === 'ended') return s.endedBy === 'source' ? `Closed by ${machine}` : null
  if (s.phase !== 'failed') return null
  switch (s.failure) {
    case 'offline':
      return `${machine} is not connected right now`
    case 'old':
      return `Update PaneForge on ${machine} first`
    case 'connect':
      return `Could not connect to ${machine}`
    case 'locked':
      return `${machine}'s screen is locked`
    case 'lost':
      return `The connection to ${machine} was lost`
    case 'refused':
      return s.detail || `${machine} said no`
    default:
      return null
  }
}

/** Whether the card offers `Wake the desktop` (only for a locked or detached screen). */
export function offersWake(s: ScreenState): boolean {
  return s.phase === 'failed' && s.failure === 'locked'
}

/** Whether the card offers `Try again`. A machine that is off gets the button too. */
export function offersRetry(s: ScreenState): boolean {
  return s.phase === 'failed' && s.failure !== 'old'
}

// ---------------------------------------------------------------------------
// Zoom. The picture is drawn at `natural size x zoom` inside a scrolling box, so a
// zoomed picture scrolls like any page and the point under the fingers stays put.

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4
/** Where the `+` and `-` buttons (and Cmd/Ctrl +/-) land. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4]

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/**
 * The next step up or down from `z`. From an in-between zoom (after a pinch or Fit) it
 * goes to the nearest step in that direction, never back past where the person is.
 */
export function zoomStep(z: number, dir: 1 | -1): number {
  const eps = 1e-6
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + eps) ?? ZOOM_MAX
  return [...ZOOM_STEPS].reverse().find((s) => s < z - eps) ?? ZOOM_MIN
}

/** Fit = the whole picture inside the box, letterboxed. Unmeasured = 1. */
export function fitZoom(boxW: number, boxH: number, picW: number, picH: number): number {
  if (!(boxW > 0 && boxH > 0 && picW > 0 && picH > 0)) return 1
  return clampZoom(Math.min(boxW / picW, boxH / picH))
}

/**
 * A pinch (Chromium reports it as a `wheel` with `ctrlKey`) or a Cmd/Ctrl+wheel. Exponential
 * so the same finger travel feels the same at 30% and at 300%; a mouse wheel notch is
 * ~100 px of deltaY, which is one ~1.28x step.
 */
export function wheelZoom(z: number, deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return clampZoom(z * Math.exp(-px * 0.0025))
}

/**
 * Where to scroll so the picture point under `(ax, ay)` - box coordinates, e.g. the pinch
 * centre - is still under it after going from `from` to `to`.
 */
export function anchorScroll(
  scroll: { left: number; top: number },
  anchor: { x: number; y: number },
  from: number,
  to: number
): { left: number; top: number } {
  const k = to / from
  return {
    left: Math.max(0, (scroll.left + anchor.x) * k - anchor.x),
    top: Math.max(0, (scroll.top + anchor.y) * k - anchor.y)
  }
}

/** `100%`, `67%`: what the zoom button reads. */
export function zoomLabel(z: number): string {
  return `${Math.round(clampZoom(z) * 100)}%`
}

// ---------------------------------------------------------------------------
// Detached console. After an RDP session ends, Windows leaves the person's session
// disconnected and the physical screen on the lock screen; desktop capture fails until
// `tscon <id> /dest:console` moves it back (LanternOps/breeze#2160, LizardByte/Sunshine#964).

export interface WinSession {
  name: string
  user: string
  id: number
  state: string
}

/**
 * `query session` output to rows. Columns are fixed-width but the widths depend on the
 * language and the longest name, so this reads by the header's column starts rather than
 * splitting on spaces (a detached row has an EMPTY session name).
 */
export function parseQuerySession(text: string): WinSession[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const head = lines.findIndex((l) => /SESSIONNAME/i.test(l) && /\bID\b/.test(l))
  if (head < 0) return []
  const h = lines[head]
  const col = (re: RegExp): number => {
    const m = re.exec(h)
    return m ? m.index : -1
  }
  const cUser = col(/USERNAME/i)
  const cId = col(/\bID\b/)
  const cState = col(/STATE/i)
  if (cUser < 0 || cId < 0 || cState < 0) return []
  const out: WinSession[] = []
  for (const raw of lines.slice(head + 1)) {
    // The current session is marked with `>` in the first column.
    const l = raw.replace(/^>/, ' ')
    // ID is right-aligned under its header, so read the number that ENDS near it.
    const idMatch = /(\d+)\s+(\S+)/.exec(l.slice(cUser))
    if (!idMatch) continue
    const idAt = cUser + (idMatch.index ?? 0)
    out.push({
      name: l.slice(0, cUser).trim(),
      user: l.slice(cUser, Math.min(idAt, cId + 1)).replace(/\d+\s*$/, '').trim(),
      id: Number(idMatch[1]),
      state: idMatch[2]
    })
  }
  return out
}

export interface ConsoleReading {
  /** The person's session is disconnected from the physical screen. */
  detached: boolean
  /** Their session id, for `tscon <id> /dest:console`. */
  id: number | null
}

/**
 * Is `user`'s desktop off the screen? Session 0 (`services`) is always `Disc` and is never
 * anybody's desktop. Case-insensitive: `query session` prints `Gamer`, `query user` `gamer`.
 */
export function consoleReading(text: string, user: string): ConsoleReading {
  const want = user.trim().toLowerCase()
  const mine = parseQuerySession(text).filter((r) => r.id !== 0 && r.user.toLowerCase() === want)
  const active = mine.find((r) => /^active$/i.test(r.state))
  if (active) return { detached: false, id: active.id }
  const disc = mine.find((r) => /^disc/i.test(r.state))
  if (disc) return { detached: true, id: disc.id }
  return { detached: false, id: null }
}

/** The command `Wake the desktop` runs on the source, over ssh. Refuses a bad id. */
export function wakeCommand(id: number | null): string | null {
  if (id === null || !Number.isInteger(id) || id <= 0 || id >= 65536) return null
  return `tscon ${id} /dest:console`
}

// ---------------------------------------------------------------------------
// The quality line: frames, bits and round trip from two getStats() samples.

export interface StatsSample {
  at: number // ms
  bytes: number // inbound-rtp bytesReceived
  frames: number // inbound-rtp framesDecoded
  rttSec: number | null // candidate-pair currentRoundTripTime
  width?: number
  height?: number
}

export interface Quality {
  fps: number
  kbps: number
  rttMs: number | null
  width?: number
  height?: number
}

export function qualityOf(prev: StatsSample | null, now: StatsSample): Quality | null {
  if (!prev) return null
  const dt = (now.at - prev.at) / 1000
  if (!(dt > 0)) return null
  return {
    fps: Math.max(0, Math.round((now.frames - prev.frames) / dt)),
    kbps: Math.max(0, Math.round(((now.bytes - prev.bytes) * 8) / 1000 / dt)),
    rttMs: now.rttSec === null ? null : Math.round(now.rttSec * 1000),
    width: now.width,
    height: now.height
  }
}

export function qualityLine(q: Quality | null): string {
  if (!q) return ''
  const parts = [`${q.fps} fps`, `${q.kbps} kbps`]
  if (q.rttMs !== null) parts.push(`${q.rttMs} ms`)
  return parts.join(' · ')
}

/**
 * The fields the quality line needs, out of a `getStats()` report flattened to its
 * values. Pure so the test can hand it a captured report.
 */
export function sampleOf(report: Array<Record<string, unknown>>, at: number): StatsSample {
  let bytes = 0
  let frames = 0
  let width: number | undefined
  let height: number | undefined
  let rttSec: number | null = null
  for (const r of report) {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      bytes += Number(r.bytesReceived ?? 0)
      frames += Number(r.framesDecoded ?? 0)
      if (typeof r.frameWidth === 'number') width = r.frameWidth
      if (typeof r.frameHeight === 'number') height = r.frameHeight
    }
    if (r.type === 'candidate-pair' && (r.nominated === true || r.selected === true) && r.state === 'succeeded') {
      if (typeof r.currentRoundTripTime === 'number') rttSec = r.currentRoundTripTime
    }
  }
  return { at, bytes, frames, rttSec, width, height }
}

// ---------------------------------------------------------------------------
// Candidates. Chromium hides a host candidate's address behind a `<uuid>.local` mDNS
// name, and mDNS does not cross a tailnet. Each end therefore rewrites the OTHER end's
// candidates to the address it already reaches that machine on over the peer channel.
// Every interface's candidate gets the same address and only the one bound to the
// tailnet interface answers - the rest fail their checks, which costs nothing.

/**
 * `candidate:<f> <c> <proto> <prio> <addr> <port> typ <type> ...` with an mDNS or any
 * address -> the same with `address`. Only UDP host candidates survive: no STUN/TURN is
 * configured, and TCP candidates are a second path that adds nothing on a tailnet.
 * Returns null for a candidate to drop.
 */
export function rewriteCandidate(candidate: string, address: string): string | null {
  const c = candidate.trim()
  if (!c) return null
  const parts = c.split(/\s+/)
  // candidate:foundation component protocol priority address port "typ" type
  if (parts.length < 8 || !/^(a=)?candidate:/.test(parts[0]) || parts[6] !== 'typ') return null
  if (parts[2].toLowerCase() !== 'udp' || parts[7] !== 'host') return null
  if (!/^[\d.]+$/.test(address) && !/^[0-9a-f:]+$/i.test(address)) return null
  const addr = parts[4]
  // A real address already equal to the target, or an mDNS name: point it at the tailnet.
  // A real address that is something else (a LAN IP in the other building) is dropped.
  if (addr !== address && !addr.endsWith('.local')) return null
  parts[4] = address
  return parts.join(' ')
}
