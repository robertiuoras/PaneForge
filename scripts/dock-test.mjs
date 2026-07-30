// The app must keep its macOS Dock icon.
//
// PaneForge had no Dock icon on macOS at all - it could not be clicked, Cmd-Tabbed to, or
// right-clicked and kept in the Dock. Nothing in the source hid it. The cause was the
// clipboard overlay asking to float over fullscreen apps: Electron implements that on
// macOS by transforming the whole process to an accessory (`TransformProcessType`,
// the call behind `app.dock.hide()`), and never transforms it back.
//
// Two things are pinned here, because either one alone would let it come back:
//
//  1. no call site in src/ asks for `visibleOnFullScreen` without opting out of that
//     transform - a new window copied from the old one is the likely way it returns;
//  2. Electron still behaves the way the fix assumes. This half runs a real Electron and
//     only on darwin, since there is no such transform anywhere else. An Electron upgrade
//     that fixed the transform (or broke the opt-out) shows up here rather than in a
//     screenshot of a missing Dock icon.

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
  if (!ok) failed++
}

// --- 1. every call site opts out of the process-type transform -------------------------

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const offenders = []
for (const file of walk(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  // The options object is written on one line at every call site; read a generous window
  // after the call anyway, so a wrapped one is still judged on its own options.
  const re = /setVisibleOnAllWorkspaces\s*\(([\s\S]{0,240}?)\)\s*(?:$|[;\n])/gm
  for (const m of text.matchAll(re)) {
    if (!/visibleOnFullScreen\s*:\s*true/.test(m[1])) continue
    if (/skipTransformProcessType/.test(m[1])) continue
    const line = text.slice(0, m.index).split('\n').length
    offenders.push(`${file.slice(root.length + 1)}:${line}`)
  }
}
check(
  'no visibleOnFullScreen without skipTransformProcessType',
  offenders.length === 0,
  offenders.length ? `these hide the Dock icon for the whole app: ${offenders.join(', ')}` : ''
)

// --- 2. Electron still hides the Dock for the transform, and still honours the opt-out ---

if (process.platform !== 'darwin') {
  console.log('skip  Electron dock behaviour (darwin only)')
} else {
  const probe = join(tmpdir(), `pf-dock-probe-${process.pid}.js`)
  writeFileSync(
    probe,
    `const { app, BrowserWindow } = require('electron')
const skip = process.argv[2] === 'skip'
app.whenReady().then(() => {
  new BrowserWindow({ width: 300, height: 200, show: false })
  const w = new BrowserWindow({ width: 200, height: 100, show: false, frame: false, focusable: false, skipTaskbar: true })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: skip })
  w.showInactive()
  setTimeout(() => { console.log('DOCK=' + app.dock.isVisible()); app.exit(0) }, 800)
})
`
  )
  const electron = join(root, 'node_modules', '.bin', 'electron')
  const run = (arg) => {
    const r = spawnSync(electron, [probe, arg], { encoding: 'utf8', timeout: 60_000 })
    return /DOCK=true/.test(r.stdout ?? '')
  }
  try {
    check('the transform still hides the Dock (the bug this guards)', run('transform') === false)
    check('skipTransformProcessType still keeps the Dock icon', run('skip') === true)
  } finally {
    rmSync(probe, { force: true })
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\ndock: all checks passed')
