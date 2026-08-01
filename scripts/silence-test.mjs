// Test for the two alerts that are not "your turn finished": a running turn that has
// gone silent, and the terminal bell.
//
// It is a rule about MINUTES, which is exactly why it is pinned here rather than
// checked by hand: nobody re-tests a five minute timer, so every mistake it can make
// ships. And every mistake it can make is the same one - the app crying wolf about a
// pane that is fine, which is the fastest way to make people turn an alert off.
//
// The decision lives in `src/shared/alerts.ts` as a pure function for this reason: the
// sweep it runs inside owns a pty, and a test that has to spawn `claude` to find out
// whether a number is compared correctly is a test nobody runs.
//
//   node scripts/silence-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-silence-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'alerts.bundle.cjs')
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/alerts.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { stalledNow, silenceMs } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}

const MIN = 60_000
/** A turn that has been running for a while: the case the alert exists for. */
const running = { runSince: 1, engaged: true, raised: false, silenceMs: 5 * MIN }

// ---------------------------------------------------------------------------
// The one thing it must say

is(stalledNow({ ...running, quiet: 5 * MIN + 1 }), true, 'silent past the limit mid-turn must raise')

// ---------------------------------------------------------------------------
// The many things it must not

is(stalledNow({ ...running, quiet: 5 * MIN }), false, 'exactly at the limit is not past it')
is(stalledNow({ ...running, quiet: 4 * MIN }), false, 'a quiet stretch inside the limit is normal')
is(
  stalledNow({ ...running, quiet: 99 * MIN, raised: true }),
  false,
  'already raised for this silence - it must not repeat every second of it'
)
is(
  stalledNow({ ...running, quiet: 99 * MIN, silenceMs: 0 }),
  false,
  '0 minutes means the alert is off, however long the silence'
)
// The big one. An idle pane is silent for hours and is not stuck - it is a pane you
// are not using. Alerting on it would mean eight alerts about nothing every N minutes,
// which is how an alert gets switched off for good.
is(
  stalledNow({ ...running, runSince: undefined, quiet: 99 * MIN }),
  false,
  'no turn running: silence at an idle prompt is the normal state of a pane'
)
is(
  stalledNow({ ...running, engaged: false, quiet: 99 * MIN }),
  false,
  'nothing has been asked of this pane, so nothing is late'
)

// ---------------------------------------------------------------------------
// Minutes as the settings dialog stores them

is(silenceMs(5), 5 * MIN, '5 minutes')
is(silenceMs(0), 0, 'never')
is(silenceMs(-3), 0, 'a negative is off, not a limit in the past')
is(silenceMs(undefined), 0, 'unset config (an older config.json) is off, never instant')
is(silenceMs(NaN), 0, 'garbage is off')
is(silenceMs(0.2), MIN, 'a floor of one minute: below it a slow tool call is an alert')

// ---------------------------------------------------------------------------
// The sweep's own bookkeeping, as a state machine over the same predicate. This is the
// half that has to hold over TIME rather than over one call: raise once, stay quiet
// while it is still silent, and be able to raise again after the pane speaks and
// stalls a second time.
{
  let raised = false
  let raises = 0
  const tick = (quiet, spoke) => {
    if (spoke) raised = false
    if (stalledNow({ runSince: 1, engaged: true, raised, quiet, silenceMs: 5 * MIN })) {
      raised = true
      raises++
    }
  }
  tick(1 * MIN, false)
  tick(6 * MIN, false) // raise
  tick(7 * MIN, false)
  tick(8 * MIN, false)
  is(raises, 1, 'one raise per stretch of silence, not one per sweep tick')
  tick(0, true) // the pane speaks again
  is(raised, false, 'output clears the mark')
  tick(6 * MIN, false)
  is(raises, 2, 'a second stall in the same turn is a second thing worth saying')
}

// A turn that ends resets it the same way output does, so a pane can never be both
// "finished, waiting for you" and "stuck mid-turn" at once.
{
  let raised = true
  const endRun = () => {
    raised = false
  }
  endRun()
  is(
    stalledNow({ runSince: undefined, engaged: true, raised, quiet: 99 * MIN, silenceMs: 5 * MIN }),
    false,
    'the turn ended: the chime owns this pane now, not the stall alert'
  )
}

rmSync(work, { recursive: true, force: true })
console.log(`PASS silence: ${checks} assertions`)
