import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const req = createRequire(import.meta.url)
const out = join(tmpdir(), 'pf-walkup.cjs')
buildSync({ absWorkingDir: '/Users/robertiuoras/Projects/PaneForge', entryPoints: ['src/shared/keepScrollback.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const { keepScrollback } = req(out)
let wipes = 0
const k = keepScrollback(() => 32, () => false, Date.now, () => 32, () => { wipes++ })
// The 2.1.241 shape, with NO home anywhere: cursor walked to the bottom, then erase-per-row upward.
k('\x1b[8D\x1b[30B' + '\x1b[2K\x1b[1A'.repeat(32) + '\x1b[G\x1b[1A\x1b[11A')
console.log('walk-up wipes reported:', wipes)
let quiet = 0
const k2 = keepScrollback(() => 32, () => false, Date.now, () => 32, () => { quiet++ })
// Control: a composer redraw - one row erased, something written, one row erased.
k2('\x1b[2K\x1b[1Ahello\x1b[2K\x1b[1Aworld\x1b[2K')
console.log('composer redraw wipes reported (want 0):', quiet)
