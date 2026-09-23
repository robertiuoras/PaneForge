// The other machine's screen in a pane: the state machine, the zoom arithmetic, reading
// `query session` for a detached console, the quality line and the candidate rewrite.
// Everything here is pure (src/shared/screenStream.ts); the wire half is in
// scripts/remote-test.mjs and the window half in a `npm run try -- --headless` copy.
//
//   node scripts/screen-stream-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-screen-stream-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'screenStream.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/screenStream.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const S = createRequire(import.meta.url)(outfile)

let checks = 0
const check = (fn) => {
  fn()
  checks++
}

// ---------------------------------------------------------------------------
// The view's life: idle -> offering -> connected -> reconnecting -> failed.

check(() => {
  const t0 = 1_000_000
  let s = S.screenStart(t0)
  assert.equal(s.phase, 'idle')
  s = S.stepScreen(s, { t: 'start' }, t0)
  assert.equal(s.phase, 'offering')
  assert.equal(S.screenMessage(s, 'Gamer'), 'Connecting to Gamer…')
  // A tick before the deadline changes nothing, and returns the SAME object (no render).
  const same = S.stepScreen(s, { t: 'tick' }, t0 + 5000)
  assert.equal(same, s)
  s = S.stepScreen(s, { t: 'picture' }, t0 + 1200)
  assert.equal(s.phase, 'connected')
  assert.equal(S.screenMessage(s, 'Gamer'), null, 'a picture needs no card')
  assert.equal(S.stepScreen(s, { t: 'picture' }, t0 + 1300), s, 'a second frame is not a change')
})

check(() => {
  // No picture in 10 s: retry once quietly, then say it.
  const t0 = 0
  let s = S.stepScreen(S.screenStart(t0), { t: 'start' }, t0)
  s = S.stepScreen(s, { t: 'tick' }, t0 + S.CONNECT_TIMEOUT_MS)
  assert.equal(s.phase, 'offering')
  assert.equal(s.retries, 1)
  assert.equal(s.since, t0 + S.CONNECT_TIMEOUT_MS, 'since moves: that is the caller\'s cue to ask again')
  s = S.stepScreen(s, { t: 'tick' }, t0 + 2 * S.CONNECT_TIMEOUT_MS)
  assert.equal(s.phase, 'failed')
  assert.equal(s.failure, 'connect')
  assert.equal(S.screenMessage(s, 'Gamer'), 'Could not connect to Gamer')
  assert.equal(S.offersRetry(s), true)
  assert.equal(S.offersWake(s), false)
  s = S.stepScreen(s, { t: 'retry' }, t0 + 30_000)
  assert.equal(s.phase, 'offering')
  assert.equal(s.retries, 0, 'a pressed retry gets its own quiet retry')
})

check(() => {
  // Link drops: the last frame stays with `Reconnecting…` for 20 s, then the failure card.
  let s = S.stepScreen(S.stepScreen(S.screenStart(0), { t: 'start' }, 0), { t: 'picture' }, 100)
  s = S.stepScreen(s, { t: 'drop' }, 5000)
  assert.equal(s.phase, 'reconnecting')
  assert.equal(S.screenMessage(s, 'Gamer'), 'Reconnecting…')
  assert.equal(S.stepScreen(s, { t: 'tick' }, 5000 + S.RECONNECT_MS - 1).phase, 'reconnecting')
  const back = S.stepScreen(s, { t: 'picture' }, 9000)
  assert.equal(back.phase, 'connected', 'the link came back inside the window')
  s = S.stepScreen(s, { t: 'tick' }, 5000 + S.RECONNECT_MS)
  assert.equal(s.phase, 'failed')
  assert.equal(s.failure, 'lost')
})

check(() => {
  // Locked or detached console: the card offers Wake the desktop.
  let s = S.stepScreen(S.stepScreen(S.screenStart(0), { t: 'start' }, 0), { t: 'locked' }, 800)
  assert.equal(s.failure, 'locked')
  assert.equal(S.screenMessage(s, 'Gamer'), "Gamer's screen is locked")
  assert.equal(S.offersWake(s), true)
  // Older build on the other machine: no retry (it cannot help), Moonlight still offered by the pane.
  s = S.stepScreen(S.stepScreen(S.screenStart(0), { t: 'start' }, 0), { t: 'refuse', why: 'old' }, 10)
  assert.equal(S.screenMessage(s, 'Gamer'), 'Update PaneForge on Gamer first')
  assert.equal(S.offersRetry(s), false)
  // Closed by the source: the pane says who, and nothing moves it again.
  s = S.stepScreen(S.stepScreen(S.screenStart(0), { t: 'start' }, 0), { t: 'stop', by: 'source' }, 10)
  assert.equal(S.screenMessage(s, 'Gamer'), 'Closed by Gamer')
  assert.equal(S.stepScreen(s, { t: 'picture' }, 20), s)
  // A drop while still offering is a failed attempt, not a wait.
  s = S.stepScreen(S.stepScreen(S.screenStart(0), { t: 'start' }, 0), { t: 'drop' }, 500)
  assert.equal(s.phase, 'offering')
  assert.equal(s.retries, 1)
})

