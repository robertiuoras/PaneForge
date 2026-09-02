// A restored pane repairs itself, and an ordinary new one does not.
//
// The bug: a restored pane is seeded with the tail of what the OLD pty printed, and the
// CLI hard-wrapped those lines at the width it had then - into a terminal xterm opens at
// 80x24 and fits a frame or two later. The frame that lands is soup, which is "after the
// update restart it looks broken, Fix fixes it". The app restarts itself for every
// update, so that is the launch most panes on a desk get.
//
// This needs a window, so it is not in `npm test`. Two launches of the dev copy: one to
// make a pane and leave a desk behind, one to take that desk back with
// PANEFORGE_RESTORE=always. The CONTROL half is load-bearing - a fresh pane must record
// zero repairs, or "it repaired itself" is indistinguishable from "it repairs everything".
//
//   npm run test:restorefix

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.PF_PORT ?? '9334'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function run(cmd, args, env) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
}

const closeCopy = () => run('npm', ['run', 'try', '--', '--close'])
const launchOnce = (extra, env) =>
  run('npm', ['run', 'try', '--', '--keep', `--remote-debugging-port=${port}`, ...extra], env)

/**
 * Launch the dev copy and wait until it is actually answering, rather than sleeping a
 * number and hoping. A copy started while the previous one is still shutting down loses
 * the single-instance race and quits, which used to fail this suite as "the probe
 * answered nothing" a minute later - the wrong sentence about the wrong thing.
 */
async function launch(extra, env) {
  for (let i = 0; i < 3; i++) {
    launchOnce(extra, env)
    for (let t = 0; t < 12; t++) {
      await wait(5000)
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        if (list.some((pg) => (pg.url ?? '').includes('/out/renderer/'))) return
      } catch {
        /* not up yet */
      }
    }
  }
  throw new Error('the dev copy never came up')
}

/** Every pane's grid, its repair count, and whether one is still owed. */
function panes() {
  // `asleep` is joined in from main's own list: a pane with no process cannot be
  // repaired, and telling "it repaired itself" from "it has nothing to repair yet"
  // is the whole of the second half of this test.
  const expr =
    "(async () => { const p = window.__pf || {}; const live = await window.api.listSessions(); const nap = {}; for (const s of live) nap[s.id] = Boolean(s.asleep); return JSON.stringify(Object.keys(p).filter((k) => p[k] && p[k].term).map((id) => ({ cols: p[id].term.cols, rows: p[id].term.rows, proposed: p[id].fit.proposeDimensions(), fixes: p[id].restoreFixes ? p[id].restoreFixes() : null, pending: p[id].restorePending ? p[id].restorePending() : null, lag: p[id].restoreFixLag ? p[id].restoreFixLag() : null, asleep: nap[id] ?? null, lines: p[id].term.buffer.active.length }))) })()"
  // A window still coming up answers nothing at all, and this suite launches the copy
  // three times - so the probe is asked again rather than failing the run on a race.
  let last = ''
  for (let i = 0; i < 10; i++) {
    const r = run('npm', ['run', 'probe', '--', expr], { PF_PORT: port })
    // The probe prints its answer as a JSON string literal, so the text comes back
    // double-encoded: one parse for the literal, one for the array inside it.
    const line = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"[')).pop()
    if (line) return JSON.parse(JSON.parse(line))
    last = `${r.stdout}\n${r.stderr}`
    spawnSync('sleep', ['5'])
  }
  throw new Error(`probe answered nothing usable:\n${last}`)
}

function fail(msg) {
  closeCopy()
  console.error(`FAIL ${msg}`)
  process.exit(1)
}

closeCopy()
await wait(8000)

// One real pane, in this repo - a folder the agent CLI is certainly allowed to open.
await launch(['--open', root])
await wait(18_000)
const fresh = panes()
if (!fresh.length) fail('no pane started in the dev copy')
if (fresh[0].fixes === null) fail('the debug handle has no restoreFixes() - the counter was removed')
if (fresh[0].fixes !== 0) fail(`a brand new pane repaired itself ${fresh[0].fixes} time(s) - it has no history to be wrong about`)
console.log(`ok  a fresh pane repairs itself 0 times (${fresh[0].cols}x${fresh[0].rows})`)

// Closing writes the desk, which is what the next launch takes back.
closeCopy()
await wait(8000)
const desk = join(homedir(), 'Library', 'Application Support', 'claude-orchestrator-dev', 'desk.json')
const deskWin = join(process.env.APPDATA ?? '', 'claude-orchestrator-dev', 'desk.json')
const deskFile = existsSync(desk) ? desk : deskWin
if (!existsSync(deskFile)) fail('the dev copy left no desk.json, so there is nothing to restore')
const saved = JSON.parse(readFileSync(deskFile, 'utf8'))
if (!saved.specs?.[0]?.scrollbackId) fail('the desk carries no scrollbackId, so the restore replays nothing')

await launch([], { PANEFORGE_RESTORE: 'always' })
await wait(22_000)
const back = panes()
if (!back.length) fail('nothing came back from the desk')
const p = back[0]
if (!p.fixes) fail('a restored pane did not repair itself - the frame it came back with is the one it keeps')
if (p.proposed && p.cols !== p.proposed.cols) fail(`restored pane is ${p.cols} columns wide in a ${p.proposed.cols} column box`)
if (p.lines < 24) fail(`the replayed history is gone (${p.lines} lines) - a repair may not cost the scrollback`)
console.log(`ok  a restored pane repaired itself ${p.fixes} time(s), ${p.cols}x${p.rows}, ${p.lines} lines of history kept`)

// ...and the desk a real restore comes back to: several panes, most of them ASLEEP.
//
// `restoreAsleep` brings most of a restored desk back with no process at all, and the
// repair is a message to that pane's CLI - so spending it on a sleeping pane repairs
// nothing and leaves the flag gone, which is "after the update restart it is still
// broken until I press Fix". Measured on this desk 2026-09-02, three restored panes with
// every pane on screen: BEFORE, all three counted a repair, two of them asleep with
// nothing to repaint. The repair is now owed until the pane wakes and prints.
function evaluate(expr) {
  return run('npm', ['run', 'probe', '--', expr], { PF_PORT: port })
}
evaluate(`(async () => { await window.api.setConfig({ grid: true }); await window.api.startSession({ cwd: ${JSON.stringify(root)} }); await window.api.startSession({ cwd: ${JSON.stringify(root)} }); return JSON.stringify('ok') })()`)
await wait(20_000)
closeCopy()
await wait(8000)
await launch([], { PANEFORGE_RESTORE: 'always' })
await wait(30_000)
const deskBack = panes()
if (deskBack.length < 2) fail(`the restored desk came back with ${deskBack.length} pane(s) - this half needs several`)
if (deskBack.some((x) => x.pending === null)) fail('the debug handle has no restorePending() - the counter was removed')
const napping = deskBack.filter((x) => x.asleep)
if (!napping.length) fail('no pane came back asleep, so the case this half is about never happened')
for (const x of napping) {
  if (x.fixes) fail(`a sleeping pane counted ${x.fixes} repair(s) - it has no process to repaint, so that repair went nowhere`)
  if (!x.pending) fail('a sleeping pane dropped its pending repair - waking it later will not repair it')
  if (x.proposed && x.cols !== x.proposed.cols) fail(`a sleeping pane is ${x.cols} columns wide in a ${x.proposed.cols} column box`)
}
console.log(`ok  ${napping.length} sleeping pane(s) still owe their repair, ${deskBack.length - napping.length} awake one(s) took it`)
closeCopy()
console.log('restore-fix ok')
