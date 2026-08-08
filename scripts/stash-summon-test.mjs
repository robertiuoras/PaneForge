// The Stash is summoned, and otherwise is not there.
//
// The report was "the Stash gets in the way whenever I copy things", and both halves of
// that are structural: a floating pill is over somebody's work by definition, and hover
// means the thing you did not ask for happens while you are reaching past it. So the
// default is now summon-only - nothing on screen, and the hotkey opens the list AT THE
// POINTER. Two things have to be true for that to be an improvement rather than a
// disappearing feature, and neither shows up in a screenshot:
//
//   1. closing really HIDES the window. Leaving it at pill size off in a corner is the old
//      behaviour with extra steps.
//   2. it opens where the pointer is, on the pointer's own display, and never half off the
//      edge - it is a window with no taskbar entry, so off-screen is lost for good.
//
// No real Electron: the window, the displays and the cursor are stubbed.
//
//   node scripts/stash-summon-test.mjs

import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(import.meta.url)

let failed = 0
let checks = 0
const ok = (what, cond, detail = '') => {
  checks++
  if (cond) return
  failed++
  console.error(`FAIL ${what}${detail ? ` — ${detail}` : ''}`)
}

/**
 * One overlay, with a cursor that can be moved and a second display to the right of the
 * first. `summon` writes the config the module reads on its own.
 */
function loadShelf(summon) {
  const work = mkdtempSync(join(tmpdir(), 'pf-summon-'))
  writeFileSync(join(work, 'config.json'), JSON.stringify({ stashSummon: summon }))
  const tag = Math.random().toString(36).slice(2)
  const stub = join(work, `electron-${tag}.cjs`)
  writeFileSync(
    stub,
    `const left = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
                    workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
     const right = { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 },
                     workArea: { x: 1920, y: 0, width: 1280, height: 1000 } }
     const state = (globalThis.__pfSummon = { sent: [], bounds: [], shown: 0, hidden: 0,
                                              cursor: { x: 600, y: 800 } })
     const on = (p) => (p.x >= 1920 ? right : left)
     class BrowserWindow {
       constructor(opts) { this.opts = opts
         this.b = { x: 0, y: 0, width: opts.width, height: opts.height }
         this.webContents = { isDestroyed: () => false, on: () => {},
                              send: (ch, ...a) => state.sent.push([ch, ...a]) } }
       isDestroyed() { return false }
       setBounds(b) { this.b = { ...this.b, ...b }; state.bounds.push({ ...this.b }) }
       getBounds() { return { ...this.b } }
       showInactive() { state.shown++ } hide() { state.hidden++ }
       setAlwaysOnTop() {} show() {} close() {}
       setOpacity(v) { this.o = v } getOpacity() { return this.o ?? 1 }
       setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
       loadFile() {} loadURL() {} on() {}
       once(ev, cb) { if (ev === 'ready-to-show') state.ready = cb } focus() {} blur() {}
       isVisible() { return true } setSkipTaskbar() {} moveTop() {}
     }
     module.exports = {
       app: { getPath: () => ${JSON.stringify(work)}, isPackaged: false, getVersion: () => '0.0.0',
              on: () => {}, whenReady: () => Promise.resolve() },
       BrowserWindow,
       screen: { getPrimaryDisplay: () => left, getDisplayMatching: () => left,
                 getDisplayNearestPoint: (p) => on(p), getAllDisplays: () => [left, right],
                 getCursorScreenPoint: () => ({ ...state.cursor }),
                 on: () => {}, removeListener: () => {} },
       nativeImage: { createFromPath: () => ({}) },
       clipboard: { readText: () => '', availableFormats: () => [] },
       ipcMain: { on: () => {}, handle: () => {} }
     }`
  )
  const out = join(work, `shelf-${tag}.cjs`)
  buildSync({
    entryPoints: [join(root, 'src/main/shelfWindow.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { electron: stub },
    outfile: out
  })
  const mod = require_(out)
  mod.openShelfWindow(() => null)
  // The real window shows itself from `ready-to-show`, and whether it does THAT is half
  // of what is being tested - so the stub records the handler and it is fired here.
  globalThis.__pfSummon.ready?.()
  return { mod, state: globalThis.__pfSummon }
}

// --- summoned ------------------------------------------------------------------------
{
  const { mod, state } = loadShelf(true)
  ok('the window is built but not shown', state.shown === 0, `shown ${state.shown}`)

  state.cursor = { x: 600, y: 800 }
  mod.setShelfExpanded(true)
  const at = state.bounds[state.bounds.length - 1]
  ok('asking for it shows it', state.shown === 1, `shown ${state.shown}`)
  ok('it is the list, not a pill', at.height === 470, `height ${at.height}`)
  // Beside the pointer and opening upward: x is 24px left of it, and the BOTTOM of the
  // window is 12px below it.
  ok('it opens beside the pointer', at.x === 600 - 24, `x ${at.x}`)
  ok('and upward from it', at.y + at.height === 800 + 12, `y ${at.y} h ${at.height}`)

  mod.setShelfExpanded(false)
  ok('closing hides it rather than parking a pill', state.hidden === 1, `hidden ${state.hidden}`)

  // Summoned again from the other monitor. The old behaviour anchored to the display the
  // MAIN window was on, which is the wrong screen the moment you are working on the other.
  state.cursor = { x: 2400, y: 500 }
  mod.setShelfExpanded(true)
  const far = state.bounds[state.bounds.length - 1]
  ok('a summon on the second display lands there', far.x >= 1920, `x ${far.x}`)
  ok('and still beside the pointer', far.x === 2400 - 24, `x ${far.x}`)

  // A window with no taskbar entry cannot be rescued from off-screen, so the clamp is
  // load-bearing rather than cosmetic.
  mod.setShelfExpanded(false)
  state.cursor = { x: 3190, y: 40 }
  mod.setShelfExpanded(true)
  const edge = state.bounds[state.bounds.length - 1]
  ok('a summon at the far corner stays on the display', edge.x + edge.width <= 1920 + 1280, `x ${edge.x}`)
  ok('and does not run off the top of it', edge.y >= 0, `y ${edge.y}`)

  // The pointer moving afterwards must not drag the open list around with it: the settings
  // panel makes the window taller, which re-places it.
  state.cursor = { x: 100, y: 100 }
  mod.setShelfTall(true)
  const tall = state.bounds[state.bounds.length - 1]
  ok('the open list does not chase the pointer', tall.x === edge.x, `x ${tall.x} was ${edge.x}`)
}

// --- switched off: the corner pill, exactly as before ---------------------------------
{
  const { mod, state } = loadShelf(false)
  ok('the pill is shown at startup', state.shown === 1, `shown ${state.shown}`)
  state.cursor = { x: 900, y: 200 }
  mod.setShelfExpanded(true)
  const at = state.bounds[state.bounds.length - 1]
  ok('it opens in the corner, not at the pointer', at.x === 12, `x ${at.x}`)
  mod.setShelfExpanded(false)
  ok('and closing leaves the pill on screen', state.hidden === 0, `hidden ${state.hidden}`)
  const pill = state.bounds[state.bounds.length - 1]
  ok('at pill size', pill.height === 38, `height ${pill.height}`)
}

console.log(failed ? `\n${failed} of ${checks} failed` : `stash summon: ${checks} checks passed`)
process.exit(failed ? 1 : 0)
