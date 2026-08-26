// Closing a card whose folder was deleted, and every case where it must not.
//
// Same shape as reclaim-test: this rule removes somebody's pane, so the REFUSALS are the
// file and the happy path is four lines. The case that started it: a scratch folder was
// deleted while a live session stood in it, and that session must survive - the shell
// recovers to $HOME by itself and the transcript is keyed by session id, not by path.
//
//   node scripts/cwd-gone-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-cwd-gone-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'cwdGone.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/cwdGone.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { reapForMissingCwd, nextCwdGone } = createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const NOW = 1_000_000_000
const MIN = 60_000
const GRACE = MIN
const reap = (o) => reapForMissingCwd({ status: 'exited', now: NOW, graceMs: GRACE, ...o })

{
  // The whole point: a dead pty in a folder that has been gone for longer than the
  // grace window. No process to return to, no directory to resume in.
  eq('exited + gone an hour reaps', reap({ cwdGone: NOW - 60 * MIN }), true)
}

{
  // The refusal this exists for. A LIVE pane keeps its card however missing the folder
  // is: `rm -rf` under a working session, a worktree another chat moved, `git clean`.
  for (const status of ['working', 'idle', 'starting'])
    eq(`${status} + gone an hour never reaps`, reap({ status, cwdGone: NOW - 60 * MIN }), false)
}

{
  // Inside the grace window, so a folder replaced in two steps (remove, recreate) is
  // never a reason on its own - the recreate lands first and clears the stamp below.
  eq('exited + gone 5s holds', reap({ cwdGone: NOW - 5000 }), false)
  eq('exited + gone exactly the grace holds', reap({ cwdGone: NOW - GRACE }), false)
  eq('exited + gone grace+1ms reaps', reap({ cwdGone: NOW - GRACE - 1 }), true)
}

{
  // A dead pane whose folder is fine is an ordinary finished card. Nothing here closes
  // it - that is the idle/reclaim path's decision and it has its own refusals.
  eq('exited, folder present, never reaps', reap({ cwdGone: undefined }), false)
}

{
  // The stamp. Only a CHANGE redraws, and coming back clears it outright, which is what
  // stops the two-step replacement above from ever accumulating grace.
  const first = nextCwdGone(true, undefined, NOW)
  eq('first sighting stamps now', first.value, NOW)
  eq('first sighting redraws', first.changed, true)
  const again = nextCwdGone(true, NOW, NOW + 5 * MIN)
  eq('still gone keeps the ORIGINAL stamp', again.value, NOW)
  eq('still gone does not redraw', again.changed, false)
  const back = nextCwdGone(false, NOW, NOW + 5 * MIN)
  eq('folder back clears the stamp', back.value, undefined)
  eq('folder back redraws', back.changed, true)
  eq('never gone, nothing to say', nextCwdGone(false, undefined, NOW).changed, false)
}

{
  // The two halves together: a folder that flickers can never reap, because the return
  // resets the clock the grace window is measured from.
  const gone = nextCwdGone(true, undefined, NOW).value
  const back = nextCwdGone(false, gone, NOW + 30_000).value
  const goneAgain = nextCwdGone(true, back, NOW + 31_000).value
  eq('re-gone stamps the SECOND disappearance', goneAgain, NOW + 31_000)
  eq(
    'and is inside the grace again',
    reapForMissingCwd({ status: 'exited', cwdGone: goneAgain, now: NOW + 60_000, graceMs: GRACE }),
    false
  )
}

rmSync(work, { recursive: true, force: true })
console.log(`cwd-gone: ${checks} checks passed`)
