// The clocks: what they print, and how often they may wake the app up to print it.
//
// Two facts got a test at once, and the second is the reason the first moved out of
// `Elapsed.tsx` into `shared/elapsed.ts` where node can load it.
//
// What it prints: the pane header now answers "how long has this pane been OPEN", which is
// a different question from the turn clock beside it - the turn resets whenever the agent
// finishes, and `/clear` throws the conversation away without touching the pty. That clock
// is routinely overnight, so `171h 20m` had to become `7d 03h`.
//
// How often: it is one clock PER PANE, alive for days. Waking every one of them once a
// second to redraw a string that only changes once a minute is a render per pane per
// second, for ever - the exact cost the report was about ("i just dont want it to lag me
// that much"). `stepFor` is the saving and `bucketOf`'s offset is the trap inside it: a
// step measured from the wall clock instead of from the pane's own start ticks exactly as
// rarely and shows the wrong minute for up to 59 seconds of every one.
//
//   node scripts/elapsed-test.mjs

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// The real source, through node's type stripping - see usage-test.mjs for why.
const { formatElapsed, stepFor, bucketOf, kb, whenWords, DAY_MS } = await import(
  'file://' + join(root, 'src', 'shared', 'elapsed.ts').replace(/\\/g, '/')
)

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)

const S = 1000
const M = 60 * S
const H = 60 * M

// ------------------------------------------------------------------ what a clock prints

eq('a pane opened a moment ago', formatElapsed(0), '0s')
eq('seconds on their own', formatElapsed(42 * S), '42s')
eq('minutes carry the seconds', formatElapsed(5 * M + 23 * S), '5m 23s')
eq('an hour drops the seconds', formatElapsed(H + 4 * M + 59 * S), '1h 04m')
eq('the minutes are padded, so the width does not jump', formatElapsed(H + 4 * M), '1h 04m')
// The reading the whole feature exists for.
eq('a session open since yesterday morning', formatElapsed(12 * H + 3 * M), '12h 03m')
eq('and the last hour before it becomes a day', formatElapsed(23 * H + 59 * M), '23h 59m')
eq('a day is a day, not 24 hours', formatElapsed(24 * H), '1d 00h')
eq('and a week is not 171 hours', formatElapsed(7 * 24 * H + 3 * H + 20 * M), '7d 03h')
// A clock is fed two numbers from different places (a session's `openedAt` and this
// window's `Date.now()`), and on a restored pane they have been the wrong way round.
eq('a negative reading is zero, never a minus sign', formatElapsed(-5 * M), '0s')

eq('bytes', kb(500), '500 B')
eq('kilobytes', kb(74 * 1024), '74 KB')
eq('megabytes', kb(3.2 * 1024 * 1024), '3.2 MB')

// -------------------------------------------------------- how often it may wake anything

eq('a seconds readout needs the second', stepFor(42 * S), 1000)
eq('so does the last second before an hour', stepFor(H - 1), 1000)
eq('an hours readout needs only the minute', stepFor(H), 60_000)
eq('and a day-old pane the same', stepFor(30 * H), 60_000)

/** Every notification a subscriber would get, over `span`, at one tick a second. */
function wakeups(since, span, step, offset) {
  let bucket = bucketOf(since, step, offset)
  let n = 0
  for (let t = since + 1000; t <= since + span; t += 1000) {
    const b = bucketOf(t, step, offset)
    if (b === bucket) continue
    bucket = b
    n++
  }
  return n
}

const opened = Date.UTC(2026, 7, 24, 9, 0, 30) // :30 past, on purpose
{
  const perHourFast = wakeups(opened, H, 1000, opened)
  const perHourSlow = wakeups(opened, H, 60_000, opened)
  eq('a seconds clock is woken once a second', perHourFast, 3600)
  eq('a minutes clock is woken once a minute', perHourSlow, 60)
  ok(
    'which is 60x fewer renders per pane, per hour, for ever',
    perHourFast / perHourSlow === 60,
    `${perHourFast} vs ${perHourSlow}`
  )
}

// The trap. A minute step measured from the wall clock ticks exactly as rarely, so a test
// that only counted wakeups would pass - and the digits would be wrong for most of every
// minute. This is the control that catches it.
{
  const before = opened + H + 4 * M + 59 * S // shows 1h 04m
  const after = opened + H + 5 * M // shows 1h 05m
  eq('the reading really does change at that boundary', formatElapsed(before - opened), '1h 04m')
  eq('...to the next minute', formatElapsed(after - opened), '1h 05m')
  ok(
    'a clock stepped from its own start turns over exactly there',
    bucketOf(before, 60_000, opened) !== bucketOf(after, 60_000, opened),
    `${bucketOf(before, 60_000, opened)} vs ${bucketOf(after, 60_000, opened)}`
  )
  ok(
    'CONTROL: stepped from the wall clock it does not, and shows the wrong minute',
    bucketOf(before, 60_000, 0) === bucketOf(after, 60_000, 0),
    'the offset-free version turned over here, so this control no longer proves anything'
  )
}

// A clock that has stopped (a closed session in History) asks for no timer at all. The
// component spells that `Infinity`, and the arithmetic has to survive it rather than
// producing a NaN bucket that compares unequal to itself and fires on every single tick.
{
  const b1 = bucketOf(opened, Infinity, opened)
  const b2 = bucketOf(opened + 7 * 24 * H, Infinity, opened)
  ok('a frozen clock never changes bucket', b1 === b2, `${b1} vs ${b2}`)
  ok('and its bucket is a number', Number.isFinite(b1), String(b1))
}

// How a moment in the PAST is said - History's rows, where the reader's question is "which
// of these did I just close" and a wall-clock stamp makes them subtract it from the clock in
// their own status bar first. The boundary is the load-bearing half: past a day a distance
// stops identifying anything (`31h ago`) and the calendar takes back over.
{
  const NOW = Date.parse('2026-08-24T13:15:00Z')
  eq('a moment ago is not a number', whenWords(NOW - 12_000, NOW), 'just now')
  eq('under a minute is still just now', whenWords(NOW - 59_000, NOW), 'just now')
  eq('minutes are minutes', whenWords(NOW - 5 * 60_000, NOW), '5 min ago')
  eq('and stay minutes to the hour', whenWords(NOW - 59 * 60_000, NOW), '59 min ago')
  eq('past an hour it carries both units', whenWords(NOW - (3 * 60 + 20) * 60_000, NOW), '3h 20m ago')
  eq('a round hour drops the empty minutes', whenWords(NOW - 4 * 3600_000, NOW), '4h ago')
  eq('just inside a day is still a distance', whenWords(NOW - (DAY_MS - 60_000), NOW), '23h 59m ago')
  // The control: past the boundary this is a DATE, not a distance, whatever the locale.
  const old = NOW - DAY_MS - 3600_000
  eq('past a day the calendar takes over', whenWords(old, NOW), new Date(old).toLocaleString())
  eq('and so does a timestamp from the future', whenWords(NOW + 60_000, NOW), new Date(NOW + 60_000).toLocaleString())
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
