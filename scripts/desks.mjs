// Two dev copies of THIS checkout, paired to each other, on one machine.
//
// Why this exists: every remote-session bug in this app - the mirrored pane cut across
// the screen, a handoff that never arrives, a device that lists nothing - can only be
// seen with two PaneForges talking to each other, and until now that meant two machines
// and a release on each. `npm run try` cannot do it either: it calls closeTestApps()
// first, which kills every Electron started from this checkout, so launching the second
// desk killed the first one. That is the whole reason a two-desk repro was never written.
//
// So this launches them itself - one closeTestApps at the start, then two spawns - gives
// each its own profile, its own CDP port and its own remote port, and pairs desk 2 to
// desk 1 over 127.0.0.1. Both run the code in out/, so an edit is `npm run build` and
// `desks up` again: no install, no release, no second machine.
//
//   node scripts/desks.mjs up [--show]     build if needed, launch both, pair them
//   node scripts/desks.mjs mirror          open a pane on desk 1, mirror it on desk 2
//   node scripts/desks.mjs eval 2 "<expr>" ask one desk a question (like probe.mjs)
//   node scripts/desks.mjs state           what each desk thinks is going on
//   node scripts/desks.mjs down            close both
//
// Desk 1 is the HOST (the machine doing the work); desk 2 is the one watching, which is
// the side every "remote viewing is broken" report is about.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { devProfile } from './dev-profile.mjs'
import { closeTestApps, waitTestAppsGone } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()

// Desk 1 keeps the profile `npm run try` uses for this checkout, so the window a person
// already has open is desk 1 and nothing about the ordinary workflow changes. Desk 2 is
// that name plus `2`. The remote ports are deliberately NOT 7312: the installed app on
// this machine is usually hosting on it, and a desk that pairs with the live app instead
// of with its twin is a repro of somebody else's build.
const DESKS = [
  { n: 1, profile: devProfile(root), port: 9334, remote: 7412, device: 'desk-one' },
  { n: 2, profile: `${devProfile(root)}2`, port: 9335, remote: 7413, device: 'desk-two' }
]

const args = process.argv.slice(2)
const cmd = args[0] ?? 'up'

/** Evaluate an expression in a desk's renderer. Same contract as probe.mjs. */
async function ask(desk, expression, { tries = 40 } = {}) {
  const page = await findPage(desk.port, tries)
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
  await new Promise((res) => ws.addEventListener('open', res, { once: true }))
  const send = (method, params) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  const out = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  ws.close()
  if (out.exceptionDetails)
    throw new Error(
      `desk ${desk.n}: ${out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails)}`
    )
  return out.result?.value ?? out.result
}

async function findPage(port, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Same guard probe.mjs carries: a port answered by another checkout's copy gives
      // real numbers about code that was never loaded here.
      if (page && !(page.url ?? '').toLowerCase().startsWith(rootUrl))
        throw new Error(`port ${port} belongs to another checkout: ${page.url}`)
      if (page) return page
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no debuggable window on port ${port} - run \`node scripts/desks.mjs up\``)
}

function electronBin() {
  const bin = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  )
  if (!existsSync(bin)) {
    console.error('No Electron in node_modules. Run `npm install` first.')
    process.exit(1)
  }
  return bin
}

