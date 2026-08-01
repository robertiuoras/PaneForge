// Does pressing a prompt tag on the rail actually DO anything?
//
// rail-test.mjs proves the tags are drawn in the right order and that
// `elementFromPoint` at a tag's centre returns the tag. That is where it stops,
// and "the pointer would land on it" is not "pressing it works" - measured
// 2026-08-01, the one case in that file that presses a real button (the Newest
// pill) failed while its own hit test passed. A tag you can aim at and cannot use
// is exactly the bug reported twice from the desk.
//
// So this file watches the whole pointer path instead of one predicate: which
// element receives pointerdown / mousedown / mouseup / click, whether React's
// handler runs, and whether the buffer actually moved afterwards.
//
//   npm run test:railclick             build, launch a throwaway copy, measure
//   npm run test:railclick -- --keep   skip the build, use whatever is in out/
//   npm run test:railclick -- --show   run the copy visible (it takes the screen)
//
// --show exists because the copy is normally MINIMIZED, and a window that never
// produces a frame is a real suspect for "the click went nowhere": Chromium hit
// tests injected input against the last composited frame. Running both ways is
// what separates a bug in the app from a bug in the harness.
//
// Port: PF_RAILCLICK_PORT (default 9414). A dead copy can leave the previous one
// bound - see scripts/rail-test.mjs for the same note.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps, waitTestAppsGone } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const show = process.argv.includes('--show')
const PORT = Number(process.env.PF_RAILCLICK_PORT ?? 9414)
const PROFILE = 'railclick-probe'

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
  for (const t of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: t,
      key: 'Enter',
      code: 'Enter',
      text: t === 'keyDown' ? '\r' : undefined,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  }
  await sleep(400)
}

/** A real pointer press and release at a point, the way the OS would send one. */
async function pressAt(cdp, x, y) {
  for (const t of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: t,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: t === 'mousePressed' ? 1 : 0
    })
  }
  await sleep(150)
}

// ------------------------------------------------------------------ the probe

/**
 * Record every pointer event the document sees, in the capture phase, so a click
 * swallowed before it reaches the button is still visible. Also hooks the rail's
 * own React handler by watching for the class the pane adds on a successful jump.
 */
const INSTALL_SPY = `(() => {
  window.__spy = []
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(t, (e) => {
      const el = e.target
      window.__spy.push({
        type: t,
        target: el && el.className ? String(el.className) : (el && el.tagName) || '?',
        onMark: Boolean(el && el.closest && el.closest('.mark')),
        defaultPrevented: e.defaultPrevented
      })
    }, true)
  }
  return true
})()`

const TAG_POINT = `(() => {
  const marks = [...document.querySelectorAll('.mark')]
  if (!marks.length) return null
  // The OLDEST tag: it is the one furthest from the tail, so a jump to it is the
  // most visible move the buffer can make, and it never shares a hit box with the
  // newest tag (which sits under the pointer's resting place in a busy pane).
  const el = marks[0]
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const hit = document.elementFromPoint(cx, cy)
  return {
    x: cx,
    y: cy,
    w: Math.round(r.width),
    h: Math.round(r.height),
    hit: hit ? String(hit.className || hit.tagName) : 'nothing',
    onMark: Boolean(hit && hit.closest && hit.closest('.mark')),
    label: el.getAttribute('aria-label')
  }
})()`

