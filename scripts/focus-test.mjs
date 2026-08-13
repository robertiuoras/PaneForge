// Where does the keyboard actually go?
//
// "PaneForge forced focus / broke focus again" was reported for months and fixed by
// guesswork every time, because nobody could see the thing being argued about: which
// element holds the caret after a click, a shortcut, a dialog. This drives a real test
// copy over CDP and reads `document.activeElement` after each step, so the answer is a
// table instead of an opinion.
//
//   npm run test:focus            build, launch a throwaway copy, run every case
//   npm run test:focus -- --keep  skip the build and use whatever is in out/
//
// The copy is minimized and runs under its own `focus-probe` profile, so it never takes
// the screen off you and never touches your real settings or panes. Panes are started on
// the `shell` agent - no CLI, no tokens, just a prompt to put a caret in.
//
// Every case is written as "after X, the caret should be in Y". A FAIL here is a bug a
// user feels within a minute of using the app.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps } from './test-app.mjs'
import { profileData } from './dev-profile.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
// A narrow red/green probe for the session-card lane button. The full focus suite also
// covers global shortcuts; this flag lets a card-click repair prove itself without an
// unrelated shortcut regression hiding its result.
const laneChipOnly = process.argv.includes('--lane-chip-only')
// The inverse, for bisecting the grid click window: the lane-chip case opens a flyout and
// Escapes it immediately before the grid is switched on, and it is the only step in that
// run that opens anything. Skipping it says in one run whether the flyout is the cause.
//   npm run test:focus -- --keep --skip-lane-chip
const skipLaneChip = process.argv.includes('--skip-lane-chip')
// Overridable for the same reason PF_RAIL_PORT is: a copy that died can leave this port
// bound to a pid that no longer exists, and every run afterwards reports "did the test copy
// start?" when the copy started and simply could not be talked to.
//   PF_FOCUS_PORT=9511 npm run test:focus
const PORT = Number(process.env.PF_FOCUS_PORT ?? 9411)
const PROFILE = 'focus-probe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Start from an empty profile every time.
 *
 * The run before left three panes open, so the next launch opened with "restore your
 * panes?" across the screen - and every click in the first case landed on that dialog
 * instead of a terminal. A test whose result depends on the previous run's leftovers is
 * worse than no test. The config written here also turns the offer off at the source.
 *
 * The folder comes from `profileData()`, NOT a hand-built `%APPDATA%` path. That path is
 * Windows-only, so on macOS this reset wrote into `~/AppData/Roaming` - a folder nothing
 * reads - while the profile Electron actually used
 * (`~/Library/Application Support/claude-orchestrator-focus-probe`) was never touched.
 * Every mac run therefore started on the PREVIOUS run's leftovers, which is exactly what
 * this function exists to prevent: that profile held `grid: true` and
 * `restoreAfterRestart: "ask"` on disk, the two things the config below forbids.
 */
function freshProfile() {
  const dir = profileData(PROFILE)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover copy still holding a file - the config below is what matters */
  }
  mkdirSync(dir, { recursive: true })
  // Written rather than left absent: the app seeds a new profile from the real one, and
  // the real one's saved desk is not something a test should open.
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ restoreAfterRestart: 'never', grid: false, notifyOnIdle: false }, null, 2)
  )
}

// ------------------------------------------------------------------ CDP

/** Chromium answers /json/list once the renderer exists; before that the port refuses. */
async function targets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await r.json()
  } catch {
    return []
  }
}

async function connect() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    // The overlay (shelf.html) is a page too, and it is the one that is NOT the window
    // the keyboard goes to. Match the main renderer only.
    const page = (await targets()).find(
      (t) => t.type === 'page' && /index\.html/.test(t.url) && !/shelf/.test(t.url)
    )
    if (page) return await open(page.webSocketDebuggerUrl)
    await sleep(400)
  }
  throw new Error(`No renderer on :${PORT} after 60s - did the test copy start?`)
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const waiting = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const p = waiting.get(msg.id)
      if (!p) return
      waiting.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
    ws.onerror = () => reject(new Error('CDP socket failed'))
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const n = ++id
            waiting.set(n, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: n, method, params }))
          }),
        close: () => ws.close()
      })
  })
}

/** Run an expression in the page and hand back its value, awaiting promises. */
async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}

/**
 * A real mouse press, not `el.click()`.
 *
 * The difference is the whole point of this file: Chromium moves focus on a genuine
 * mousedown and does nothing of the sort for a scripted click, so a scripted click would
 * report every focus bug as fixed.
 */
