// Do the prompt tags on the rail run down the pane in the order they were sent?
//
// A tag's position comes from the buffer line its marker sits on, and the rail's whole
// promise is "top to bottom is oldest to newest". A full-screen repaint - `cls`, or any
// TUI that erases the display and homes the cursor - breaks that promise: the cleared
// screen is reused from its top row, so the next prompt anchors ABOVE a prompt that was
// sent before it, and its tag draws higher up the rail than the older one.
//
//   npm run test:rail            build, launch a throwaway copy, measure
//   npm run test:rail -- --keep  skip the build and use whatever is in out/
//
// The copy is minimized under its own `rail-probe` profile, so it never takes the screen
// and never touches your real panes. Panes run the `shell` agent - typing into it is a
// real keypress stream, which is exactly what the rail listens to.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
// Overridable because a port can be held by a copy that is no longer running: a rail-probe
// that died left its sockets bound to a pid that no longer exists, Chromium's "Cannot start
// http server for devtools" went to the copy's own stderr, which is `stdio: 'ignore'`, and
// what this test printed instead was "No renderer on :9412 after 60s - did the test copy
// start?" for every run afterwards. It had started; it simply could not be talked to.
//   PF_RAIL_PORT=9413 npm run test:rail
const PORT = Number(process.env.PF_RAIL_PORT ?? 9412)
const PROFILE = 'rail-probe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freshProfile() {
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const dir = join(roaming, `claude-orchestrator-${PROFILE}`)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover copy still holding a file - the config below is what matters */
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ restoreAfterRestart: 'never', grid: false, notifyOnIdle: false }, null, 2)
  )
}

// ------------------------------------------------------------------ CDP

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

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result.value
}

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

/** Real keypresses: the rail reads the pane's input stream, not the DOM. */
async function type(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      unmodifiedText: ch,
      key: ch
    })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
}

async function enter(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      text: type === 'keyDown' ? '\r' : undefined,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  }
  await sleep(400)
}

/** Every tag on the rail, top to bottom of the DOM - which is oldest to newest. */
const READ_MARKS = `(() => {
  const rail = document.querySelector('.mark-rail')
  return {
    rail: rail ? Math.round(rail.getBoundingClientRect().height) : 0,
    marks: [...document.querySelectorAll('.mark')].map((el) => ({
      top: Math.round(parseFloat(el.style.top) * 10) / 10,
      label: el.getAttribute('aria-label')
    }))
  }
})()`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
}

