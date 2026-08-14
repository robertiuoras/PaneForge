// Noticing that a signed-in phone has stopped being the phone that was approved.
//
// The load-bearing half of this file is the NEGATIVE cases. A cookie here lasts ten years
// on purpose, so the watcher is the only thing standing between a copied one and nobody
// ever knowing - but a watcher that marks a row every time a phone leaves the house, or
// every time iOS updates its user-agent, is one whose marks get scrolled past, and a
// warning nobody reads is worse than none because it is believed to be working.
//
//   node scripts/device-watch-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-device-watch-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'deviceWatch.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/deviceWatch.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { browserChanged, markFor, uaShape } = createRequire(import.meta.url)(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}

// Real strings, taken from the shapes this desk actually sees.
const IPHONE_17 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPHONE_18 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LINUX_CURL = 'curl/8.7.1'

const phone = { kind: 'iPhone', address: '192.168.1.44', origin: 'this network', ua: IPHONE_17 }
const at = 1_760_000_000_000
const from = (address, origin, ua) => ({ address, origin, ua, at })

// ---- what must NOT fire -------------------------------------------------------------
// An OS upgrade rewrites two version numbers in the string and nothing else. Marking every
// phone in the house the morning after an iOS release is how this feature stops being read.
is(uaShape(IPHONE_17), uaShape(IPHONE_18), 'an iOS version bump is the same browser')
is(browserChanged(phone, from('192.168.1.44', 'this network', IPHONE_18)), false, 'no mark on a version bump')

// The single most ordinary thing a phone does: leave the house. Address and origin both
// change, every day, and neither is evidence of anything.
is(
  markFor(phone, from('203.0.113.9', 'internet', IPHONE_17)),
  null,
  'a phone on a train is not an intruder'
)
is(
  markFor(phone, from('100.89.94.66', 'tailnet', IPHONE_17)),
  null,
  'and neither is one that came back over the tailnet'
)

// Two streams from the SAME place is a reload, or a second tab. One browser, one device.
is(
  markFor(phone, from('192.168.1.44', 'this network', IPHONE_17), ['this network']),
  null,
  'two streams from one place is a reload, not a copy'
)

// A row written before this existed carries no user-agent. Silence beats a guess: an
// invented mark on the first arrival after an update would land on every device at once.
is(
  markFor({ ...phone, ua: undefined }, from('192.168.1.44', 'this network', MAC_CHROME)),
  null,
  'nothing known about the old browser means nothing said'
)
is(
  markFor(phone, from('192.168.1.44', 'this network', '')),
  null,
  'and a request with no user-agent at all says nothing either'
)

// ---- what MUST fire -----------------------------------------------------------------
// The cookie carried to another machine. This is the actual threat: the token is a
// remote-control credential for a desk, and one was issued to an unknown host once.
const moved = markFor(phone, from('203.0.113.9', 'internet', MAC_CHROME))
ok(moved, 'a different browser holding the token is noticed')
is(moved.kind, 'browser-changed', 'and named for what it is')
is(moved.was, 'iPhone', 'the sentence says what was approved')
is(moved.now, 'Mac', 'and what turned up')
ok(/sign it out/i.test(moved.words), 'and it says the one thing to do about it')

// Not a browser at all. A scripted client replaying the cookie is the same finding.
const scripted = markFor(phone, from('203.0.113.9', 'internet', LINUX_CURL))
ok(scripted, 'a scripted client holding the token is noticed')
is(scripted.kind, 'browser-changed', 'same finding, whatever it calls itself')

// The same token watching from two places at the same moment. One sign-in is one browser,
// so this is a copy even when the user-agent matches - which it will, if it was copied.
const both = markFor(phone, from('203.0.113.9', 'internet', IPHONE_17), ['this network'])
ok(both, 'one token, two places, at once')
is(both.kind, 'two-places', 'and named for that rather than for the browser')
ok(/internet/.test(both.words) && /this network/.test(both.words), 'both places are in the sentence')

// Order of the two findings: a different browser is the stronger statement, and it is the
// one that survives the intruder closing the other tab, so it wins when both are true.
is(
  markFor(phone, from('203.0.113.9', 'internet', MAC_CHROME), ['this network']).kind,
  'browser-changed',
  'the stronger finding is the one reported'
)

// The mark is a fact with a time on it: the panel prints "how long ago", and a mark with
// no `at` would read as having happened this second, for ever.
is(moved.at, at, 'the mark carries when it was noticed')

console.log(`device watch: ${checks} checks passed`)