function build() {
  const page = join(root, 'out', 'renderer', 'index.html')
  if (args.includes('--keep') && existsSync(page)) return
  console.log('== Building')
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

async function up() {
  build()
  // ONE close, before either launch. This is the line try.mjs runs per launch, which is
  // what made a second desk impossible: it matches every Electron from this checkout.
  closeTestApps(root)
  if (!(await waitTestAppsGone(root))) console.log('(a previous copy is taking its time closing)')

  const show = args.includes('--show')
  const bin = electronBin()
  for (const d of DESKS) {
    spawn(
      bin,
      ['.', ...(show ? [] : ['--minimized']), `--remote-debugging-port=${d.port}`],
      {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PANEFORGE_PROFILE: d.profile, PF_DEVICE: d.device }
      }
    ).unref()
    console.log(`== desk ${d.n} (${d.profile}) launching, CDP ${d.port}, remote ${d.remote}`)
  }

  // Each desk answers on its own port, so waiting is per desk rather than a sleep.
  for (const d of DESKS) await findPage(d.port, 60)

  // Desk 1 hosts on its own port; desk 2 does not host at all, so nothing on this
  // machine ever binds the same port twice.
  const host = await ask(
    DESKS[0],
    `(async () => {
       await window.api.setRemotePort(${DESKS[0].remote})
       // Listening is asynchronous, and the state this call returns is the state BEFORE
       // the socket is up - so asking once reports "refused to host" on a desk that is
       // about to be perfectly fine.
       let s = await window.api.setRemoteHost(true)
       for (let i = 0; i < 40 && !s.self.hosting && !s.self.error; i++) {
         await new Promise(r => setTimeout(r, 250))
         s = await window.api.remoteState()
       }
       return { id: s.self.id, name: s.self.name, code: s.self.code, port: s.self.port,
                hosting: s.self.hosting, error: s.self.error || null }
     })()`
  )
  if (!host.hosting) {
    console.error(`desk 1 refused to host: ${host.error ?? 'no reason given'}`)
    process.exit(1)
  }

  const paired = await ask(
    DESKS[1],
    `(async () => {
       await window.api.setRemotePort(${DESKS[1].remote})
       const r = await window.api.pairRemote({ address: '127.0.0.1', port: ${DESKS[0].remote},
                                               code: ${JSON.stringify(host.code)}, name: 'desk one' })
       if (!r.ok) return { ok: false, error: r.error }
       const peer = (r.state.peers || []).find(p => p.id === ${JSON.stringify(host.id)})
       if (peer) await window.api.connectRemote(peer.id, true)
       return { ok: true, peers: (r.state.peers || []).map(p => ({ id: p.id, name: p.name, status: p.status })) }
     })()`
  )
  if (!paired.ok) {
    console.error(`desk 2 could not pair with desk 1: ${paired.error}`)
    process.exit(1)
  }
  console.log('== paired')
  console.log(JSON.stringify({ host: { id: host.id, name: host.name }, desk2: paired.peers }, null, 2))
  console.log(
    `\nDesk 1 is the machine doing the work; desk 2 is watching it.\n` +
      `  node scripts/desks.mjs mirror        a pane on 1, mirrored on 2\n` +
      `  node scripts/desks.mjs eval 2 "..."  measure the watching side\n` +
      `  node scripts/desks.mjs down`
  )
}

/** Open a pane on desk 1 and mirror it on desk 2 - the shape every remote report is about. */
async function mirror() {
  const made = await ask(
    DESKS[0],
    `(async () => {
       const s = await window.api.startSession({ cwd: ${JSON.stringify(root)}, agent: 'shell' })
       return { id: s && (s.id || s.sessionId || s), raw: s }
     })()`
  )
  const id = typeof made.id === 'string' ? made.id : null
  if (!id) {
    console.error('desk 1 did not return a session id:', JSON.stringify(made.raw))
    process.exit(1)
  }
  const watched = await ask(
    DESKS[1],
    `(async () => {
       const s = await window.api.remoteState()
       const peer = (s.peers || [])[0]
       if (!peer) return { ok: false, error: 'desk 2 has no peer' }
       await window.api.watchRemote(peer.id, [${JSON.stringify(id)}], false)
       await new Promise(r => setTimeout(r, 1500))
       const list = await window.api.listSessions()
       return { ok: true, mirrored: list.filter(x => x.id.includes('@')).map(x => x.id) }
     })()`
  )
  console.log(JSON.stringify({ paneOnDesk1: id, ...watched }, null, 2))
}

/** An open CDP session on a desk, so a size override survives long enough to measure under. */
async function open(desk) {
  const page = await findPage(desk.port, 20)
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
  await new Promise((res) => ws.addEventListener('open', res, { once: true }))
  const send = (method, params) => {
    const id = ++seq
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  return {
    async size(width, height, deviceScaleFactor = 1) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: false
      })
      await new Promise((r) => setTimeout(r, 900))
    },
    async ask(expression) {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (out.exceptionDetails)
        throw new Error(
          `desk ${desk.n}: ${out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails)}`
        )
      return out.result?.value ?? out.result
    },
    async close() {
      try {
        await send('Emulation.clearDeviceMetricsOverride')
      } catch {
        /* the window may already be gone */
      }
      ws.close()
    }
  }
}

/**
 * The remote-viewing bug, measured: a WIDE host and a NARROW viewer, at the viewer's own
 * device pixel ratio.
 *
 * Both overrides have to be live AT THE SAME TIME, which is why this is one command rather
 * than three. `Emulation.setDeviceMetricsOverride` belongs to the CDP session and is
 * dropped the moment the socket closes, so a desk sized by one command is back to its old
 * size before the next one measures - and `Browser.setWindowBounds`, the obvious way to
 * make it stick, is not implemented by Electron ("'Browser.getWindowForTarget' wasn't
 * found").
 *
 * `--dpr 2` is the half that matters for a Mac: a Retina viewer draws cells at fractional
 * CSS widths, so every rounding step in the fit walk lands somewhere else than it does on
 * this machine at 1.
 */
