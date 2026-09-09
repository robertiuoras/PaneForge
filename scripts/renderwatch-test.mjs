// What the renderer watchdog may do to somebody's window, and the four times it must not.
//
// The weight is in the negatives. A reload is the one action here and it costs the person
// their scroll position in every pane, so acting on a renderer that is merely BUSY, or on
// one that is unresponsive because it is reloading, is worse than the freeze it is for.
//
//   node scripts/renderwatch-test.mjs

import { readFileSync } from 'node:fs'

const {
  GRACE_MS,
  PROBE_DEAD_MS,
  RELOAD_COOLDOWN_MS,
  MAX_RELOADS,
  STUCK_WEDGES,
  WEDGE_WINDOW_MS,
  MAX_SPINS,
  SPIN_MS,
  SPIN_WINDOW_MS,
  decide,
  fresh,
  afterAct,
  afterGiveUp,
  noteWedge,
  MAX_GIVE_UP_REBUILDS,
  noteRecovered
} = await import('../src/shared/renderWatch.ts')

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

const T = 1_000_000_000
const w = (over) => ({ ...fresh(), ...over })

// --- the healthy window, which is most windows most of the time -----------------------
ok('a window nobody has complained about is left alone', decide(fresh(), T) === 'wait')
ok(
  'a probe sent a moment ago is not a spin',
  decide(w({ probeSentAt: T - 1000 }), T) === 'wait'
)
ok(
  'unresponsive for less than the grace period is not acted on',
  decide(w({ unresponsiveSince: T - (GRACE_MS - 1) }), T) === 'wait',
  `grace ${GRACE_MS}ms`
)

// --- the incident this exists for ------------------------------------------------------
ok(
  'unresponsive past the grace period is reloaded',
  decide(w({ unresponsiveSince: T - GRACE_MS }), T) === 'reload'
)
ok(
  'a spin Chromium never noticed is caught by the unanswered probe',
  decide(w({ probeSentAt: T - PROBE_DEAD_MS }), T) === 'reload',
  `probe dead at ${PROBE_DEAD_MS}ms`
)
ok(
  'a dead renderer is REBUILT, not reloaded - there is no page left',
  decide(w({ gone: true }), T) === 'recreate'
)
ok(
  '...and it is not made to wait out the cooldown first',
  decide(w({ gone: true, lastReloadAt: T - 1000 }), T) === 'recreate'
)

// --- the renderer that heals itself, and keeps doing it ---------------------------------
//
// 2026-09-05: eight `unresponsive` -> `answering again after 19-55s` cycles on one pid
// between 01:03 and 03:11, cpu flat at 10.1-10.4%, working set 161MB -> 286MB. Every cycle
// ended in a recovery, so every cycle read as fine, and it was never reloaded once.
const first = noteWedge(fresh(), T)
ok('the first wedge is counted', first.wedges === 1 && first.lastWedgeAt === T)
ok(
  '...and is still given its grace period, because one wedge is a busy frame',
  decide({ ...first, unresponsiveSince: T }, T + (GRACE_MS - 1)) === 'wait'
)
const healed = { ...first, unresponsiveSince: 0 }
const second = noteWedge(healed, T + 20 * 60_000)
ok('a wedge after a recovery is the SECOND, not a new first', second.wedges === STUCK_WEDGES)
ok(
  'and it is reloaded on sight - waiting it out is what let this run for three hours',
  decide(second, second.lastWedgeAt + 1) === 'reload'
)
ok(
  '...still behind the cooldown, so a reload of its own is not read as the next wedge',
  decide({ ...second, lastReloadAt: second.lastWedgeAt - 1000 }, second.lastWedgeAt + 1) === 'wait'
)
const stale = noteWedge({ ...healed, lastWedgeAt: T }, T + WEDGE_WINDOW_MS + 1)
ok(
  'a window that wedges once an hour is two incidents, not a leak',
  stale.wedges === 1,
  `window ${Math.round(WEDGE_WINDOW_MS / 60000)}min`
)

// --- the refusals ----------------------------------------------------------------------
ok(
  'a window that has just been reloaded is unresponsive BY CONSTRUCTION and is left alone',
  decide(w({ unresponsiveSince: T - GRACE_MS * 10, lastReloadAt: T - (RELOAD_COOLDOWN_MS - 1) }), T) === 'wait',
  `cooldown ${RELOAD_COOLDOWN_MS}ms`
)
ok(
  'past the cooldown the same wedge is acted on',
  decide(w({ unresponsiveSince: T - GRACE_MS * 10, lastReloadAt: T - RELOAD_COOLDOWN_MS }), T) === 'reload'
)
ok(
  'a window that keeps wedging is left as the app shipped, not reloaded for ever',
  decide(w({ unresponsiveSince: T - GRACE_MS * 10, reloads: MAX_RELOADS, lastReloadAt: T - RELOAD_COOLDOWN_MS }), T) ===
    'give-up',
  `max ${MAX_RELOADS}`
)
ok(
  '...and a renderer that keeps DYING is given up on too, rather than rebuilt for ever',
  decide(w({ gone: true, reloads: MAX_RELOADS }), T) === 'give-up'
)

