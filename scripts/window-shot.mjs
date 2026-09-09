#!/usr/bin/env node
// Screenshot ANY macOS window by owner name, even one hidden behind other apps.
// `screencapture -l <windowId>` reads the window's own layer off the window server,
// so nothing is raised, focused or moved (the "never take the screen" rule holds).
//   node scripts/window-shot.mjs [--owner PaneForge] [--out /tmp/x.png] [--list]
// Needs Screen Recording permission for the terminal/app hosting this process.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const owner = flag('--owner', 'PaneForge')
const out = flag('--out', `/tmp/${owner.toLowerCase()}-window.png`)
const list = args.includes('--list')

if (process.platform !== 'darwin') { console.error('window-shot: macOS only'); process.exit(2) }

const cache = join(homedir(), '.cache', 'paneforge')
const bin = join(cache, 'winlist')
const src = join(cache, 'winlist.swift')
const SWIFT = `import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let id = w[kCGWindowNumber as String] as! Int
  let name = w[kCGWindowName as String] as? String ?? ""
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let wd = b["Width"] as? Int ?? 0, ht = b["Height"] as? Int ?? 0
  print("\\(id)\\t\\(layer)\\t\\(wd)x\\(ht)\\t\\(owner)\\t\\(name)")
}
`
mkdirSync(cache, { recursive: true })
if (!existsSync(bin) || !existsSync(src)) {
  writeFileSync(src, SWIFT)
  execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' })
}
const rows = execFileSync(bin, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  .map(l => { const [id, layer, size, own, ...name] = l.split('\t'); return { id: +id, layer: +layer, size, owner: own, name: name.join('\t') } })
if (list) { for (const r of rows) console.log(`${r.id}\t${r.size}\t${r.owner}\t${r.name}`); process.exit(0) }

// Real app windows sit on layer 0; the biggest one is the main window.
const area = s => { const [w, h] = s.split('x').map(Number); return w * h }
const pick = rows.filter(r => r.owner === owner && r.layer === 0).sort((a, b) => area(b.size) - area(a.size))[0]
if (!pick) { console.error(`window-shot: no on-screen window owned by "${owner}" (try --list)`); process.exit(1) }
execFileSync('screencapture', ['-x', '-l', String(pick.id), out], { stdio: 'inherit' })
const bytes = statSync(out).size
if (bytes < 1000) { console.error(`window-shot: ${out} is ${bytes} bytes - Screen Recording permission missing?`); process.exit(1) }
console.log(`${out}\t${pick.owner} "${pick.name}" ${pick.size} id=${pick.id} ${bytes} bytes`)
