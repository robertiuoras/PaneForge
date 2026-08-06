// Does dragging the Stash pull PaneForge to the front on macOS - and if so, what does it?
//
//   node scripts/stash-activate-probe.mjs            build, launch, measure, close
//   node scripts/stash-activate-probe.mjs --keep     skip the build
//
// MEASUREMENT ONLY. It changes nothing and fixes nothing; it prints a millisecond timeline
// merging three clocks that already agree (all ms epoch):
//
//   front   - which application is frontmost, sampled every 50ms by a Swift/AppKit process
//   mouse   - each posted pointer event
//   probe   - the app's own activation-probe.log (temporary instrumentation in src/main)
//
// Two input paths, and which one is used matters for what the run can prove:
//
//  * HID (scripts/probe-mouse.swift, CGEventPost to .cghidEventTap) is a hand on the
//    trackpad as far as AppKit is concerned, so it reproduces application activation.
//    It needs an Accessibility grant for whatever is responsible for this process; without
//    one the post is a silent no-op, which is why the poster proves the cursor moved
//    before it presses anything.
//  * CDP (Input.dispatchMouseEvent) is injected into the renderer below AppKit. It never
//    activates the application - which makes it the CONTROL: everything the app itself
//    does in answer to a drag still happens (dragStart/dragMove/dragDrop, setBounds per
//    move, place(), setConfig), so if PaneForge comes to the front during a CDP drag the
//    cause is the app's own reaction, not the physical press.
//
// SAFETY. It never posts at a guessed coordinate. The target is read out of the running
// overlay over CDP (window.screenX/Y plus the grip's client rect) and must land inside
// that window's own rectangle, and outside the LIVE app's overlay, or the run aborts
// having posted nothing.

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { devProfile, profileConfig, profileData } from './dev-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()
const port = process.env.PF_PORT ?? '9333'
const keep = process.argv.includes('--keep')
const runs = Number(process.env.PF_RUNS ?? 3)

const work = join(tmpdir(), 'pf-activate-probe')
mkdirSync(work, { recursive: true })

// The copy this run actually launches, which is NOT always `dev`: every checkout gets its
// own profile, so from the lane `PaneForge-a` npm run try opens `dev-a`. Hardcoding `dev`
// here parked the Stash in a profile nothing was going to read, and the copy that did
// start had no saved position - so it cornered itself on top of the live app's Stash and
// every run aborted on the safety check before measuring a thing.
const profile = devProfile(root)
const devData = profileData(profile)
const devConfig = profileConfig(profile)
const liveConfig = profileConfig('')
const probeLogPath = join(devData, 'activation.log')

// The pill's size, from shelfWindow.ts COLLAPSED. Only used to keep away from the LIVE
// app's overlay - the target itself is measured, never assumed.
const PILL = { width: 190, height: 38 }
// Where the test copy's overlay is parked before the run: far from the live one, far from
// the screen edges, so three drags of (+250,-150) stay on the display.
const PARK = { x: 380, y: 760 }

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })

let closed = false
function closeCopy() {
  if (closed) return
  closed = true
  try {
    console.log('\n== closing the test copy')
    const r = sh('npm', ['run', 'try', '--', '--close'], { stdio: 'pipe' })
    console.log((r.stdout ?? '').trim() || (r.stderr ?? '').trim())
  } catch (e) {
    console.error('close failed:', e?.message)
  }
}
process.on('exit', closeCopy)
process.on('SIGINT', () => { closeCopy(); process.exit(130) })

// --- swift tools -------------------------------------------------------------
function swiftBuild(name) {
  const out = join(work, name)
  const src = join(root, 'scripts', `probe-${name === 'mouse' ? 'mouse' : 'frontmost'}.swift`)
  const r = sh('swiftc', ['-O', '-o', out, src], { stdio: 'pipe' })
  if (r.status !== 0) throw new Error(`swiftc ${src} failed:\n${r.stderr}`)
  return out
}
console.log('== compiling the Swift probes')
const mouseBin = swiftBuild('mouse')
const frontBin = swiftBuild('frontmost')

// Can this process post HID events at all? A move to where the cursor already is, so the
// answer costs nothing on screen.
function hidAvailable() {
  const r = spawnSync(mouseBin, ['noop', '400', '400'], { encoding: 'utf8' })
  return !(r.stdout ?? '').includes('POST_BLOCKED')
}

