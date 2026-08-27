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
  decide,
  fresh,
  afterAct
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
const after = afterAct(w({ unresponsiveSince: T - GRACE_MS, probeSentAt: T - PROBE_DEAD_MS, gone: true }), T)
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