// --- and what happens to a window it has run out of reloads for -------------------------
//
// `still wedged after 3 reload(s) - leaving it alone` (2026-09-05 00:48:17, pid 97494) is
// the LAST line about that window in the whole log: the watch stopped with it, nothing was
// rebuilt, and nobody was told.
ok(
  'a window the watchdog has given up on is rebuilt, not abandoned',
  afterGiveUp(0, Infinity) === 'recreate'
)
ok(
  '...once - a rebuild that wedges again is a loop, not a rescue',
  afterGiveUp(MAX_GIVE_UP_REBUILDS, 60_000) === 'leave',
  `max ${MAX_GIVE_UP_REBUILDS}`
)
ok(
  '...and an app left running for hours earns the rebuild back',
  afterGiveUp(MAX_GIVE_UP_REBUILDS, WEDGE_WINDOW_MS + 1) === 'recreate'
)

// --- what an action leaves behind -------------------------------------------------------
const after = afterAct(
  w({ unresponsiveSince: T - GRACE_MS, probeSentAt: T - PROBE_DEAD_MS, gone: true, wedges: 4, lastWedgeAt: T - 5 }),
  T
)
ok('the reload is the answer to those wedges, so the count starts again', after.wedges === 0 && after.lastWedgeAt === 0)
ok('acting clears every reading it acted on', after.unresponsiveSince === 0 && after.probeSentAt === 0 && !after.gone)
ok('...and counts itself', after.reloads === 1 && after.lastReloadAt === T)
ok('...so the very next tick waits instead of reloading again', decide(after, T + 1) === 'wait')