// --- park the overlay --------------------------------------------------------
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

const live = readJson(liveConfig)
const liveStash = live?.stashPos ?? null
const liveRect = liveStash
  ? { x: liveStash.x, y: liveStash.y - PILL.height, w: PILL.width, h: PILL.height }
  : null

{
  const cfg = readJson(devConfig) ?? {}
  cfg.clipboardShelf = true
  cfg.clipboardOverlay = true
  cfg.stashPos = { x: PARK.x, y: PARK.y }
  mkdirSync(devData, { recursive: true })
  writeFileSync(devConfig, JSON.stringify(cfg, null, 2))
  console.log(`== parked the ${profile} copy's Stash at ${JSON.stringify(cfg.stashPos)}`)
  if (liveRect) console.log(`   live app's Stash occupies ${JSON.stringify(liveRect)} - kept clear`)
}

// --- launch ------------------------------------------------------------------
if (!keep) {
  console.log('== building')
  const r = sh('npm', ['run', 'build'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
console.log('== launching the test copy')
{
  const r = sh('npm', ['run', 'try', '--', '--keep', '--show', `--remote-debugging-port=${port}`], {
    stdio: 'pipe'
  })
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    process.exit(1)
  }
}

// --- CDP ---------------------------------------------------------------------
async function findTarget(match) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && match(t.url ?? '')
      )
      if (page) {
        if (!(page.url ?? '').toLowerCase().startsWith(rootUrl))
          throw new Error(`port ${port} belongs to another checkout:\n  ${page.url}`)
        return page
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  })
  const send = (method, params) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  const ready = new Promise((res) => ws.addEventListener('open', res, { once: true }))
  return { ws, send, ready }
}

const shelfPage = await findTarget((u) => u.includes('shelf'))
if (!shelfPage) {
  console.error('ABORT: no shelf.html target on the debugging port - nothing was posted.')
  process.exit(1)
}
const mainPage = await findTarget((u) => !u.includes('shelf'))
const shelf = connect(shelfPage)
await shelf.ready
// Chromium defers mouseMoved to a frame that may never be composited for a window nobody
// is looking at, so a drag's moves arrive at random. A screencast forces frames; every
// frame must be acked or it stops after the first. jpeg at quality 1, 64x64: cheap.
try {
  await shelf.send('Page.enable')
  shelf.ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Page.screencastFrame')
      shelf.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {})
  })
  await shelf.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 64, maxHeight: 64 })
} catch {
  /* without it the drag moves are simply flakier; the run still measures */
}
const main = mainPage ? connect(mainPage) : null
if (main) await main.ready

async function evalIn(conn, expression) {
  const out = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (out.exceptionDetails)
    throw new Error(out.exceptionDetails.exception?.description ?? 'evaluate failed')
  return out.result?.value
}

const GRIP = `(() => {
  const g = document.querySelector('.pill-grip') || document.querySelector('.grip')
  if (!g) return null
  const r = g.getBoundingClientRect()
  return {
    page: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    win: { x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight },
    grip: { w: r.width, h: r.height }
  }
})()`

// --- the sampler -------------------------------------------------------------
function startSampler() {
  const p = spawn(frontBin, ['50'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const lines = []
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const l of parts) if (l.trim()) { try { lines.push(JSON.parse(l)) } catch {} }
  })
  return { p, lines, stop: () => p.kill() }
}

function frontmost() {
  try {
    return execFileSync('osascript', [
      '-e',
      'tell application "System Events" to name of first process whose frontmost is true'
    ], { encoding: 'utf8' }).trim()
  } catch { return '?' }
}

