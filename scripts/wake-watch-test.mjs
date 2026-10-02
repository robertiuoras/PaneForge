// The pure half of the wake handling: how long the machine has been awake, and how often a
// poll may be put off after a flurry of dark wakes (2026-09-30 21:36: "checking after 11
// wake(s)", a check that died with the 21:50 sleep).
//
//   node scripts/wake-watch-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'wake-watch.mjs')
buildSync({ entryPoints: [join(ROOT, 'src/shared/wakeWatch.ts')], outfile, bundle: true, format: 'esm', platform: 'node' })
const { WakeWatch, SLEEP_GAP_MS, WAKE_SETTLE_MS, BURST_SETTLE_MS, MAX_POLL_DEFERS, pollSettle, deferPoll } =
  await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (what, cond) => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}`)
}

const T = 1_000_000
const w = new WakeWatch(T)
ok('awake for ever when no sleep was ever seen', w.awakeFor(T + 1e9) === Infinity)
w.tick(T + SLEEP_GAP_MS + 1)
const woke = T + SLEEP_GAP_MS + 1
ok('a sleep-sized gap starts the awake clock', w.awakeFor(woke + 7_000) === 7_000)
w.tick(woke + 5_000)
ok('ordinary ticks do not restart it', w.awakeFor(woke + 9_000) === 9_000)
ok('awakeFor agrees with justWoke', w.justWoke(woke + 9_000) === (9_000 < WAKE_SETTLE_MS))

ok('the first deferral waits the plain settle', pollSettle(0) === WAKE_SETTLE_MS)
ok('after a flurry the settle is longer', pollSettle(1) === BURST_SETTLE_MS && BURST_SETTLE_MS > WAKE_SETTLE_MS)
ok('a poll right after a wake is deferred', deferPoll(1_000, 0))
ok('a poll awake long enough runs', !deferPoll(WAKE_SETTLE_MS, 0))
ok('...but after a flurry that same time is not enough', deferPoll(WAKE_SETTLE_MS, 1) && !deferPoll(BURST_SETTLE_MS, 1))
ok('a poll with no wake on record is never deferred', !deferPoll(Infinity, 0))
ok('one poll is deferred a bounded number of times', deferPoll(0, MAX_POLL_DEFERS - 1) && !deferPoll(0, MAX_POLL_DEFERS))
let n = 0
while (deferPoll(0, n)) n++
ok('so a missed signal cannot stop polling for good (' + n + ' deferrals at most)', n === MAX_POLL_DEFERS)

console.log(failed ? `\n${failed} failed` : '\nwake watch: all good')
process.exit(failed ? 1 : 0)