/** Where the pane's view actually is, so "it jumped" is a number, not a class. */
const VIEW = `(() => {
  const vp = document.querySelector('.xterm-viewport')
  return vp ? { top: Math.round(vp.scrollTop), height: Math.round(vp.scrollHeight) } : null
})()`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`)
}

async function run(cdp) {
  await evalIn(
    cdp,
    `window.api.startSession({ cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'railclick' })`
  )
  const deadline = Date.now() + 20_000
  while (
    (await evalIn(cdp, "document.querySelectorAll('.pane').length")) < 1 &&
    Date.now() < deadline
  )
    await sleep(300)
  if ((await evalIn(cdp, "document.querySelectorAll('.pane').length")) < 1)
    throw new Error('no pane appeared - the shell agent did not start')
  await sleep(2500)

  // Enough scrollback that a jump to the oldest tag is a big, unmistakable move.
  const filler = (n) => `for($i=1;$i -le ${n};$i++){ echo "filler $i" }`
  await type(cdp, filler(400))
  await enter(cdp)
  await sleep(5000)
  // Then several prompts in quick succession with almost no output between them.
  // This is the normal shape of a conversation - ask, short answer, ask again -
  // and it is what puts four tags inside ten pixels of rail once the buffer grows
  // past them. A run that only ever sends one prompt per screenful cannot see the
  // bug at all.
  for (const n of ['two', 'three', 'four', 'five']) {
    await type(cdp, `echo railclick-${n}`)
    await enter(cdp)
    await sleep(700)
  }
  await type(cdp, filler(600))
  await enter(cdp)
  await sleep(7000)

  const tag = await evalIn(cdp, TAG_POINT)
  if (!tag) throw new Error('no tags on the rail - the probe never registered a prompt')
  console.log(`  oldest tag: ${JSON.stringify(tag)}`)

  check(
    'a tag is the element at its own centre',
    tag.onMark === true,
    tag.onMark ? `hit test returns "${tag.hit}"` : `hit test returns "${tag.hit}" - something covers the rail`
  )

  // The drawn bar is 14x5. What the pointer may actually aim at is the hit box the
  // ::before adds, and a target that small next to a 17px scrollbar is the whole
  // complaint - so it is measured rather than assumed.
  const hitbox = await evalIn(
    cdp,
    `(() => {
      const el = document.querySelector('.mark')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      // Walk out from the centre until the point stops belonging to a tag.
      const on = (x, y) => { const h = document.elementFromPoint(x, y); return Boolean(h && h.closest && h.closest('.mark')) }
      let left = 0, right = 0, up = 0, down = 0
      while (left < 60 && on(cx - left - 1, cy)) left++
      while (right < 60 && on(cx + right + 1, cy)) right++
      while (up < 60 && on(cx, cy - up - 1)) up++
      while (down < 60 && on(cx, cy + down + 1)) down++
      return { width: left + right + 1, height: up + down + 1 }
    })()`
  )
  console.log(`  clickable area around a tag: ${JSON.stringify(hitbox)}`)

  await evalIn(cdp, INSTALL_SPY)
  const before = await evalIn(cdp, VIEW)
  await pressAt(cdp, tag.x, tag.y)
  await sleep(700)
  const after = await evalIn(cdp, VIEW)
  const spy = await evalIn(cdp, 'window.__spy')

  console.log(`  view before ${JSON.stringify(before)} -> after ${JSON.stringify(after)}`)
  console.log(`  events seen: ${JSON.stringify(spy)}`)

  const gotClick = spy.some((e) => e.type === 'click' && e.onMark)
  check(
    'a press at the tag produces a click ON the tag',
    gotClick,
    gotClick
      ? 'click event reached the tag'
      : `no click on a tag. events: ${spy.map((e) => `${e.type}->${e.target}`).join(', ') || 'none at all'}`
  )

  const moved = before && after && Math.abs(after.top - before.top) > 20
  check(
    'pressing the tag moves the pane to that prompt',
    Boolean(moved),
    before && after
      ? `scrollTop ${before.top} -> ${after.top} (of ${after.height})`
      : 'no viewport to measure'
  )

  // ------------------------------------------------------- one tag, one target
  //
  // The reach check in rail-test.mjs asks whether the thing at a tag's centre is
  // A tag, and treats "a newer one is on top" as by design. On a real pane it is
  // the bug: the bars are 5px apart when prompts land near each other in the
  // buffer, the hit box each one grows is 18px tall, so a tag's own centre
  // belongs to a SIBLING and pressing what you can see jumps somewhere else - or,
  // when the sibling is the newest and the pane is already there, does nothing at
  // all. That is what "unable to click the tags" looks like from the desk.
  const identity = await evalIn(
    cdp,
    `(() => {
      const marks = [...document.querySelectorAll('.mark')]
      const rows = marks.map((el, i) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        const owner = hit && hit.closest ? hit.closest('.mark') : null
        return {
          i,
          top: Math.round(parseFloat(el.style.top) * 10) / 10,
          self: owner === el,
          stolenBy: owner ? marks.indexOf(owner) : -1
        }
      })
      const gaps = rows.slice(1).map((r, i) => Math.round((r.top - rows[i].top) * 10) / 10)
      return { rows, gaps, stolen: rows.filter((r) => !r.self).length }
    })()`
  )
  console.log(`  gaps between tags: ${JSON.stringify(identity.gaps)}`)
  check(
    'each tag is the target at its own centre, not a neighbour',
    identity.stolen === 0,
    identity.stolen === 0
      ? `${identity.rows.length} tags, none covered by a sibling`
      : `${identity.stolen} of ${identity.rows.length} tags hit-test to a DIFFERENT tag: ` +
        identity.rows
          .filter((r) => !r.self)
          .map((r) => `#${r.i}(top ${r.top})->#${r.stolenBy}`)
          .join(', ')
  )

  // ---------------------------------------------------------------- aiming
  //
  // The centre works. The complaint from the desk is that pressing a tag does
  // nothing, and the gap between those two facts is where the pointer actually
  // goes: the drawn bar is 14x5, so a user aims at 5px of height and at a column
  // 3px from a 17px scrollbar. These cases ask what a near miss lands on.
  const probe = async (dx, dy) =>
    await evalIn(
      cdp,
      `(() => {
        const el = document.querySelector('.mark')
        const r = el.getBoundingClientRect()
        const h = document.elementFromPoint(r.left + r.width / 2 + ${dx}, r.top + r.height / 2 + ${dy})
        if (!h) return 'nothing'
        if (h.closest && h.closest('.mark')) return 'mark'
        return String(h.className || h.tagName)
      })()`
    )
  const misses = {}
  for (const [name, dx, dy] of [
    ['right edge of the bar (+6px)', 6, 0],
    ['just right of the bar (+10px)', 10, 0],
    ['a row above (-9px)', 0, -9],
    ['a row below (+9px)', 0, 9],
    ['two rows below (+14px)', 0, 14]
  ])
    misses[name] = await probe(dx, dy)
  console.log(`  near misses: ${JSON.stringify(misses, null, 0)}`)

  // Every agent Robert actually runs turns mouse reporting on, which the probe's
  // shell does not - so the pane under test has been in a mode his never is.
  // `[char]27` rather than a literal ESC: the keystrokes go through xterm on the way
  // to the shell, and an ESC typed at a prompt is a keybinding, not a character.
  await type(cdp, '$e=[char]27; [Console]::Out.Write($e + "[?1000h" + $e + "[?1006h")')
  await enter(cdp)
  await sleep(2000)
  let termClass = await evalIn(
    cdp,
    "(document.querySelector('.xterm') || {}).className || '(no .xterm)'"
  )
  // If the probe's shell would not turn it on, put the pane in the state by hand.
  // What is being tested is whether the rail survives the mode's CSS, and that is
  // the class - a case that quietly skips is a pass that proves nothing, which is
  // the thing this whole file exists to stop.
  let forced = false
  if (!/enable-mouse-events/.test(String(termClass))) {
    forced = await evalIn(
      cdp,
      `(() => {
        const t = document.querySelector('.xterm')
        if (!t) return false
        t.classList.add('enable-mouse-events')
        return true
      })()`
    )
    termClass = await evalIn(cdp, "(document.querySelector('.xterm') || {}).className || ''")
  }
  console.log(`  terminal classes${forced ? ' (mode forced on)' : ''}: ${termClass}`)
  const reporting = /enable-mouse-events/.test(String(termClass))
  await evalIn(cdp, 'window.__spy = []')
  // The first press already put the pane on the oldest tag's line. Pressing the same
  // tag from there cannot move anything, so the case would read as a failure for the
  // wrong reason - back to the tail first.
  await evalIn(
    cdp,
    `(() => {
      const vp = document.querySelector('.xterm-viewport')
      if (!vp) return false
      vp.scrollTop = vp.scrollHeight
      vp.dispatchEvent(new Event('scroll', { bubbles: true }))
      return true
    })()`
  )
  await sleep(600)
  const beforeM = await evalIn(cdp, VIEW)
  const tagM = await evalIn(cdp, TAG_POINT)
  if (tagM) await pressAt(cdp, tagM.x, tagM.y)
  await sleep(700)
  const afterM = await evalIn(cdp, VIEW)
  const spyM = await evalIn(cdp, 'window.__spy')
  const movedM = beforeM && afterM && Math.abs(afterM.top - beforeM.top) > 20
  check(
    'a tag still works while the agent has mouse reporting on',
    reporting && Boolean(movedM),
    !reporting
      ? 'the pane could not be put into mouse-reporting mode at all - nothing was proved'
      : `reporting on${forced ? ' (forced)' : ''} · scrollTop ${beforeM?.top} -> ${afterM?.top} · events ${spyM.map((e) => `${e.type}->${e.target}`).join(', ') || 'none'}`
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
  await waitTestAppsGone(root)
  freshProfile()
  console.log(`== Launching the ${PROFILE} copy (${show ? 'visible' : 'minimized'}, on :${PORT})`)
  const electron = join(
    root,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  )
  const args = ['.', `--remote-debugging-port=${PORT}`]
  if (!show) args.splice(1, 0, '--minimized')
  const child = spawn(electron, args, {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PANEFORGE_PROFILE: PROFILE }
  })
  child.unref()

  let cdp
  let failed = false
  try {
    cdp = await connect()
    await cdp.send('Runtime.enable')
    await run(cdp)
  } catch (e) {
    failed = true
    console.error(`rail click probe failed: ${e?.message || e}`)
  } finally {
    try {
      cdp?.close()
    } catch {
      /* the copy is going away anyway */
    }
    closeTestApps(root)
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} rail click case(s) pass`)
  process.exit(failed || passed !== results.length ? 1 : 0)
}

main()