async function clickAt(cdp, selector, nth = 0) {
  const box = await evalIn(
    cdp,
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
  )
  if (!box) throw new Error(`nothing matched ${selector}[${nth}]`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    })
  }
  await sleep(120)
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  k: { key: 'k', code: 'KeyK', vk: 75 },
  g: { key: 'g', code: 'KeyG', vk: 71 },
  1: { key: '1', code: 'Digit1', vk: 49 },
  2: { key: '2', code: 'Digit2', vk: 50 }
}

/**
 * The app's command modifier on THIS platform - Cmd on a Mac, Ctrl everywhere else.
 *
 * `src/renderer/src/platform.ts` makes the two deliberately non-interchangeable: macOS
 * leaves Ctrl to the shell (Ctrl+C interrupts an agent, Ctrl+A jumps to line start), so
 * `modKey` accepts Cmd there and Cmd only. A test that presses Ctrl+2 on a Mac is
 * therefore not catching a broken shortcut, it is pressing a chord the app never claimed
 * and reporting the app's correct refusal as a failure - which is exactly what it did,
 * for as long as this suite has run on a Mac.
 *
 * CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */
const MOD_BIT = process.platform === 'darwin' ? 4 : 2
const MOD = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'

async function press(cdp, name, { ctrl = false, mod = false } = {}) {
  const k = KEYS[name]
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      modifiers: (ctrl ? 2 : 0) | (mod ? MOD_BIT : 0),
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk
    })
  }
  await sleep(150)
}

// ------------------------------------------------------- what has the caret

/**
 * Injected once. `where()` names the element holding the caret in the same terms the app
 * uses - "pane 1's terminal" - and `active()` says which pane the app BELIEVES is current,
 * so a divergence between the two shows up as two different numbers rather than a shrug.
 */
const PROBE = `
window.__focus = {
  panes: () => [...document.querySelectorAll('.pane')],
  where() {
    const a = document.activeElement
    if (!a || a === document.body) return 'nothing'
    const pane = a.closest ? a.closest('.pane') : null
    const i = pane ? this.panes().indexOf(pane) : -1
    const term = a.classList && a.classList.contains('xterm-helper-textarea')
    if (term && i >= 0) return 'terminal ' + i
    const tag = a.tagName.toLowerCase()
    const cls = (a.className && String(a.className).trim().split(/\\s+/)[0]) || ''
    return (i >= 0 ? 'pane ' + i + ' ' : '') + tag + (cls ? '.' + cls : '')
  },
  // The pane the app thinks is current: the lit one in a grid, the shown one otherwise.
  active() {
    const p = this.panes()
    const lit = p.findIndex((el) => el.classList.contains('focused'))
    if (lit >= 0) return lit
    return p.findIndex((el) => !el.classList.contains('hidden'))
  }
}
true`

// ------------------------------------------------------------------ cases

