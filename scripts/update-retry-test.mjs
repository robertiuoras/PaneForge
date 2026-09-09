// An update probe that timed out, and then waited a full cycle to try again.
//
// 2026-09-08: `supersede failed the update probe did not answer within 120s (online)` at
// 10:17:18 and again at 11:11:17, with `net::ERR_TIMED_OUT` at 10:35:38 and 11:12:10
// between them, and the next successful check at 11:21:17. Sixty-six minutes with no
// answer from the feed, because a failed probe re-armed at exactly the cadence a
// successful one does.
//
//   node scripts/update-retry-test.mjs

import { readFileSync } from 'node:fs'

const {
  PROBE_RETRY_MS,
  PROBE_RETRY_MAX_MS,
  PROBE_ALERT_AFTER,
  probeRetryMs,
  probeStalled
} = await import('../src/shared/updateRetry.ts')

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

ok('a probe that answered buys no backoff at all', probeRetryMs(0) === 0)
ok(
  'the first failure is retried in a minute, not at the next full cycle',
  probeRetryMs(1) === PROBE_RETRY_MS,
  `${PROBE_RETRY_MS / 1000}s`
)
ok('and the wait doubles while it keeps failing', probeRetryMs(2) === 2 * PROBE_RETRY_MS && probeRetryMs(3) === 4 * PROBE_RETRY_MS)
ok(
  'a feed that is genuinely down is not asked all day',
  probeRetryMs(20) === PROBE_RETRY_MAX_MS,
  `cap ${PROBE_RETRY_MAX_MS / 60_000}min`
)
ok('the backoff never goes backwards', probeRetryMs(4) >= probeRetryMs(3))

// The line is a fact about the machine, not a running commentary on the wifi.
ok('one bad request says nothing beyond its own log line', !probeStalled(1) && !probeStalled(2))
ok(
  'three in a row is a machine that is not reaching the feed, and says so',
  probeStalled(PROBE_ALERT_AFTER),
  `after ${PROBE_ALERT_AFTER}`
)
ok('...once, not once a minute for as long as it is out', !probeStalled(PROBE_ALERT_AFTER + 1))

// --- source assertions: the arithmetic is worth nothing unwired -------------------------
const updater = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8')
ok('the poll asks the backoff how long to wait', /function nextPollDelay\(\)/.test(updater) && /arm\(nextPollDelay\(\)\)/.test(updater))
// Load-bearing: a backoff that could exceed the ordinary cadence would make a bad network
// SLOWER to recover than doing nothing, which is the opposite of the point.
ok('...and the backoff can only make the next check sooner, never later', /Math\.min\(probeRetryMs\(probeFails\), usual\)/.test(updater))
ok('a probe that answers clears the count, whatever it answered', /probeFails = 0/.test(updater))
ok('a probe that does not answer counts itself', /probeFails \+= 1/.test(updater))
ok('and the stall gets its own searchable line', /probeStalled\(probeFails\)/.test(updater) && /probe stalled/.test(updater))

console.log(failed ? `\n${failed} failed` : '\nupdate retry: all good')
process.exit(failed ? 1 : 0)
