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
  decide,
  fresh,
  afterAct,
  noteWedge
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
// The bug was that coming back looked like the end of the incident. It is not.
const responsive = main.slice(main.indexOf("on('responsive'"), main.indexOf("on('render-process-gone'"))
ok(
  'coming back does NOT forget the wedge - that reading is the leak',
  responsive !== '' && !/wedges\s*[=:]\s*0/.test(responsive),
  JSON.stringify(responsive.slice(0, 60))
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
