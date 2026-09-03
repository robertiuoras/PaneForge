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
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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
const { placeNewPane, pinnedByPrompt, preferRemoteOf, PEER_FULL_PANES, REMOTE_START_ACK_MS } =
  require(out)

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

/** A shareable repo, a live peer with room, one pane here, a brief. Everything else varies. */
const at = (over) => ({
  shareable: true,
  prompt: 'add a unit test for the date parser and make it pass',
  cwd: '/Users/robert/Projects/taskdriver',
  peerAlive: true,
  peerBusyPanes: 0,
  pressure: 'normal',
  mode: 'auto',
  ...over
})

// --- the refusals, which come first ------------------------------------------------------

is(placeNewPane(at({ mode: 'never' })).where, 'local', 'never keeps every pane here')
is(
  placeNewPane(at({ mode: 'never', pressure: 'critical' })).where,
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

// --- the person's own pane ---------------------------------------------------------------
//
// 2026-09-02: Robert pressed + on the Mac with two panes running and the pane opened on
// the PC. A pane with no brief is somebody about to type into it, and it stays under
// their hands whatever the desk says and whatever the switch says.

is(placeNewPane(at({ prompt: undefined, pressure: 'critical' })).where, 'local', 'a bare + stays here')
is(placeNewPane(at({ prompt: '   ', pressure: 'critical' })).where, 'local', '...blank is bare')
is(placeNewPane(at({ prompt: undefined, mode: 'always' })).where, 'local', '...even set to always')
is(
  placeNewPane(at({ prompt: undefined, pressure: 'critical', mode: 'always' })).where,
  'local',
  '...even out of memory, set to always'
)
ok(/yourself/.test(placeNewPane(at({ prompt: undefined })).reason), '...and says whose pane it is')
is(placeNewPane(at({ pressure: 'critical' })).where, 'remote', 'the same desk with a brief still sends it')

is(
  placeNewPane(at({ resumes: true, pressure: 'critical' })).where,
  'local',
  'a resumed conversation stays with its transcript'
)
is(placeNewPane(at({ resumes: true, mode: 'always' })).where, 'local', '...even set to always')

is(
  placeNewPane(at({ devServer: 'dev', pressure: 'critical' })).where,
  'local',
  'a project already serving from here stays here'
)
ok(placeNewPane(at({ devServer: 'dev' })).reason.includes('dev'), '...and names the server')

// --- a brief about things the other machine does not have ---------------------------------

const cwd = '/Users/robert/Projects/taskdriver'
const pinned = (p) => pinnedByPrompt(p, cwd)
ok(pinned('look at /Users/robert/Downloads/spec.pdf and build it'), 'a file in Downloads pins')
ok(pinned('read ~/Desktop/notes.md first'), 'a tilde path pins')
ok(pinned('open C:\\Users\\Gamer\\brief.txt'), 'a Windows home path pins')
ok(pinned('check /Volumes/Data/export.csv'), 'a volume pins')
is(pinned('fix /Users/robert/Projects/taskdriver/src/app.ts'), undefined, 'a path INSIDE the project travels')
is(pinned('fix /users/ROBERT/projects/taskdriver/src/app.ts'), undefined, '...whatever its case')
ok(pinned('the page on localhost:3006 is blank'), 'localhost pins')
ok(pinned('hit http://127.0.0.1:3000/api'), 'a loopback address pins')
ok(pinned('the dev server keeps crashing'), 'a dev server pins')
ok(pinned('run npm run dev and check the console'), 'npm run dev pins')
ok(pinned('take a screenshot of the settings page'), 'a screenshot pins')
ok(pinned('drive chrome through cdp and click the button'), 'a browser pins')
ok(pinned('do this on my mac please'), 'naming this machine pins')
ok(pinned('run it locally'), 'locally pins')
ok(pinned('fix it here'), 'here pins')
is(pinned('add a unit test for the date parser'), undefined, 'plain work travels')
is(pinned('refactor the auth middleware and update the README'), undefined, '...and so does this')
is(pinned('write a migration for the users table'), undefined, '...and this')
is(pinned(''), undefined, 'an empty brief pins nothing - the bare rule owns it')
is(pinned(undefined), undefined, '...and so does undefined')
is(
  placeNewPane(at({ prompt: 'compare with ~/Desktop/old.png', pressure: 'critical' })).where,
  'local',
  'a pinned brief stays here'
)
ok(
  placeNewPane(at({ prompt: 'compare with ~/Desktop/old.png' })).reason.includes('Desktop/old.png'),
  '...and the reason names the file'
)
is(
  placeNewPane(at({ prompt: 'the page on localhost:3006 is blank', mode: 'always' })).where,
  'local',
  '...even set to always'
)

// The control: an unmeasured folder is a folder nobody has asked about, and guessing
// remote opens a pane in a directory the other machine does not have.
is(
  placeNewPane(at({ shareable: undefined, pressure: 'critical' })).where,
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

is(placeNewPane(at({ peerAlive: false, pressure: 'critical' })).where, 'local', 'no live peer, no move')
is(placeNewPane(at({ peerAlive: false, mode: 'always' })).where, 'local', '...even set to always')

is(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES, pressure: 'critical' })).where,
  'local',
  'a peer already full is not a destination'
)
is(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES - 1, pressure: 'critical' })).where,
  'remote',
  '...and one pane under it still is'
)
ok(
  placeNewPane(at({ peerBusyPanes: PEER_FULL_PANES, pressure: 'critical' })).reason.includes(String(PEER_FULL_PANES)),
  '...and the refusal carries the count'
)