const results = []
function check(name, got, want, thinks) {
  const ok = got === want
  results.push({ name, got, want, ok })
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n` +
      `        caret: ${got}   app thinks: pane ${thinks}${ok ? '' : `   (wanted caret: ${want})`}`
  )
  return ok
}

async function run(cdp) {
  await evalIn(cdp, PROBE)

  /**
   * Read through the probe, reinstalling it if the renderer threw it away.
   *
   * `window.__focus` lives in the page, so any renderer reload wipes it and every read
   * afterwards dies with "Cannot read properties of undefined (reading 'panes')" - which
   * looks like the app failing and is only the probe being gone. A profile's FIRST launch
   * copies the live config in and reloads once it lands, so this happens on exactly the
   * run that matters: the first one after the profile was correctly cleared.
   */
  const viaProbe = async (expr) => {
    if (!(await evalIn(cdp, `typeof window.__focus === 'object' && window.__focus !== null`)))
      await evalIn(cdp, PROBE)
    return await evalIn(cdp, expr)
  }

  /**
   * What was in the way, printed only after a case has already failed.
   *
   * `caret: nothing` says the keyboard went to `body` and nothing at all about why, which
   * is how this suite's grid failures were read as a focus bug for a day. The two answers
   * that matter are "something is still on screen" and "the click did not land on the
   * terminal", and both are one DOM read.
   */
  const explain = async () => {
    const name = `((el) => el ? el.tagName.toLowerCase() + (el.className && String(el.className).trim() ? '.' + String(el.className).trim().split(/\\s+/).join('.') : '') : 'none')`
    const d = await viaProbe(`(() => {
      const name = ${name}
      const p = window.__focus.panes()[0]
      const r = p && p.getBoundingClientRect()
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null
      return {
        onScreen: [...document.querySelectorAll('.overlay, .dialog, .backdrop, .scrim, .flyout, .menu, .dropdown, .sheet')].map(name),
        overPane0: name(hit),
        active: name(document.activeElement)
      }
    })()`)
    console.log(
      `        why: over pane 0 -> ${d.overPane0}; activeElement ${d.active}; ` +
        `on screen: ${d.onScreen.length ? d.onScreen.join(', ') : 'nothing'}`
    )
  }

  // Two panes on the shell agent. `shell` runs the plain OS shell: no CLI to install, no
  // tokens, and it draws a prompt within a second - which is all a caret needs.
  await evalIn(
    cdp,
    `window.api.startSessions([
       { cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'probe-1' },
       { cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'probe-2' }
     ])`
  )
  const deadline = Date.now() + 20_000
  while ((await viaProbe('window.__focus.panes().length')) < 2 && Date.now() < deadline)
    await sleep(300)
  if ((await viaProbe('window.__focus.panes().length')) < 2)
    throw new Error('panes never appeared - the shell agent did not start')
  await sleep(1200)

  const where = () => viaProbe('window.__focus.where()')
  const active = () => viaProbe('window.__focus.active()')
  /**
   * Wait until every terminal is back inside its own pane.
   *
   * Switching the grid on re-lays out the panes immediately and each terminal refits a
   * few frames later, so in between there is a real moment where pane 0's xterm screen is
   * still full-window width - measured at 1166px inside a 590px pane, its middle 1px past
   * pane 0's right edge. `clickAt` aims at the middle of the terminal, so the click landed
   * in pane 1 and the case failed as a focus bug. It is a stale rect, not focus.
   *
   * Waiting for "the boxes stopped moving" is not enough (the stale one is not moving
   * either): wait for the thing the click actually depends on.
   */
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      const fitted = await evalIn(
        cdp,
        `[...document.querySelectorAll('.xterm-screen')].every((s) => {
          const p = s.closest('.pane'); if (!p) return false
          const a = s.getBoundingClientRect(), b = p.getBoundingClientRect()
          return a.width > 0 && a.right <= b.right + 2 && a.left >= b.left - 2 })`
      )
      if (fitted) return
      await sleep(80)
    }
  }
  const setGrid = async (on) => {
    await evalIn(cdp, `window.api.setConfig({ grid: ${on} })`)
    await settle()
  }
  /** Put the caret honestly in a pane, the way a person does. */
  const clickTerminal = async (n) => {
    await clickAt(cdp, '.xterm-screen', n)
    await sleep(150)
  }

  // --- one pane at a time -------------------------------------------------
  await setGrid(false)

  await clickTerminal(0)
  check('single: clicking a pane puts the caret in it', await where(), 'terminal 0', await active())

  await clickAt(cdp, '.list .row', 1)
  check(
    'single: after clicking a sidebar row the caret is in the pane it selected',
    await where(),
    'terminal 1',
    await active()
  )

  // A lane button is nested inside the session card. It may open the lane details, but
  // it must still select the session whose checkout it describes. Otherwise the largest
  // labelled target saying "lane a" feels like a dead part of the PaneForge-a row.
  if (!skipLaneChip) {
    await clickAt(cdp, '.list .row', 0)
    check(
      'single: lane-button probe starts on the other session',
      String(await active()),
      '0',
      await active()
    )
    await clickAt(cdp, '.list .row:nth-child(2) .lane-chip')
    check(
      'single: clicking the lane button also selects its session',
      String(await active()),
      '1',
      await active()
    )
    await press(cdp, 'Escape')
  }
  if (laneChipOnly) return

  // --- grid ---------------------------------------------------------------
  await setGrid(true)
  await clickTerminal(0)
  if (!check('grid: clicking a pane puts the caret in it', await where(), 'terminal 0', await active()))
    await explain()

  await press(cdp, '2', { mod: true })
  if (
    !check(
      `grid: ${MOD}+2 moves the caret, not just the highlight`,
      await where(),
      'terminal 1',
      await active()
    )
  )
    await explain()

  await clickTerminal(0)
  await press(cdp, 'Tab', { ctrl: true })
  if (
    !check(
      'grid: Ctrl+Tab moves the caret to the next pane',
      await where(),
      'terminal 1',
      await active()
    )
  )
    await explain()

  await clickAt(cdp, '.list .row', 0)
  if (
    !check(
      'grid: clicking a sidebar row moves the caret too',
      await where(),
      'terminal 0',
      await active()
    )
  )
    await explain()

  // --- a new pane must not grab the keyboard off you ----------------------
  await clickTerminal(0)
  const before = await where()
  await evalIn(
    cdp,
    `window.api.startSession({ cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'probe-3' })`
  )
  await sleep(2500)
  check(
    'grid: a pane starting elsewhere does not steal the caret',
    await where(),
    before,
    await active()
  )

  // --- dialogs give the keyboard back ------------------------------------
  await clickTerminal(0)
  await press(cdp, 'k', { mod: true })
  const inPalette = await where()
  // The palette has to have OPENED, or "closing it gives the caret back" passes without
  // testing anything: this case pressed Ctrl+K on a Mac, where the app's modifier is Cmd,
  // so the palette never appeared, the caret never left terminal 0, and the assertion that
  // it came back was true for the wrong reason. It printed `which took: terminal 0` the
  // whole time - the evidence was on screen and read as a detail.
  check(
    `grid: ${MOD}+K opens the command palette`,
    inPalette.startsWith('terminal') ? 'palette never opened' : 'opened',
    'opened',
    await active()
  )
  await press(cdp, 'Escape')
  await sleep(250)
  check(
    `grid: closing the command palette (which took: ${inPalette}) gives the caret back`,
    await where(),
    'terminal 0',
    await active()
  )

  // --- chrome buttons are not a place to leave the keyboard ---------------
  await clickTerminal(0)
  // "Fix" repaints the pane and changes nothing else - the safest button on the header
  // to click a hundred times, and it is a plain <button>, which is the case that matters:
  // Chromium leaves the keyboard sitting on it.
  await clickAt(cdp, '.pane-title button.fix', 0)
  check(
    'grid: clicking a button in the pane header leaves the caret in the pane',
    await where(),
    'terminal 0',
    await active()
  )

  // Coming back to the window. The real thing is an alt-tab, which cannot be posted from
  // here; what is checked is the wiring behind it - the keyboard is somewhere useless, the
  // window is entered, the pane takes it back.
  await clickTerminal(0)
  await evalIn(cdp, 'document.activeElement.blur(); window.dispatchEvent(new FocusEvent("focus"))')
  await sleep(250)
  check(
    'coming back to the window puts the caret back in the pane',
    await where(),
    'terminal 0',
    await active()
  )

  // A dropdown is the one control that SHOULD hold the keyboard while it is open - and
  // must hand it straight back when it closes, which is where it used to strand it.
  await clickTerminal(0)
  await clickAt(cdp, '.pane-title button.select', 0)
  const inMenu = await where()
  await press(cdp, 'Escape')
  await sleep(250)
  check(
    `grid: closing a dropdown (which took: ${inMenu}) gives the caret back`,
    await where(),
    'terminal 0',
    await active()
  )
}

// ------------------------------------------------------------------ main

async function main() {
  if (!keep) {
    console.log('== Building')
    const b = spawnSync('npm', ['run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })
    if (b.status !== 0) process.exit(b.status ?? 1)
  }

  closeTestApps(root)
  freshProfile()
  console.log(`== Launching the ${PROFILE} copy (minimized, on :${PORT})`)
  const electron = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  )
  const child = spawn(
    electron,
    ['.', '--minimized', `--remote-debugging-port=${PORT}`],
    {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      // A profile of its own: the probe starts and kills panes, and doing that in the
      // `dev` profile would eat whatever another session had open there.
      env: { ...process.env, PANEFORGE_PROFILE: PROFILE }
    }
  )
  child.unref()

  let cdp
  try {
    cdp = await connect()
    await cdp.send('Runtime.enable')
    await run(cdp)
  } finally {
    try {
      cdp?.close()
    } catch {
      /* already gone */
    }
    closeTestApps(root)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} focus cases pass`)
  if (failed.length) {
    console.log('\nBroken:')
    for (const f of failed) console.log(`  - ${f.name}\n      got ${f.got}, wanted ${f.want}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(`focus probe failed: ${e.message}`)
  closeTestApps(root)
  process.exit(1)
})
