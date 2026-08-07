// One Stash, wherever it is being read from.
//
// The Stash has two surfaces and one list: a panel inside the main window, which has a
// keyboard and therefore the search and the editor, and a floating overlay that has no
// keyboard at all and exists so a clip is reachable while PaneForge is behind a browser.
// They are meant to be alternatives. They were not:
//
//   the overlay's magnifier hands the search to the main window (`recents:openSearch`),
//   because `focusable: false` means it can never be typed into itself - and then stayed
//   expanded. It sits at the 'screen-saver' always-on-top level, one step above a normal
//   topmost window, so the list it was still showing covered the searchable one it had
//   just asked for. Two Stashes, the readable one underneath.
//
// So the rule is now stated in main and pinned here: while the main window is showing the
// Stash, the overlay is a pill. Nothing about it is visible in a screenshot of a passing
// build - the two windows only overlap when both are open - which is why it is a test.
//
// No real Electron: the overlay's window and the display it sits on are stubbed, so this
// runs under plain node in milliseconds.
//
//   node scripts/one-stash-test.mjs

import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'pf-one-stash-'))

let failed = 0
let checks = 0
function ok(what, cond, detail = '') {
  checks++
  if (cond) return
  failed++
  console.error(`FAIL ${what}${detail ? ` — ${detail}` : ''}`)
}

/**
 * A window that records what it was told, and a single 1920x1080 display for it to be
 * placed on. Everything the overlay asks of Electron is a setter or a send.
 */
function loadShelf() {
  const stub = join(work, `electron-${Math.random().toString(36).slice(2)}.cjs`)
  writeFileSync(
    stub,
    `const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                       workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
     // esbuild BUNDLES this stub into the overlay's own bundle, so a require() of the
     // stub file from the test is a second copy with its own arrays. The recording has
     // to live somewhere both halves can see.
     const sent = (globalThis.__pfSent ||= [])
     const bounds = (globalThis.__pfBounds ||= [])
     class BrowserWindow {
       constructor(opts) { this.opts = opts; this.b = { x: 0, y: 0, width: opts.width, height: opts.height }
         this.webContents = { isDestroyed: () => false, on: () => {},
                              send: (ch, ...a) => sent.push([ch, ...a]) } }
       isDestroyed() { return false }
       setBounds(b) { this.b = { ...this.b, ...b }; bounds.push({ ...this.b }) }
       getBounds() { return { ...this.b } }
       setAlwaysOnTop() {} showInactive() {} hide() {} show() {} close() {}
       setOpacity(v) { this.o = v } getOpacity() { return this.o ?? 1 }
       setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
       loadFile() {} loadURL() {} on() {} once() {} focus() {} blur() {}
       isVisible() { return true } setSkipTaskbar() {} moveTop() {}
     }
     module.exports = {
       app: { getPath: () => ${JSON.stringify(work)}, isPackaged: false, getVersion: () => '0.0.0',
              on: () => {}, whenReady: () => Promise.resolve() },
       BrowserWindow,
       screen: { getPrimaryDisplay: () => display, getDisplayMatching: () => display,
                 getDisplayNearestPoint: () => display, getAllDisplays: () => [display],
                 on: () => {}, removeListener: () => {} },
       nativeImage: { createFromPath: () => ({}) },
       clipboard: { readText: () => '', availableFormats: () => [] },
       ipcMain: { on: () => {}, handle: () => {} }
     }`
  )
  const out = join(work, `shelf-${Math.random().toString(36).slice(2)}.cjs`)
  buildSync({
    entryPoints: [join(root, 'src/main/shelfWindow.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { electron: stub },
    outfile: out
  })
  return require_(out)
}

const shelf = loadShelf()
const sent = (globalThis.__pfSent ||= [])
const bounds = (globalThis.__pfBounds ||= [])
shelf.openShelfWindow(() => null)
ok('the overlay window opened', shelf.shelfWindowOpen())

/** The last thing the overlay renderer was told about its own size. */
const expandedNow = () => {
  const said = sent.filter(([ch]) => ch === 'shelf:expanded')
  return said.length ? said[said.length - 1][1] : null
}
/** Height is the other half of the answer: the pill is 38px, the list is 470. */
const heightNow = () => bounds[bounds.length - 1]?.height ?? null

// --- the ordinary case, so the refusals below mean something --------------------------
shelf.setShelfExpanded(true)
ok('the overlay opens normally', expandedNow() === true)
ok('and grows to the list height', heightNow() === 470, `height ${heightNow()}`)

// --- handing the search over must put the overlay away --------------------------------
shelf.setStashInWindow(true)
ok('opening the window Stash collapses the overlay', expandedNow() === false)
ok('and it shrinks back to the pill', heightNow() === 38, `height ${heightNow()}`)

// --- and it may not come back while the window has it ---------------------------------
shelf.setShelfExpanded(true)
ok('the overlay refuses to expand while the window Stash is open', expandedNow() === false)
ok('its height did not change either', heightNow() === 38, `height ${heightNow()}`)
shelf.toggleShelf()
ok('the hotkey cannot open a second list either', expandedNow() === false)

// --- closing the window's Stash gives the overlay back --------------------------------
shelf.setStashInWindow(false)
ok('closing the window Stash does not open the overlay by itself', expandedNow() === false)
shelf.setShelfExpanded(true)
ok('but the overlay opens again once asked', expandedNow() === true)
ok('and is the list height again', heightNow() === 470, `height ${heightNow()}`)

// --- collapsing is never refused ------------------------------------------------------
// The guard is one-way on purpose. A rule that could refuse to CLOSE the overlay would be
// the same bug pointing the other way: two lists, with no way to put either down.
shelf.setStashInWindow(true)
shelf.setStashInWindow(false)
shelf.setShelfExpanded(true)
ok('reopened after a round trip', expandedNow() === true)
shelf.setStashInWindow(true)
ok('and the round trip did not leave the guard stuck open', expandedNow() === false)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `one stash: ${failed} of ${checks} FAILED` : `one stash: ${checks} checks passed`)
process.exit(failed ? 1 : 0)
