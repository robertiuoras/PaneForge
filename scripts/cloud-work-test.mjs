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
const { readsCloudWork, cloudHeld, holdAfterFinish, CLOUD_HOLD_MS } = createRequire(import.meta.url)(out)

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
// The shell half of the same footer, which this reader used to refuse. A pane wearing it
// was counting down to close with a render still going (2026-09-04).
check('a local shell', readsCloudWork('✻ Sautéed for 10s · 1 shell still running'), '1 shell')
check('shells, plural', readsCloudWork('✻ Cogitated for 2m 56s · done 5:12 PM · 2 shells still running'), '2 shells')
check('no shell left', readsCloudWork('· 0 shells still running'), null)
check('the word alone', readsCloudWork('open a shell and run it'), null)
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

// ------------------------------------------------------------------ a later footer ends a shell hold
//
// Pane s91, 2026-09-24. Both frames are the bottom of what main was actually sent with
// the `false` busy reading, replayed out of the pane's own pty log (history/s91-*.log)
// and matched to the busy-flip audit by the statusline numbers. 08:50:09Z: the turn ended
// with a `run_in_background` shell going. The shell ended 08:51:19Z, the next turn ended
// 08:51:54Z with the same footer and no running line - and the pane still wore `1 shell`
// until 09:35Z, so the idle close, sleep and handoff all refused a pane doing nothing.
const bar = (n) => '─'.repeat(n)
const s91Running = [
  "⏺ Still running; I'll pick it up on the completion notice.",
  '',
  '✻ Crunched for 13m 2s · done 6:50 PM · 1 shell still running',
  '',
  bar(120),
  '❯ ',
  bar(120),
  '  ◆ Opus 5.5 | assistant-c |  lane-c | ✓ synced | █░░░░░░░░░ 17% 172.1k | +126/-39 | ⬢ dev: taskdriver (PC)',
  '  5h 37% · wk 18% · Fable 0% · Σ 6.7M · $3.52 api (97% cached)',
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents',
  ''
].join('\n')
const s91Ended = [
  '✻ Baked for 32s · done 6:51 PM',
  '',
  '※ recap: I reviewed the TikTok and used it to improve our video workflow: new pacing, caption and loudness data in video-director, plus',
  '  five video-watch fixes, all committed. Nothing is left to do; the next step is just reading the review above. (disable recaps in /config)',
  '',
  bar(139),
  '❯ ',
  bar(139),
  '  ◆ Opus 5.5 | assistant-c |  lane-c | ✓ synced | █░░░░░░░░░ 18% 177.2k | +126/-39 | ⬢ dev: taskdriver (PC)',
  '  5h 37% · wk 19% · Fable 0% · Σ 7.4M · $3.68 api (97% cached)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ''
].join('\n')
const t1 = t0 + 70_000
check('s91: the running footer', readsCloudWork(s91Running), '1 shell')
check('s91: the running footer starts a hold', holdAfterFinish({}, s91Running, t0), { work: '1 shell', since: t0 })
check('s91: the next footer, no running line, ends it', holdAfterFinish({ work: '1 shell', since: t0 }, s91Ended, t1), {})
check('plural shells end the same way', holdAfterFinish({ work: '2 shells', since: t0 }, s91Ended, t1), {})
// A frame with no finished footer in it says nothing about the shells: an interrupted
// turn, a question, a frame drawn mid-repaint. The hold stays.
const noFooter = s91Ended.replace('✻ Baked for 32s · done 6:51 PM', '')
check('no footer in the frame keeps the hold', holdAfterFinish({ work: '1 shell', since: t0 }, noFooter, t1), {
  work: '1 shell',
  since: t0
})
// The busy spinner wears the same glyph and is not a finished footer.
check(
  'a spinner is not a finished footer',
  holdAfterFinish({ work: '1 shell', since: t0 }, '✻ Cooking… (30s · ↓ 1.8k tokens)\n❯ ', t1),
  { work: '1 shell', since: t0 }
)
// A cloud session keeps its full hold: nobody has measured the CLI reprinting THAT line
// on every finished footer, so a footer without it is not yet evidence it ended.
check(
  'a cloud session hold survives a plain footer',
  holdAfterFinish({ work: '1 cloud session', since: t0 }, s91Ended, t1),
  { work: '1 cloud session', since: t0 }
)
// The newest footer is the one that counts. An older footer still in the frame with its
// running line on it must not re-arm a hold the newer one ended.
const staleAbove = s91Running.split('\n').slice(0, 4).join('\n') + '\n' + s91Ended
check('an older running footer above a newer plain one reads as nothing', readsCloudWork(staleAbove), null)
check('...and ends the hold', holdAfterFinish({ work: '1 shell', since: t0 }, staleAbove, t1), {})
// ...and the other way round: the newest footer still says a shell is running.
check(
  'a newer running footer refreshes the hold',
  holdAfterFinish({ work: '1 shell', since: t0 }, s91Ended.replace('done 6:51 PM', 'done 6:51 PM · 1 shell still running'), t1),
  { work: '1 shell', since: t1 }
)

rmSync(work, { recursive: true, force: true })
if (bad) {
  console.error(`\n${bad} failed`)
  process.exit(1)
}
console.log('\nall ok')