async function repro() {
  const dpr = Number(flagOf('--dpr', 2))
  const hostW = Number(flagOf('--host-width', 1900))
  const hostH = Number(flagOf('--host-height', 1100))
  const seeW = Number(flagOf('--view-width', 900))
  const seeH = Number(flagOf('--view-height', 640))

  const one = await open(DESKS[0])
  const two = await open(DESKS[1])
  await one.size(hostW, hostH, 1)
  await two.size(seeW, seeH, dpr)
  // The viewer re-fits on a frame timer; give the walk room to converge before judging it.
  await new Promise((r) => setTimeout(r, 2500))

  const host = await one.ask(
    `Object.entries(window.__pf).filter(([,p]) => p && p.term)
       .map(([id,p]) => ({ id, cols: p.term.cols, rows: p.term.rows, font: p.term.options.fontSize }))`
  )
  const view = await two.ask(
    `(() => {
       const panes = []
       document.querySelectorAll('.pane').forEach(pane => {
         const wrap = pane.querySelector('.xterm-wrap')
         const host = pane.querySelector('.xterm-host')
         const screen = pane.querySelector('.xterm-screen')
         if (!wrap || !screen) return
         const r = screen.getBoundingClientRect()
         const w = wrap.getBoundingClientRect()
         panes.push({
           room: wrap.clientWidth, roomH: wrap.clientHeight,
           drawn: screen.offsetWidth, drawnH: screen.offsetHeight,
           transform: host ? host.style.transform || '(none)' : '(no host)',
           /* The reading that decides the bug: how much of the far end's screen is
              actually inside this pane. Under 1 means it is cut. */
           shownAcross: +(Math.min(1, (Math.min(r.right, w.right) - r.left) / Math.max(1, r.width)).toFixed(3)),
           shownDown: +(Math.min(1, (Math.min(r.bottom, w.bottom) - r.top) / Math.max(1, r.height)).toFixed(3))
         })
       })
       const terms = Object.entries(window.__pf).filter(([,p]) => p && p.term)
         .map(([id,p]) => ({ id, cols: p.term.cols, rows: p.term.rows, font: p.term.options.fontSize }))
       return { dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight, terms, panes }
     })()`
  )
  await one.close()
  await two.close()
  console.log(JSON.stringify({ host: { size: [hostW, hostH], panes: host }, viewer: view }, null, 2))
  // A pane with no box was not measured, and "not measured" may never wear the shape of
  // "cut in half": under 720px the phone layout gives the panes `display: none` and hands
  // the screen to the list, so every reading comes back 0 and a naive check reports the
  // worst cut it has ever seen on a window that is drawing no terminal at all.
  const unmeasured = (view.panes || []).filter((p) => !(p.room > 0) || !(p.drawn > 0))
  if (unmeasured.length)
    console.log(
      `\n${unmeasured.length} pane(s) had no box - at ${view.innerW}px this window is in the ` +
        `phone layout, where the panes are display:none. Give the viewer 760px or more.`
    )
  const cut = (view.panes || [])
    .filter((p) => p.room > 0 && p.drawn > 0)
    .filter((p) => p.shownAcross < 0.999 || p.shownDown < 0.999)
  console.log(
    cut.length
      ? `\nCUT: ${cut.length} mirrored pane(s) draw past their own box - ${cut
          .map((p) => `${Math.round(p.shownAcross * 100)}% across, ${Math.round(p.shownDown * 100)}% down`)
          .join('; ')}`
      : '\nWhole host screen is inside the pane.'
  )
}

function flagOf(name, fallback) {
  const i = args.indexOf(name)
  return i < 0 ? fallback : args[i + 1]
}

async function state() {
  for (const d of DESKS) {
    const s = await ask(
      d,
      `(async () => {
         const r = await window.api.remoteState()
         const list = await window.api.listSessions()
         return { self: { name: r.self.name, hosting: r.self.hosting, port: r.self.port },
                  peers: (r.peers||[]).map(p => ({ name: p.name, status: p.status, panes: (p.sessions||[]).length })),
                  panes: list.map(x => x.id) }
       })()`
    )
    console.log(`desk ${d.n}:`, JSON.stringify(s, null, 2))
  }
}

if (cmd === 'up') await up()
else if (cmd === 'down') {
  closeTestApps(root)
  await waitTestAppsGone(root)
  console.log('Both desks closed. The live app is untouched.')
} else if (cmd === 'mirror') await mirror()
else if (cmd === 'state') await state()
else if (cmd === 'repro') await repro()
else if (cmd === 'XXsize') {
  const desk = DESKS.find((d) => d.n === Number(args[1]))
  if (!desk) {
    console.error('which desk? `size 1 1900 1100`')
    process.exit(2)
  }
  await resize(desk, Number(args[2] || 1200), Number(args[3] || 800))
  console.log(JSON.stringify(await ask(desk, '({ w: innerWidth, h: innerHeight })')))
}
else if (cmd === 'eval') {
  const n = Number(args[1])
  const desk = DESKS.find((d) => d.n === n)
  if (!desk) {
    console.error('which desk? `eval 1` or `eval 2`')
    process.exit(2)
  }
  console.log(JSON.stringify(await ask(desk, args.slice(2).join(' ')), null, 2))
} else {
  console.error(`unknown command "${cmd}" - up | mirror | eval | state | down`)
  process.exit(2)
}
process.exit(0)