async function makeFinderFrontmost() {
  spawnSync('osascript', ['-e', 'tell application "Finder" to activate'])
  for (let i = 0; i < 20; i++) {
    if (frontmost() === 'Finder') return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// --- the app's own log -------------------------------------------------------
function logSize() { try { return statSync(probeLogPath).size } catch { return 0 } }
function logSince(from) {
  const size = logSize()
  if (size <= from) return []
  const fd = openSync(probeLogPath, 'r')
  const buf = Buffer.alloc(size - from)
  readSync(fd, buf, 0, buf.length, from)
  closeSync(fd)
  return buf
    .toString('utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return { src: 'probe', ...JSON.parse(l) } } catch { return null } })
    .filter(Boolean)
}

// --- the two gestures --------------------------------------------------------
const DX = 250
const DY = -150
const STEPS = 30
const DUR_MS = 1500

async function cdpMouse(type, x, y, awaitAck = true) {
  const params = {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse'
  }
  const p = shelf.send('Input.dispatchMouseEvent', params)
  if (awaitAck) await Promise.race([p, new Promise((r) => setTimeout(r, 400))])
  return { t: Date.now(), src: 'mouse', label: type, x, y }
}

async function gestureCDP(kind, g) {
  const events = []
  const px = g.page.x
  const py = g.page.y
  events.push(await cdpMouse('mousePressed', px, py))
  if (kind === 'click') {
    await new Promise((r) => setTimeout(r, 80))
    events.push(await cdpMouse('mouseReleased', px, py))
    return events
  }
  await new Promise((r) => setTimeout(r, 60))
  const per = DUR_MS / STEPS
  for (let i = 1; i <= STEPS; i++) {
    const f = i / STEPS
    const e = await cdpMouse('mouseMoved', px + DX * f, py + DY * f, false)
    if (i === 1 || i % 10 === 0 || i === STEPS) events.push(e)
    await new Promise((r) => setTimeout(r, per))
  }
  events.push(await cdpMouse('mouseReleased', px + DX, py + DY))
  return events
}

function gestureHID(kind, g) {
  const sx = g.win.x + g.page.x
  const sy = g.win.y + g.page.y
  const args =
    kind === 'click'
      ? ['click', String(sx), String(sy), '80']
      : ['drag', String(sx), String(sy), String(DX), String(DY), String(STEPS), String(DUR_MS)]
  const r = spawnSync(mouseBin, args, { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

// --- safety ------------------------------------------------------------------
function checkTarget(g) {
  if (!g) return 'the overlay has no .pill-grip - nothing to aim at'
  const sx = g.win.x + g.page.x
  const sy = g.win.y + g.page.y
  const inside =
    sx >= g.win.x && sx <= g.win.x + g.win.w && sy >= g.win.y && sy <= g.win.y + g.win.h
  if (!inside)
    return `computed point (${sx}, ${sy}) is outside the shelf window ` +
      `(${g.win.x}, ${g.win.y}, ${g.win.w}x${g.win.h})`
  if (liveRect) {
    const clash =
      sx >= liveRect.x && sx <= liveRect.x + liveRect.w &&
      sy >= liveRect.y && sy <= liveRect.y + liveRect.h
    if (clash) return `computed point (${sx}, ${sy}) is inside the LIVE app's Stash`
  }
  return null
}

// --- run ---------------------------------------------------------------------
const useHid = hidAvailable()
console.log(
  useHid
    ? '== input path: HID (CGEventPost) - real physical-path events'
    : '== input path: CDP - HID posting is BLOCKED (no Accessibility grant for the responsible app).\n' +
      '   A CDP run cannot reproduce the physical press\'s app activation, so it measures\n' +
      '   only what the APP does in answer to the drag. Read the verdict with that in mind.'
)

const t0Report = []

for (const kind of ['click', 'drag']) {
  for (let run = 1; run <= runs; run++) {
    const g = await evalIn(shelf, GRIP)
    const bad = checkTarget(g)
    if (bad) {
      console.error(`\nABORT (${kind} run ${run}): ${bad}\nNothing was posted.`)
      process.exit(1)
    }
    const finder = await makeFinderFrontmost()
    if (!finder) console.log(`   (warning: Finder did not become frontmost before ${kind} ${run})`)
    await new Promise((r) => setTimeout(r, 200))

    const from = logSize()
    const s = startSampler()
    await new Promise((r) => setTimeout(r, 300))

    const inputs = useHid ? gestureHID(kind, g) : await gestureCDP(kind, g)

    await new Promise((r) => setTimeout(r, 2000))
    s.stop()
    const probeLines = logSince(from)

    const down = inputs.find((e) => e.label === 'mouseDown' || e.label === 'mousePressed')
    const t0 = down?.t ?? inputs[0]?.t ?? Date.now()
    const merged = [...inputs, ...probeLines, ...s.lines].sort((a, b) => a.t - b.t)

    const front = s.lines.filter((l) => l.src === 'front')
    const cameForward = front.some(
      (l) => l.t >= t0 && /Electron|PaneForge/i.test(l.app ?? '') && l.changed
    )
    const focusCalls = probeLines.filter((l) => l.label === 'focusWindow')
    const activations = probeLines.filter((l) => l.label === 'app.activate' || l.label === 'app.did-become-active')
    const decisions = probeLines.filter((l) => l.label === 'onActivated.decision')

    console.log(`\n────────── ${kind.toUpperCase()} run ${run}  (t0 = mouse down, ${t0}) ──────────`)
    for (const m of merged) {
      const rel = m.t - t0
      const tag = `${rel >= 0 ? '+' : ''}${rel}`.padStart(7)
      if (m.src === 'front') console.log(`${tag}ms  front   ${m.app} (pid ${m.pid})${m.changed ? '  <= CHANGED' : ''}`)
      else if (m.src === 'mouse') console.log(`${tag}ms  mouse   ${m.label}${m.x !== undefined ? ` (${Math.round(m.x)}, ${Math.round(m.y)})` : ''}`)
      else {
        const rest = { ...m }
        delete rest.t; delete rest.src; delete rest.label
        console.log(`${tag}ms  probe   ${m.label}  ${JSON.stringify(rest)}`)
      }
    }
    console.log(
      `         SUMMARY  frontmost-changed-to-PaneForge=${cameForward}  ` +
        `activationEvents=${activations.length}  decisions=${decisions.map((d) => d.result).join(',') || 'none'}  ` +
        `focusWindow calls=${focusCalls.length}`
    )
    t0Report.push({ kind, run, cameForward, activations: activations.length, decisions, focusCalls })
  }
}

// --- controls ----------------------------------------------------------------
// "No activation event fired" is only worth reading if the same instrumentation DOES
// report one when there really is one. Two real activations, produced without any pointer
// at all, through the ordinary Apple-events route.
async function control(name, pressFirst) {
  await makeFinderFrontmost()
  await new Promise((r) => setTimeout(r, 200))
  const from = logSize()
  const s = startSampler()
  await new Promise((r) => setTimeout(r, 300))
  let t0 = Date.now()
  if (pressFirst) {
    const g = await evalIn(shelf, GRIP)
    if (checkTarget(g)) { s.stop(); return }
    t0 = Date.now()
    await cdpMouse('mousePressed', g.page.x, g.page.y)
    await new Promise((r) => setTimeout(r, 30))
    await cdpMouse('mouseReleased', g.page.x, g.page.y)
  }
  spawnSync('osascript', ['-e', 'tell application id "com.github.Electron" to activate'])
  if (!pressFirst) t0 = Date.now()
  await new Promise((r) => setTimeout(r, 2000))
  s.stop()
  const lines = [...logSince(from), ...s.lines].sort((a, b) => a.t - b.t)
  console.log(`\n────────── CONTROL: ${name} ──────────`)
  for (const m of lines) {
    const rel = m.t - t0
    const tag = `${rel >= 0 ? '+' : ''}${rel}`.padStart(7)
    if (m.src === 'front') console.log(`${tag}ms  front   ${m.app} (pid ${m.pid})${m.changed ? '  <= CHANGED' : ''}`)
    else {
      const rest = { ...m }
      delete rest.t; delete rest.src; delete rest.label
      console.log(`${tag}ms  probe   ${m.label}  ${JSON.stringify(rest)}`)
    }
  }
}
await control('a real activation, no Stash involved (does the probe see one?)', false)
await control('a real activation right after a press on the Stash (is it suppressed?)', true)

console.log('\n══════════ ROLL-UP ══════════')
for (const r of t0Report) {
  console.log(
    `${r.kind.padEnd(5)} run ${r.run}: front->PaneForge=${String(r.cameForward).padEnd(5)} ` +
      `activate events=${r.activations} decisions=[${r.decisions.map((d) => `${d.from}:${d.result} delta=${d.delta}`).join('; ')}] ` +
      `focusWindow=${r.focusCalls.length}${r.focusCalls.length ? ' ' + JSON.stringify(r.focusCalls.map((f) => ({ asked: f.asked, visible: f.visible }))) : ''}`
  )
}
if (main) {
  try {
    console.log('main window document.hasFocus() at the end:', await evalIn(main, 'document.hasFocus()'))
  } catch {}
}
console.log('input path used:', useHid ? 'HID (CGEventPost)' : 'CDP (HID blocked)')

shelf.ws.close()
if (main) main.ws.close()
closeCopy()
process.exit(0)
