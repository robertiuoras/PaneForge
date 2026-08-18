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
const launch = (extra, env) =>
  run('npm', ['run', 'try', '--', '--keep', `--remote-debugging-port=${port}`, ...extra], env)

/** Every pane's grid and its repair count, straight off the debug handle. */
function panes() {
  const expr =
    "(() => { const p = window.__pf || {}; return JSON.stringify(Object.keys(p).filter((k) => p[k] && p[k].term).map((id) => ({ cols: p[id].term.cols, rows: p[id].term.rows, proposed: p[id].fit.proposeDimensions(), fixes: p[id].restoreFixes ? p[id].restoreFixes() : null, lines: p[id].term.buffer.active.length }))) })()"
  const r = run('npm', ['run', 'probe', '--', expr], { PF_PORT: port })
  // The probe prints its answer as a JSON string literal, so the text comes back
  // double-encoded: one parse for the literal, one for the array inside it.
  const line = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"[')).pop()
  if (!line) throw new Error(`probe answered nothing usable:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(JSON.parse(line))
}

function fail(msg) {
  closeCopy()
  console.error(`FAIL ${msg}`)
  process.exit(1)
}

closeCopy()
await wait(3000)

// One real pane, in this repo - a folder the agent CLI is certainly allowed to open.
launch(['--open', root])
await wait(18_000)
const fresh = panes()
if (!fresh.length) fail('no pane started in the dev copy')
if (fresh[0].fixes === null) fail('the debug handle has no restoreFixes() - the counter was removed')
if (fresh[0].fixes !== 0) fail(`a brand new pane repaired itself ${fresh[0].fixes} time(s) - it has no history to be wrong about`)
console.log(`ok  a fresh pane repairs itself 0 times (${fresh[0].cols}x${fresh[0].rows})`)

// Closing writes the desk, which is what the next launch takes back.
closeCopy()
await wait(5000)
const desk = join(homedir(), 'Library', 'Application Support', 'claude-orchestrator-dev', 'desk.json')
const deskWin = join(process.env.APPDATA ?? '', 'claude-orchestrator-dev', 'desk.json')
const deskFile = existsSync(desk) ? desk : deskWin
if (!existsSync(deskFile)) fail('the dev copy left no desk.json, so there is nothing to restore')
const saved = JSON.parse(readFileSync(deskFile, 'utf8'))
if (!saved.specs?.[0]?.scrollbackId) fail('the desk carries no scrollbackId, so the restore replays nothing')

launch([], { PANEFORGE_RESTORE: 'always' })
await wait(22_000)
const back = panes()
if (!back.length) fail('nothing came back from the desk')
const p = back[0]
if (!p.fixes) fail('a restored pane did not repair itself - the frame it came back with is the one it keeps')
if (p.proposed && p.cols !== p.proposed.cols) fail(`restored pane is ${p.cols} columns wide in a ${p.proposed.cols} column box`)
if (p.lines < 24) fail(`the replayed history is gone (${p.lines} lines) - a repair may not cost the scrollback`)
console.log(`ok  a restored pane repaired itself ${p.fixes} time(s), ${p.cols}x${p.rows}, ${p.lines} lines of history kept`)
closeCopy()
console.log('restore-fix ok')