// --- auto: what the desk says ------------------------------------------------------------

is(placeNewPane(at({ pressure: 'normal' })).where, 'local', 'a desk with room keeps its new pane')
is(placeNewPane(at({ pressure: undefined })).where, 'local', '...and an unmeasured desk is a desk with room')
is(placeNewPane(at({ pressure: 'warn' })).where, 'remote', 'a desk the kernel is warning about sends it')
is(placeNewPane(at({ pressure: 'critical' })).where, 'remote', '...and a struggling one does')
ok(/memory|lagging/.test(placeNewPane(at({ pressure: 'warn' })).reason), '...and says which reading')
// The 2026-09-02 rule, pinned dead: a MacBook that is the desk has many panes and is on
// battery all day, and neither is a measurement of anything.
is(placeNewPane(at({ pressure: 'normal', localPanes: 9 })).where, 'local', 'nine panes with room is not a reason')
is(placeNewPane(at({ pressure: 'normal', onBattery: true })).where, 'local', 'battery is not a reason')

// --- the person's own pick ---------------------------------------------------------------

is(placeNewPane(at({ where: 'local', mode: 'always', pressure: 'critical' })).where, 'local', 'picked this machine: final')
is(placeNewPane(at({ where: 'remote', prompt: undefined })).where, 'remote', 'picked the other machine: a bare pane still goes')
is(placeNewPane(at({ where: 'remote', mode: 'never' })).where, 'remote', '...over the never switch')
is(placeNewPane(at({ where: 'remote', keepHere: true })).where, 'remote', '...over a kept project')
is(placeNewPane(at({ where: 'remote', resumes: true })).where, 'remote', '...over a resume')
is(placeNewPane(at({ where: 'remote', shareable: false })).where, 'local', 'but not onto a machine without the folder')
is(placeNewPane(at({ where: 'remote', peerAlive: false })).where, 'local', '...nor one that is offline')
is(placeNewPane(at({ where: 'remote', peerBusyPanes: PEER_FULL_PANES })).where, 'local', '...nor one that is full')
ok(/chose/.test(placeNewPane(at({ where: 'remote' })).reason), '...and the reason says who chose')
ok(/chose/.test(placeNewPane(at({ where: 'local' })).reason), '...both ways')

// --- always ------------------------------------------------------------------------------

is(placeNewPane(at({ pressure: 'normal', mode: 'always' })).where, 'remote', 'always sends it with room to spare')

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
  at({ pressure: 'warn' }),
  at({ pressure: 'critical' }),
  at({ peerBusyPanes: 99 }),
  at({ prompt: undefined }),
  at({ resumes: true }),
  at({ devServer: 'dev' }),
  at({ prompt: 'look at ~/Downloads/x.pdf' }),
  at({ prompt: 'localhost:3000 is down' }),
  at({ where: 'local' }),
  at({ where: 'remote' })
]
for (const c of cases) {
  const p = placeNewPane(c)
  ok(p.reason.length > 8, `every answer carries a reason (${JSON.stringify(c.mode)})`)
  ok(!/\b(lane|worktree|trunk|checkout|origin|repo|commit)\b/i.test(p.reason), `plain words: "${p.reason}"`)
}

// --- the switch read off disk, where it may be anything ---------------------------------

is(preferRemoteOf(undefined), 'auto', 'no config at all is auto')
is(preferRemoteOf({}), 'auto', 'an unset switch is auto')
is(preferRemoteOf({ preferRemote: 'always' }), 'always', 'always is read')
is(preferRemoteOf({ preferRemote: 'never' }), 'never', 'never is read')
// The control: a boolean written by hand where a string was expected must not become the
// loudest answer - see `offloadMinutes` in autoHandoff.ts for the same trap.
is(preferRemoteOf({ preferRemote: true }), 'auto', 'a hand-written true is auto, not always')
is(preferRemoteOf({ preferRemote: 'remote' }), 'auto', 'a word nobody defined is auto')

ok(REMOTE_START_ACK_MS >= 1000, 'the far end gets a real window to answer in')

// SOURCE: the app never asks where a pane runs.
//
// 2026-09-03: `offloadAsk` was a config key and a dialog on the pressure path
// (`App.tsx`'s `offloadReqs`, unrelated to this file) that put "start it here or on the
// paired device?" on screen. Removed - a card nobody presses is a decision nobody made,
// and where a pane runs is `offloadFirst.ts`'s call alone. Pinned as a grep over the built
// source rather than only this file's own decision function, because the whole point is
// that NOTHING in the app asks any more, not just this one.
for (const rel of ['src/renderer/src/App.tsx', 'src/shared/capacity.ts', 'src/main/config.ts', 'src/shared/types.ts']) {
  const src = readFileSync(join(root, rel), 'utf8')
  ok(!/offloadAsk/.test(src), `${rel} carries no offloadAsk`)
}

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`offloadfirst: ${failed} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`offloadfirst: ${checks} checks passed`)