check(() => {
  // Words: the machine is named, the transport never is.
  const all = [
    S.screenPaneTitle('Gamer'),
    S.watchedTitle('Gamer', "Robert's MacBook"),
    ...['offline', 'old', 'connect', 'locked', 'lost'].map((f) =>
      S.screenMessage({ phase: 'failed', failure: f, retries: 0, since: 0 }, 'Gamer')
    )
  ]
  assert.equal(all[0], "Gamer's screen")
  assert.equal(all[1], "Gamer's screen, being watched from Robert's MacBook")
  for (const w of all) assert.doesNotMatch(w, /webrtc|stream|ice\b|codec|sdp|peer/i, w)
})

// ---------------------------------------------------------------------------
// Zoom.

check(() => {
  assert.equal(S.zoomStep(1, 1), 1.25)
  assert.equal(S.zoomStep(1, -1), 0.9)
  assert.equal(S.zoomStep(4, 1), 4, 'clamped at the top')
  assert.equal(S.zoomStep(0.25, -1), 0.25, 'clamped at the bottom')
  // From an in-between zoom (a pinch, or Fit) the next step is the nearest one that way.
  assert.equal(S.zoomStep(0.8, 1), 0.9)
  assert.equal(S.zoomStep(0.8, -1), 0.75)
  assert.equal(S.clampZoom(9), S.ZOOM_MAX)
  assert.equal(S.clampZoom(0.01), S.ZOOM_MIN)
  assert.equal(S.clampZoom(NaN), 1)
  assert.equal(S.zoomLabel(0.6666), '67%')
})

check(() => {
  // Fit = contain. A 2560x1440 desktop in a 640x480 pane: width-bound, 0.25.
  assert.equal(S.fitZoom(640, 480, 2560, 1440), 0.25)
  assert.equal(S.fitZoom(1280, 360, 2560, 1440), 0.25, 'height-bound')
  assert.equal(S.fitZoom(0, 480, 2560, 1440), 1, 'unmeasured = 1, never 0 or NaN')
  // A tiny pane still gets the minimum rather than a picture it cannot show.
  assert.equal(S.fitZoom(100, 60, 2560, 1440), S.ZOOM_MIN)
})

check(() => {
  // Pinch: a wheel with ctrlKey. Fingers apart = negative deltaY = bigger.
  assert.ok(S.wheelZoom(1, -100) > 1)
  assert.ok(S.wheelZoom(1, 100) < 1)
  assert.ok(Math.abs(S.wheelZoom(S.wheelZoom(1, -40), 40) - 1) < 1e-9, 'out and back is exactly back')
  assert.equal(S.wheelZoom(4, -1000), 4)
  assert.ok(S.wheelZoom(1, -3, 1) > 1, 'line-mode wheels count in lines')
})

check(() => {
  // The point under the fingers stays put. Box point (200,100), scrolled (0,0), 1 -> 2:
  // picture point (200,100) moves to (400,200), so scroll by (200,100).
  assert.deepEqual(S.anchorScroll({ left: 0, top: 0 }, { x: 200, y: 100 }, 1, 2), { left: 200, top: 100 })
  // And back down lands where it started.
  assert.deepEqual(S.anchorScroll({ left: 200, top: 100 }, { x: 200, y: 100 }, 2, 1), { left: 0, top: 0 })
  // Never a negative scroll.
  assert.deepEqual(S.anchorScroll({ left: 0, top: 0 }, { x: 10, y: 10 }, 2, 1), { left: 0, top: 0 })
})

// ---------------------------------------------------------------------------
// Detached console, off `query session`.

// Captured on the PC over ssh, 2026-09-23 (console attached, Robert at the desk).
const ACTIVE = [
  ' SESSIONNAME               USERNAME                 ID  STATE   TYPE        DEVICE ',
  '>services                                            0  Disc                        ',
  ' console                   Gamer                     1  Active                      ',
  ' rdp-tcp                                         65536  Listen                      ',
  ''
].join('\r\n')

// The same machine after an RDP session ends: the person's session keeps its id with an
// EMPTY session name and state Disc, and the physical console becomes a new, userless
// session (the shape the design's 2026-09-23 measurement recorded: `gamer`, id 1, Disc).
const DETACHED = [
  ' SESSIONNAME               USERNAME                 ID  STATE   TYPE        DEVICE ',
  '>services                                            0  Disc                        ',
  '                           Gamer                     1  Disc                        ',
  ' console                                             2  Conn                        ',
  ' rdp-tcp                                         65536  Listen                      ',
  ''
].join('\r\n')