async function run(cdp) {
  await evalIn(
    cdp,
    `window.api.startSession({ cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'rail-probe' })`
  )
  const deadline = Date.now() + 20_000
  while ((await evalIn(cdp, "document.querySelectorAll('.pane').length")) < 1 && Date.now() < deadline)
    await sleep(300)
  if ((await evalIn(cdp, "document.querySelectorAll('.pane').length")) < 1)
    throw new Error('no pane appeared - the shell agent did not start')
  await sleep(2500)
  await clickAt(cdp, '.xterm-screen', 0)

  // A tag only moves once the buffer is taller than the screen, so the run starts with
  // enough output to give the rail a scale to place things on.
  const filler = (n) => `for($i=1;$i -le ${n};$i++){ echo "filler $i" }`
  // An agent's screen, drawn the way Claude Code and Codex draw one: a box rule near the
  // top, more output, a second box rule just above where the prompt is typed.
  const screen =
    `$e=[char]27; Write-Host "${'${e}'}[2J${'${e}'}[H" -NoNewline; ` +
    `Write-Host ("$([char]0x2500)"*20); 1..9|%{ echo "text $_" }; ` +
    `Write-Host ("$([char]0x2500)"*20); 1..3|%{ echo "line $_" }`
  // The TUI redrawing over its own box: the near rule is overwritten in place - not
  // erased, so nothing is disposed - and the rule further up is the next one a scan
  // walking upwards will find.
  const overwrite =
    `$e=[char]27; Write-Host "${'${e}'}[11;1Hxxxxxxxxxxxxxxxxxxxx" -NoNewline; ` +
    `Write-Host "${'${e}'}[18;1H" -NoNewline`

  await type(cdp, filler(300))
  await enter(cdp)
  await sleep(4000)

  // Prompt one is typed just under the near rule, and anchors to it.
  await type(cdp, screen)
  await enter(cdp)
  await sleep(1500)
  await type(cdp, 'echo rail-prompt-one')
  await enter(cdp)
  await sleep(1200)

  const before = await evalIn(cdp, READ_MARKS)
  console.log(`  tags after prompt one: ${JSON.stringify(before)}`)

  // Prompt two is typed after that rule is painted over. The buffer has not grown, so
  // the only rule left to find is the one near the top of the screen - above the line
  // prompt one is anchored to - and prompt two's tag draws above the older tag.
  await type(cdp, overwrite)
  await enter(cdp)
  await sleep(1500)
  await type(cdp, 'echo rail-prompt-two')
  await enter(cdp)
  await sleep(1200)
  // Until the buffer grows past them, every tag on the current screen pins to the bottom
  // of the rail, so an order that is already wrong cannot be seen. This is the output
  // that puts them back on the scale.
  await type(cdp, filler(800))
  await enter(cdp)
  await sleep(9000)

  const after = await evalIn(cdp, READ_MARKS)
  console.log(`  tags after the repaint: ${JSON.stringify(after)}`)

  const marks = after.marks
  // Tags that all sit at the same height prove nothing: on a buffer barely taller than the
  // screen every tag pins to the bottom of the rail, and a wrong order hides there.
  check(
    'the rail has a scale to place tags on',
    new Set(marks.map((m) => m.top)).size >= 3,
    `${new Set(marks.map((m) => m.top)).size} distinct tops across ${marks.length} tags`
  )
  check(
    'a prompt sent after a screen clear draws below the prompt before it',
    marks.length >= 2 && marks.every((m, i) => i === 0 || m.top >= marks[i - 1].top - 0.5),
    marks.length < 2
      ? `only ${marks.length} tag(s) on the rail - the probe never registered two prompts`
      : `rail ${after.rail}px, tops top-to-bottom: ${marks.map((m) => m.top).join(', ')}`
  )
  check(
    'the newest tag is the lit one',
    await evalIn(cdp, "[...document.querySelectorAll('.mark')].findIndex((el) => el.classList.contains('newest')) === document.querySelectorAll('.mark').length - 1"),
    'last tag in DOM order carries .newest'
  )

  // A tag that is drawn and cannot be pressed is the bug this pins. `.xterm-wrap` is
  // `position: relative` with no z-index, so it is not a stacking context and xterm's own
  // layers compete with the rail rather than being contained by the terminal:
  // `.xterm-link-layer` is z-index 2 and covers the whole screen, so a rail with no
  // z-index of its own was painted over and every click landed on the link layer. Hit
  // testing is the only way to see that - the tags measure and render exactly right.
  const reach = await evalIn(
    cdp,
    `(() => {
      // "Reachable" is: the thing at a tag's centre is a TAG. Not necessarily this one -
      // two prompts on the same buffer line share a hit box, and the newer sits on top by
      // design. What must never be there is the terminal.
      const at = (el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return Boolean(hit && (el.contains(hit) || hit.contains(el) || hit.closest('.mark')))
      }
      const marks = [...document.querySelectorAll('.mark')]
      const covered = marks.filter((el) => !at(el))
      const pill = document.querySelector('.jump-newest')
      return {
        marks: marks.length,
        covered: covered.length,
        blocker: covered.length
          ? (() => {
              const r = covered[0].getBoundingClientRect()
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              return hit ? String(hit.className || hit.tagName) : 'nothing'
            })()
          : '',
        pill: pill ? at(pill) : null
      }
    })()`
  )
  check(
    'every tag on the rail can actually be clicked',
    reach.marks > 0 && reach.covered === 0,
    reach.covered
      ? `${reach.covered} of ${reach.marks} tags hit-test to "${reach.blocker}" instead of themselves`
      : `${reach.marks} tags, each is the element at its own centre`
  )
  check(
    'the "newest" pill is reachable too, when it is showing',
    reach.pill !== false,
    reach.pill === null ? 'not on screen in this run - nothing to check' : 'pill is the element at its own centre'
  )
}

async function main() {
  if (!keep) {
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
  const child = spawn(electron, ['.', '--minimized', `--remote-debugging-port=${PORT}`], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PANEFORGE_PROFILE: PROFILE }
  })
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
  console.log(`\n${results.length - failed.length}/${results.length} rail cases pass`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(`rail probe failed: ${e.message}`)
  closeTestApps(root)
  process.exit(1)
})