// --- source assertions: the arithmetic above is worth nothing unwired --------------------
const main = readFileSync(new URL('../src/main/renderWatch.ts', import.meta.url), 'utf8')
ok("both Electron events are handled", /on\('unresponsive'/.test(main) && /on\('render-process-gone'/.test(main))
ok('the liveness probe really round-trips the renderer', /executeJavaScript\(/.test(main))
ok(
  'the recovery takes nothing on screen - no focus, no show, no always-on-top',
  /webContents\.reload\(\)/.test(main) && !/\.focus\(\)|\.show\(\)|setAlwaysOnTop|moveTop/.test(main)
)
// Measured, not assumed: reload() alone left the window dead for the whole 45s of a bounded
// spin (2026-08-28). It is a message to the thread that is busy. The process has to go.
ok('...and it KILLS the spinning renderer first, because reload cannot preempt it', /forcefullyCrashRenderer\(\)/.test(main))
ok(
  'the log names the pid and its CUMULATIVE cpu time, which percentCPUUsage does not carry',
  /getOSProcessId\(\)/.test(main) && /cpu-time/.test(main)
)
ok('every action leaves a line in paneforge-errors.log', /logProblem\(/.test(main))
ok('the wedge is counted where Chromium reports it', /noteWedge\(state, Date\.now\(\)\)/.test(main))
const giveUp = main.slice(main.indexOf("act === 'give-up'"), main.indexOf("const why = state.gone"))
ok(
  'giving up rebuilds the window instead of leaving a dead desk behind',
  giveUp !== '' && /afterGiveUp\(/.test(giveUp) && /return recreate\(\)/.test(giveUp)
)
ok(
  '...and the line that leaves it alone says a rebuild was already tried',
  /reload\(s\) and a rebuild - leaving it alone/.test(main)
)
// faultNotify only sends renderer lines that are an ACT, matched on their first word.
const notify = readFileSync(new URL('../src/shared/faultNotify.ts', import.meta.url), 'utf8')
ok(
  'both give-up lines still reach the phone, since they start with "still wedged"',
  /still wedged/.test(notify)
)
// The bug was that coming back looked like the end of the incident. It is not.
const responsive = main.slice(main.indexOf("on('responsive'"), main.indexOf("on('render-process-gone'"))
ok(
  'coming back does NOT forget the wedge - that reading is the leak',
  responsive !== '' && !/wedges\s*[=:]\s*0/.test(responsive),
  JSON.stringify(responsive.slice(0, 60))
)

// --- the renderer that kept wedging and kept coming back ------------------------------
//
// pid 5075, this Mac, 2026-09-05: eight `unresponsive` -> `answering again after Nms`
// cycles between 01:03 and 03:11, recoveries growing 19s -> 55s, working set 205MB ->
// 286MB, cumulative CPU 1:32 -> 23:13. Never reloaded once, while three renderers that
// wedged HARD the same night were killed and reloaded inside 20 seconds. Every episode
// ended a beat before the next 5s tick asked, and `responsive` wiped the only clock
// `decide` was measuring.
{
  let s = fresh()
  ok('a fresh watch has no spins against it', s.spins === 0 && s.firstSpinAt === 0)
  // A renderer is briefly unresponsive whenever it does real work. That is not a spin.
  s = noteRecovered(s, SPIN_MS - 1, T)
  ok('a quick recovery is not counted at all', s.spins === 0, `under ${SPIN_MS}ms`)
  ok('...and nothing is done about it', decide(s, T) === 'wait')

  s = noteRecovered(fresh(), 20_000, T)
  ok('a 20s freeze it came out of by itself IS counted', s.spins === 1)
  ok('one spin is still left alone', decide(s, T) === 'wait')
  s = noteRecovered(s, 30_000, T + 60_000)
  ok('two spins are still left alone', s.spins === 2 && decide(s, T + 60_000) === 'wait')
  s = noteRecovered(s, 55_000, T + 120_000)
  ok(
    `${MAX_SPINS} spins inside the window is a wedge, and gets the reload the hard ones get`,
    s.spins === MAX_SPINS && decide(s, T + 120_000) === 'reload'
  )

  // ...and the reload is the answer, so the tally starts again. Without this the second
  // reload would fire the instant the cooldown lifted, which is the loop this replaces.
  const after = afterAct(s, T + 120_000)
  ok('the reload clears the tally', after.spins === 0 && after.firstSpinAt === 0)
  ok('...and the cooldown still holds it off', decide(after, T + 121_000) === 'wait')

  // Spins hours apart are two ordinary bad moments, not one sick renderer.
  let slow = noteRecovered(fresh(), 20_000, T)
  slow = noteRecovered(slow, 20_000, T + SPIN_WINDOW_MS + 1)
  ok('a spin outside the window starts the tally again', slow.spins === 1, `window ${SPIN_WINDOW_MS}ms`)
  ok('...so an occasional slow moment never reloads anybody', decide(slow, T + SPIN_WINDOW_MS + 1) === 'wait')

  // The refusals above it all still win: a spent watch is left alone, and a dead process
  // is rebuilt rather than reloaded.
  ok(
    'a watch that has spent its reloads gives up rather than acting on spins',
    decide({ ...s, reloads: MAX_RELOADS }, T + 120_000) === 'give-up'
  )
  ok(
    'a gone renderer is still rebuilt, spins or not',
    decide({ ...s, gone: true }, T + 120_000) === 'recreate'
  )
}

// Both event handlers run before a watchdog tick when a hang clears between checks.
// Keep the early second-wedge response, but still recover if the tick misses that hang.
{
  let s = fresh()
  for (let episode = 0; episode < MAX_SPINS; episode++) {
    const start = T + episode * 60_000
    s = noteWedge(s, start)
    if (episode === 1) {
      ok('the combined watch catches a second active wedge immediately', decide(s, start + 1) === 'reload')
    }
    s = noteRecovered({ ...s, unresponsiveSince: 0 }, SPIN_MS, start + SPIN_MS)
    ok(
      `recovery between ticks retains both counters for episode ${episode + 1}`,
      s.wedges === episode + 1 && s.spins === episode + 1 &&
        decide(s, start + SPIN_MS) === (episode + 1 === MAX_SPINS ? 'reload' : 'wait')
    )
  }
  s = afterAct(s, T + MAX_SPINS * 60_000)
  ok('one reload clears both incident histories', s.wedges === 0 && s.lastWedgeAt === 0 && s.spins === 0 && s.firstSpinAt === 0)
}

const main2 = readFileSync(new URL('../src/main/renderWatch.ts', import.meta.url), 'utf8')
ok(
  "the 'responsive' handler is what counts a spin - nothing else sees one end",
  /noteRecovered\(state, forMs, now\)/.test(main2)
)

const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
ok('the window is actually watched', /watchRenderer\(win,/.test(index))
// A window whose renderer died is still in getAllWindows(), so the old test left the app
// stranded: a window it could never draw in, and no way to ask for another.
const activate = index.slice(index.indexOf("app.on('activate'"), index.indexOf("app.on('activate'") + 400)
ok(
  'activate treats a destroyed renderer as no window at all',
  activate !== '' && /if \(!alive\(\)\) return createWindow\(\)/.test(activate),
  JSON.stringify(activate.slice(0, 90))
)

console.log(failed ? `\n${failed} failed` : '\nrender watch: all good')
process.exit(failed ? 1 : 0)
