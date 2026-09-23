// "See the PC's screen": the button starts Moonlight at the peer PaneForge already knows,
// and is not drawn at all when there is no viewer or no peer to look at.
//
//   node scripts/screen-view-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-screen-view-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'screenView.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/screenView.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const { SCREEN_APP, moonlightCandidates, screenPeer, screenPlan, screenTitle } = createRequire(import.meta.url)(outfile)

const pc = { name: 'Gamer', address: '100.78.1.77', status: 'online' }
const laptop = { name: 'Old laptop', address: '100.78.1.9', status: 'off' }
const viewer = '/Applications/Moonlight.app/Contents/MacOS/Moonlight'

// The command is the shape `Moonlight stream --help` prints: stream <host> "<app>".
const plan = screenPlan(viewer, [laptop, pc])
assert.equal(plan.ok, true)
assert.deepEqual(plan.args, ['stream', '100.78.1.77', 'Desktop'])
assert.equal(SCREEN_APP, 'Desktop')
assert.equal(plan.peer.name, 'Gamer', 'the online peer wins over an earlier offline one')

// One paired machine that is off right now is still the one to look at: Moonlight's own
// error names the problem better than a missing button would.
assert.equal(screenPeer([laptop]).name, 'Old laptop')

// Refusals say why, in words a person can act on.
const noViewer = screenPlan(null, [pc])
assert.equal(noViewer.ok, false)
assert.equal(noViewer.reason, 'no-viewer')
assert.match(noViewer.message, /Moonlight/)
const noPeer = screenPlan(viewer, [])
assert.equal(noPeer.ok, false)
assert.equal(noPeer.reason, 'no-peer')
assert.match(noPeer.message, /paired/)

// The title names the machine, never the protocol.
assert.equal(screenTitle([pc]), "See Gamer's screen (opens Moonlight)")
assert.doesNotMatch(screenTitle([]), /Sunshine|stream|peer/i)

// Where Moonlight is looked for, per platform. Windows without LOCALAPPDATA is not a crash.
assert.deepEqual(moonlightCandidates('darwin', {}), [viewer])
assert.deepEqual(moonlightCandidates('win32', {}), [])
assert.equal(moonlightCandidates('win32', { LOCALAPPDATA: 'C:\\U\\g\\AppData\\Local' })[0],
  'C:\\U\\g\\AppData\\Local\\Programs\\Moonlight Game Streaming Project\\Moonlight.exe')
assert.equal(moonlightCandidates('linux', {}).length, 2)

rmSync(work, { recursive: true, force: true })
console.log('screen-view: ok (7 checks)')
