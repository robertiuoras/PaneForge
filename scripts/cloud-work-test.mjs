// A pane holding work that is not running on this machine.
//
// Reported 2026-09-04: a pane with a `/code-review ultra` still running in the cloud was
// counting down to an idle close, because every "is anything still going on in here"
// reading this app has is a reading of the local process table and a cloud session is not
// in it. The load-bearing halves of this test are the two CONTROLS: an ordinary finished
// Claude Code footer must still read as nothing (or the idle clock is off for everyone),
// and a hold must EXPIRE (or the pane can never be closed again).
//
//   node scripts/cloud-work-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-cloud-work-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'cloud.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/cloudWork.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { readsCloudWork, cloudHeld, CLOUD_HOLD_MS } = createRequire(import.meta.url)(out)

let bad = 0
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return console.log(`ok   ${name}`)
  bad++
  console.error(`FAIL ${name}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}

// ------------------------------------------------------------------ the real frame
//
// Verbatim, from the pane that reported this - the footer Claude Code draws when a turn
// ends with a cloud agent still working.
const real = [
  '⏺ Ultrareview running in cloud. Findings arrive by notification.',
  '',
  '✻ Cogitated for 2s · done 3:37 PM · ◇ 1 cloud session still running',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ >                                            │',
  '╰──────────────────────────────────────────────╯'
].join('\n')
check('the reported frame', readsCloudWork(real), '1 cloud session')
check('plural', readsCloudWork('· ◇ 3 cloud sessions still running'), '3 cloud sessions')
check('without "still"', readsCloudWork('◇ 2 cloud sessions running'), '2 cloud sessions')

// ------------------------------------------------------------------ controls
//
// An ordinary finished turn. If this ever reads as cloud work, every pane on the desk
// stops being closeable and the idle clock is off - which is a far worse bug than the one
// this file exists for.
check(
  'an ordinary finished footer',
  readsCloudWork('✻ Baked for 7m 57s · done 3:08 PM\n\n╭───────╮\n│ >     │\n╰───────╯'),
  null
)
check('a running agent', readsCloudWork('✢ Smooshing… (8s · ↓ 282 tokens)'), null)
// Somebody TALKING about it is not somebody running one.
check(
  'prose about cloud sessions',
  readsCloudWork('we should check whether the cloud session is worth the money'),
  null
)
check('a local shell instead', readsCloudWork('✻ Sautéed for 10s · 1 shell still running'), null)
check('none left', readsCloudWork('◇ 0 cloud sessions still running'), null)

// ------------------------------------------------------------------ the hold expires
//
// The footer above is printed once and never repainted, so "the line is on screen" would
// hold the pane off its clock for the rest of the day. The hold has to run out.
const t0 = 1_000_000
check('never seen', cloudHeld(undefined, t0), false)
check('never seen, zero', cloudHeld(0, t0), false)
check('just seen', cloudHeld(t0, t0), true)
check('inside the hold', cloudHeld(t0, t0 + CLOUD_HOLD_MS - 1000), true)
check('past the hold', cloudHeld(t0, t0 + CLOUD_HOLD_MS), false)
check('long past the hold', cloudHeld(t0, t0 + CLOUD_HOLD_MS * 4), false)
// A second sighting refreshes it: the stamp is the LAST time the line was read.
check('re-seen', cloudHeld(t0 + CLOUD_HOLD_MS - 1000, t0 + CLOUD_HOLD_MS + 1000), true)
// Long enough to outlast the idle clock it competes with (5 minutes), and under an hour.
check('the hold outlasts the idle clock', CLOUD_HOLD_MS > 5 * 60_000, true)
check('the hold is under an hour', CLOUD_HOLD_MS <= 60 * 60_000, true)

rmSync(work, { recursive: true, force: true })
if (bad) {
  console.error(`\n${bad} failed`)
  process.exit(1)
}
console.log('\nall ok')