check(() => {
  const rows = S.parseQuerySession(ACTIVE)
  assert.deepEqual(
    rows.map((r) => [r.name, r.user, r.id, r.state]),
    [
      ['services', '', 0, 'Disc'],
      ['console', 'Gamer', 1, 'Active'],
      ['rdp-tcp', '', 65536, 'Listen']
    ]
  )
  assert.deepEqual(S.consoleReading(ACTIVE, 'Gamer'), { detached: false, id: 1 })
  assert.deepEqual(S.consoleReading(ACTIVE, 'gamer'), { detached: false, id: 1 }, 'case-insensitive: query user prints gamer')
})

check(() => {
  const rows = S.parseQuerySession(DETACHED)
  assert.deepEqual(rows[1], { name: '', user: 'Gamer', id: 1, state: 'Disc' }, 'empty session name read, not shifted')
  assert.deepEqual(S.consoleReading(DETACHED, 'Gamer'), { detached: true, id: 1 })
  assert.equal(S.wakeCommand(1), 'tscon 1 /dest:console')
  // Session 0 is always Disc and is nobody's desktop; no user = nothing to wake.
  assert.deepEqual(S.consoleReading(DETACHED, 'Nobody'), { detached: false, id: null })
  assert.deepEqual(S.consoleReading('', 'Gamer'), { detached: false, id: null })
  assert.deepEqual(S.parseQuerySession('not the output you were looking for'), [])
  // Only a real session id reaches a command line.
  for (const bad of [null, 0, -1, 1.5, 65536]) assert.equal(S.wakeCommand(bad), null, String(bad))
})

// ---------------------------------------------------------------------------
// Quality line.

check(() => {
  const report = [
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 5_000_000, framesDecoded: 900, frameWidth: 2560, frameHeight: 1440 },
    { type: 'inbound-rtp', kind: 'audio', bytesReceived: 999, framesDecoded: 0 },
    { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.062 },
    { type: 'candidate-pair', nominated: false, state: 'failed', currentRoundTripTime: 9 }
  ]
  const a = S.sampleOf(report, 10_000)
  assert.deepEqual(a, { at: 10_000, bytes: 5_000_000, frames: 900, rttSec: 0.062, width: 2560, height: 1440 })
  const b = { ...a, at: 11_000, bytes: 5_500_000, frames: 930 }
  const q = S.qualityOf(a, b)
  assert.deepEqual(q, { fps: 30, kbps: 4000, rttMs: 62, width: 2560, height: 1440 })
  assert.equal(S.qualityLine(q), '30 fps · 4000 kbps · 62 ms')
  assert.equal(S.qualityOf(null, b), null, 'one sample is no rate')
  assert.equal(S.qualityOf(b, b), null, 'no time passed is no rate')
  assert.equal(S.qualityLine(null), '')
  assert.equal(S.qualityLine({ fps: 12, kbps: 800, rttMs: null }), '12 fps · 800 kbps')
})

// ---------------------------------------------------------------------------
// Candidates: mDNS names do not cross a tailnet, so each end points the other's host
// candidates at the address it already reaches that machine on.

check(() => {
  const mdns = 'candidate:1 1 udp 2122260223 3f1c2a4e-9b1d-4c1e-8f5b-7a2d9c1e0b11.local 55123 typ host generation 0 ufrag abcd network-id 1'
  assert.equal(
    S.rewriteCandidate(mdns, '100.78.1.77'),
    'candidate:1 1 udp 2122260223 100.78.1.77 55123 typ host generation 0 ufrag abcd network-id 1'
  )
  // Already the tailnet address: kept as is.
  const real = 'candidate:2 1 udp 2122260223 100.78.1.77 50000 typ host'
  assert.equal(S.rewriteCandidate(real, '100.78.1.77'), real)
  // A LAN address in the other building: dropped, it cannot be reached.
  assert.equal(S.rewriteCandidate('candidate:3 1 udp 2122260223 192.168.1.20 50001 typ host', '100.78.1.77'), null)
  // TCP and non-host candidates: dropped (no STUN/TURN is configured, TCP adds nothing).
  assert.equal(S.rewriteCandidate('candidate:4 1 tcp 1518280447 x.local 9 typ host tcptype active', '100.78.1.77'), null)
  assert.equal(S.rewriteCandidate('candidate:5 1 udp 1686052607 1.2.3.4 50002 typ srflx raddr 0.0.0.0 rport 0', '100.78.1.77'), null)
  // Garbage and a hostile address never produce a candidate.
  assert.equal(S.rewriteCandidate('', '100.78.1.77'), null)
  assert.equal(S.rewriteCandidate('not a candidate', '100.78.1.77'), null)
  assert.equal(S.rewriteCandidate(mdns, 'evil.example; rm'), null)
})

rmSync(work, { recursive: true, force: true })
console.log(`screen-stream: ok (${checks} checks)`)
