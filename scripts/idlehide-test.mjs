// npm run test:idlehide
//
// The PC's window puts itself away when its desk is empty and nobody is using it, and the
// app keeps running. Every refusal here fails its own assert if it is dropped.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-idlehide-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'idlehide.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/idleHide.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const { idleHideVerdict, idleHideReveal, livePanes, IDLE_HIDE_MS } = createRequire(import.meta.url)(outfile)

const NOW = 1_000_000_000
const MIN = 60_000
const input = (over = {}) => ({ live: 0, watching: 0, visible: true, lastActivity: NOW - 4 * MIN, now: NOW, ...over })

assert.equal(IDLE_HIDE_MS, 3 * MIN, 'Robert asked for three minutes')
assert.equal(idleHideVerdict(input()).hide, true, 'an empty desk quiet for 4 min hides')
assert.equal(idleHideVerdict(input({ lastActivity: NOW - 2 * MIN })).hide, false, 'used 2 min ago stays')
assert.equal(idleHideVerdict(input({ lastActivity: NOW - 3 * MIN })).hide, true, 'exactly three minutes hides')
assert.equal(idleHideVerdict(input({ live: 1 })).hide, false, 'a live pane keeps the window')
assert.equal(idleHideVerdict(input({ watching: 1 })).hide, false, 'a watched screen keeps the window')
assert.equal(idleHideVerdict(input({ visible: false })).hide, false, 'a hidden window is not hidden twice')
assert.equal(idleHideVerdict(input({ lastActivity: NOW - 20_000, waitMs: 10_000 })).hide, true, 'a test copy wait is honoured')

// Which panes count. A finished run does not; a sleeping pane someone is keeping does.
assert.equal(livePanes([{ status: 'exited' }]), 0, 'an ended pane does not hold the window')
assert.equal(livePanes([{ status: 'exited', asleep: NOW }]), 1, 'a sleeping pane does')
assert.equal(livePanes([{ status: 'running' }, { status: 'waiting' }, { status: 'exited' }]), 2)

assert.equal(idleHideReveal(true, 1), true, 'a pane arriving brings the hidden window back')
assert.equal(idleHideReveal(true, 0), false, 'nothing to show for')
assert.equal(idleHideReveal(false, 1), false, 'a window the person hid is left alone')

console.log('idlehide: all good')
