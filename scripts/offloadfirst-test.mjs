// Where a new pane starts, before it has anything to lose.
//
// This decision runs on EVERY launch, so the expensive mistake is not "a pane that should
// have gone remote stayed here" - that is the behaviour the app had all along. It is a
// pane opening on a machine where its folder does not exist, and every one of those comes
// from treating an unmeasured reading as a yes. So the control cases here are the silent
// ones: `shareable: undefined`, a peer nobody probed, `always` set on a folder that is not
// a repo. Each of them must stay on this desk, and must say WHY - the reason string is the
// whole audit trail once a pane has appeared somewhere unexpected.
//
//   node scripts/offloadfirst-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-offloadfirst-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'offloadfirst.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/offloadFirst.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { placeNewPane, REMOTE_FROM_PANES, PEER_FULL_PANES, REMOTE_START_ACK_MS } = require(out)

let checks = 0
let failed = 0
const is = (actual, expected, what) => {
  checks++
  if (actual !== expected) {
    failed++
    console.error(`  FAIL ${what}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const ok = (cond, what) => is(!!cond, true, what)

/** A shareable repo, a live peer with room, one pane here. Everything else varies. */
const at = (over) => ({
  shareable: true,
  peerAlive: true,
  peerBusyPanes: 0,
  localPanes: 1,
  mode: 'auto',
  ...over
})

// --- the refusals, which come first ------------------------------------------------------

is(placeNewPane(at({ mode: 'never' })).where, 'local', 'never keeps every pane here')
is(
  placeNewPane(at({ mode: 'never', localPanes: 9, onBattery: true })).where,
  'local',
  '...whatever the desk says'
)
is(placeNewPane(at({ keepHere: true, mode: 'always' })).where, 'local', 'a kept project never leaves')
is(
  placeNewPane(at({ machineBound: 'Chrome', mode: 'always' })).where,
  'local',
  'work driving a browser on this screen never leaves'
)
ok(
  placeNewPane(at({ machineBound: 'Chrome' })).reason.includes('Chrome'),
  '...and the refusal names what pinned it'
)

// The control: an unmeasured folder is a folder nobody has asked about, and guessing
// remote opens a pane in a directory the other machine does not have.
is(
  placeNewPane(at({ shareable: undefined, localPanes: 9 })).where,
  'local',
  'an unmeasured folder stays here'
)
is(
  placeNewPane(at({ shareable: undefined, mode: 'always' })).where,
  'local',
  '...even set to always'
)
ok(
  placeNewPane(at({ shareable: undefined })).reason !== placeNewPane(at({ shareable: false })).reason,
  'unmeasured and unshareable are different sentences'
)
is(placeNewPane(at({ shareable: false, mode: 'always' })).where, 'local', 'a folder with nowhere to push stays here')

is(placeNewPane(at({ peerAlive: false, localPanes: 9 })).where, 'local', 'no live peer, no move')
is(placeNewPane(at({ peerAlive: false, mode: 'always' })).where, 'local', '...even set to always')

is(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES, localPanes: 9 })).where,
  'local',
  'a peer already full is not a destination'
)
is(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES - 1, localPanes: 9 })).where,
  'remote',
  '...and one pane under it still is'
)
ok(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES, localPanes: 9 })).reason.includes(String(PEER_FULL_PANES)),
  '...and the refusal carries the count'
)

// --- auto: what the desk says ------------------------------------------------------------

is(placeNewPane(at({ localPanes: 0 })).where, 'local', 'the first pane of the day opens here')
is(placeNewPane(at({ localPanes: REMOTE_FROM_PANES - 1 })).where, 'local', '...and so does the second')
is(placeNewPane(at({ localPanes: REMOTE_FROM_PANES })).where, 'remote', 'past the budget, new work goes over')
ok(
  placeNewPane(at({ localPanes: REMOTE_FROM_PANES })).reason.includes(String(REMOTE_FROM_PANES)),
  '...and says how many are running here'
)

is(
  placeNewPane(at({ localPanes: 0, onBattery: true })).where,
  'remote',
  'on battery the count does not matter'
)
ok(
  placeNewPane(at({ localPanes: 0, onBattery: true })).reason.includes('battery'),
  '...and it says so'
)

// --- always ------------------------------------------------------------------------------

is(placeNewPane(at({ localPanes: 0, mode: 'always' })).where, 'remote', 'always sends the first pane too')

// --- every answer explains itself --------------------------------------------------------

const cases = [
  at({}),
  at({ mode: 'never' }),
  at({ mode: 'always' }),
  at({ shareable: undefined }),
  at({ shareable: false }),
  at({ peerAlive: false }),
  at({ keepHere: true }),
  at({ machineBound: 'Chrome' }),
  at({ localPanes: 9 }),
  at({ onBattery: true }),
  at({ peerBusyPanes: 99 })
]
for (const c of cases) {
  const p = placeNewPane(c)
  ok(p.reason.length > 8, `every answer carries a reason (${JSON.stringify(c.mode)})`)
  ok(!/\b(lane|worktree|trunk|checkout|origin|repo|commit)\b/i.test(p.reason), `plain words: "${p.reason}"`)
}

ok(REMOTE_START_ACK_MS >= 1000, 'the far end gets a real window to answer in')

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`offloadfirst: ${failed} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`offloadfirst: ${checks} checks passed`)
