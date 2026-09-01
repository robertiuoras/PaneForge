// What a phone says when the desk stops answering.
//
// The complaint this closes: "test mobile remote session, it shows completely stopped when
// laptop is asleep, so its weird - maybe show some message when its definitely asleep
// rather than dead sessions when i look from my phone". A phone draws its panes from the
// last session list it was sent and that list has no clock in it, so a sleeping Mac leaves
// every row frozen at whatever it was doing, which reads as a desk full of dead sessions.
//
// The weight below is in the NEGATIVES: a handset drops its stream constantly and a banner
// that flashes on every one of those is a banner nobody reads.
//
//   node scripts/link-state-test.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-link-'))
const out = join(work, 'linkState.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/linkState.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
// `import()` takes a URL, and on Windows a bare `C:\...` path parses as the protocol
// `c:` - ERR_UNSUPPORTED_ESM_URL_SCHEME, on that machine only. pathToFileURL is the
// only spelling that is right on both.
const { linkLost, linkWords, linkNote, linkFrozenAt, linkIconWords, LINK_QUIET_MS } =
  await import(pathToFileURL(out).href)

const fail = []
const ok = (cond, what, got) => {
  if (cond) console.log(`ok   ${what}`)
  else {
    console.log(`FAIL ${what}${got === undefined ? '' : ` - got ${got}`}`)
    fail.push(what)
  }
}

const NOW = 1_800_000_000_000

// ---- 1. a live link says nothing ---------------------------------------------------
ok(!linkLost({ up: true, lastSeen: NOW }, NOW), 'a live stream draws no banner')
ok(
  !linkLost({ up: true, lastSeen: NOW - 600_000 }, NOW),
  'and an up stream that has simply been quiet still draws none - a desk with nothing happening is not a broken one'
)

// ---- 2. an ordinary phone reconnect says nothing ------------------------------------
// The load-bearing negative. Walking between rooms drops an EventSource; the browser
// reopens it within seconds, and a banner for that is noise.
ok(
  !linkLost({ up: false, lastSeen: NOW - 3_000 }, NOW),
  'a three-second gap is an ordinary reconnect, not an outage'
)
ok(
  !linkLost({ up: false, lastSeen: NOW - (LINK_QUIET_MS - 1) }, NOW),
  'and nothing is said right up to the quiet window'
)

// ---- 3. a real outage does ----------------------------------------------------------
ok(
  linkLost({ up: false, lastSeen: NOW - (LINK_QUIET_MS + 1) }, NOW),
  'past the quiet window the screen says so'
)
ok(linkLost({ up: false, lastSeen: 0 }, NOW), 'and a screen that never heard anything says so at once')

// ---- 4. the words -------------------------------------------------------------------
ok(
  linkWords({ up: false, lastSeen: NOW - 45_000 }, NOW) === 'Desk not answering for 45s - asleep?',
  'seconds under a minute',
  linkWords({ up: false, lastSeen: NOW - 45_000 }, NOW)
)
ok(
  linkWords({ up: false, lastSeen: NOW - 480_000 }, NOW) === 'Desk not answering for 8m - asleep?',
  'minutes past one',
  linkWords({ up: false, lastSeen: NOW - 480_000 }, NOW)
)
ok(
  linkWords({ up: false, lastSeen: NOW - 9_000_000 }, NOW) === 'Desk not answering for 2h 30m - asleep?',
  'hours and minutes for an overnight sleep',
  linkWords({ up: false, lastSeen: NOW - 9_000_000 }, NOW)
)
ok(
  linkWords({ up: false, lastSeen: 0 }, NOW) === 'Cannot reach the desk',
  'and a screen with nothing to date does not invent an age',
  linkWords({ up: false, lastSeen: 0 }, NOW)
)

// ---- 5. it may not claim to know WHY ------------------------------------------------
// This screen cannot tell a sleeping Mac from a dropped tunnel from a handset with no
// signal, and naming the wrong one sends somebody to fix the wrong thing.
const said = linkWords({ up: false, lastSeen: NOW - 600_000 }, NOW)
ok(said.includes('asleep?'), 'asleep is offered as the likely reason', said)
ok(!/is asleep|is sleeping|offline\b/i.test(said), 'and never as a verdict', said)
ok(
  /last thing it said|not what they are doing now/i.test(linkNote()),
  'the note says the rows are old, which is the actual complaint',
  linkNote()
)

rmSync(work, { recursive: true, force: true })
// ------------------------------------------------- clocks stop when the desk stops

ok(
  linkFrozenAt({ up: true, lastSeen: NOW - 5_000 }, NOW) === 0,
  'a live link freezes nothing'
)
ok(
  linkFrozenAt({ up: false, lastSeen: NOW - 3_000 }, NOW) === 0,
  'an ordinary reconnect blip does not stop the clocks'
)
ok(
  linkFrozenAt({ up: false, lastSeen: NOW - 60_000 }, NOW) === NOW - 60_000,
  'a lost link stops every clock at the last thing this screen heard'
)
ok(
  linkFrozenAt({ up: false, lastSeen: 0 }, NOW) === 0,
  'a screen that never heard anything has no moment to freeze at'
)
ok(/not connected/i.test(linkIconWords({ up: false, lastSeen: 0 }, NOW)), 'the icon says what it means')
ok(/connected/i.test(linkIconWords({ up: true, lastSeen: NOW }, NOW)), 'and says so when it is up')

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall good')
process.exit(fail.length ? 1 : 0)
