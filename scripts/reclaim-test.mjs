// Closing somebody's pane to get memory back, and every case where it must not.
//
// This is the most destructive thing the app does on its own, so - as with recover-test -
// the refusals are the file and the happy path is a handful of lines. The one that matters
// most is `needsYou`: an agent that asked a question and is waiting for an answer looks
// exactly like an idle pane, and closing it is the difference between tidying up and
// throwing somebody's work away.
//
//   node scripts/reclaim-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-reclaim-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'reclaim.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/reclaim.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { reclaimPlan, idleClosePlan, idleSleepPlan, idleCloseAt, unread, reclaimedMb, DEFAULT_RECLAIM, IDLE_CLOSE_MINUTES, IDLE_SLEEP_MINUTES } = createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const NOW = 1_000_000_000
const HOUR = 3_600_000
const over = { level: 'over', usedMb: 2530, nextPaneMb: 197, roomFor: null, trim: true, offload: false, advice: '' }
const tight = { ...over, level: 'tight', roomFor: 0 }
const ok = { ...over, level: 'ok', roomFor: 4, trim: false }

const pane = (o) => ({
  id: 'p',
  state: 'ready',
  lastKeyboard: NOW - 3 * HOUR,
  focused: false,
  visible: false,
  remote: false,
  ...o
})
const ids = (plan) => plan.map((p) => p.id).join(',')

{
  // The whole point: a machine the kernel says is out of memory, holding finished panes
  // nobody has looked at for hours.
  const panes = [
    pane({ id: 'a', lastOutput: NOW - 5 * HOUR }),
    pane({ id: 'b', lastOutput: NOW - 2 * HOUR }),
    pane({ id: 'c', focused: true, lastOutput: NOW })
  ]
  eq('the oldest quiet panes go first', ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 'a,b')
  eq('and it says what that bought', reclaimedMb(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 380)
  eq(
    'a tight machine reclaims too',
    ids(reclaimPlan(panes, tight, DEFAULT_RECLAIM, NOW)),
    'a,b'
  )
  eq('at most maxPerSweep at a time', reclaimPlan(panes, over, { ...DEFAULT_RECLAIM, maxPerSweep: 1 }, NOW).length, 1)
}

{
  // The trigger is pressure, never a clock. This is the line between reclaiming and
  // tidying up after somebody who did not ask to be tidied up after.
  const old = [pane({ id: 'a', lastOutput: NOW - 40 * HOUR }), pane({ id: 'b' })]
  eq('a healthy machine closes nothing, however old the pane', reclaimPlan(old, ok, DEFAULT_RECLAIM, NOW).length, 0)
  eq('off is off', reclaimPlan(old, over, { ...DEFAULT_RECLAIM, enabled: false }, NOW).length, 0)
}

{
  // Never somebody's business. A live QUESTION is the load-bearing one - the pane is quiet
  // BECAUSE it is waiting for a person, so every "is it idle" test in the app says yes
  // about it.
  for (const state of ['working', 'starting', 'stalled']) {
    const panes = [pane({ id: 'x', state }), pane({ id: 'keep' })]
    eq(`never closes a pane that is ${state}`, ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)), 'keep')
  }
  {
    const asked = [pane({ id: 'x', state: 'needsYou', asking: true }), pane({ id: 'keep' })]
    eq('never closes a pane holding a live question', ids(reclaimPlan(asked, over, DEFAULT_RECLAIM, NOW)), 'keep')
  }
  {
    // ...and the other half of `needsYou`, which is the only pane anybody ever wants
    // closed. The state is one word for two facts - an agent that ASKED something, and an
    // agent that FINISHED and is sitting at its composer - and refusing the state to
    // protect the first refused the second too. Measured on this desk 2026-08-20: every
    // pane on it was `needsYou`, so this sweep had never closed anything in its life.
    const done = [pane({ id: 'x', state: 'needsYou', asking: false }), pane({ id: 'keep' }), pane({ id: 'pad', lastKeyboard: NOW })]
    check('a FINISHED turn is closeable', ids(reclaimPlan(done, over, DEFAULT_RECLAIM, NOW)).includes('x'), ids(reclaimPlan(done, over, DEFAULT_RECLAIM, NOW)))
  }
}

{
  const panes = [
    pane({ id: 'focused', focused: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'visible', visible: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'mirror', remote: true, lastOutput: NOW - 9 * HOUR }),
    pane({ id: 'keep' })
  ]
  eq(
    'never the pane being read, one on screen, or another device s pty',
    ids(reclaimPlan(panes, over, DEFAULT_RECLAIM, NOW)),
    'keep'
  )
}

{
  // Idle time is a tie-break, not the trigger - but it is still a floor.
  const fresh = [pane({ id: 'a', lastKeyboard: NOW - 10 * 60_000 }), pane({ id: 'b', lastKeyboard: NOW })]
  eq('a pane quiet for ten minutes is not stale', reclaimPlan(fresh, over, DEFAULT_RECLAIM, NOW).length, 0)
  const justOver = [pane({ id: 'a', lastKeyboard: NOW - 16 * 60_000 }), pane({ id: 'b' })]
  check('one just past fifteen minutes is', reclaimPlan(justOver, over, DEFAULT_RECLAIM, NOW).length > 0)
}

{
  // An app that empties its own window under memory pressure has removed the reason the
  // window is open, not solved the problem.
  const one = [pane({ id: 'only', lastOutput: NOW - 9 * HOUR })]
  eq('never the last pane', reclaimPlan(one, over, DEFAULT_RECLAIM, NOW).length, 0)
  const two = [pane({ id: 'a', lastOutput: NOW - 9 * HOUR }), pane({ id: 'b', lastOutput: NOW - 8 * HOUR })]
  eq('one of two is fine', ids(reclaimPlan(two, over, DEFAULT_RECLAIM, NOW)), 'a')
}

{
  // An exited pane's process is already gone, so closing it returns a buffer and not an
  // agent. Worth doing, not worth claiming credit for.
  const gone = [pane({ id: 'dead', state: 'exited', lastOutput: NOW - 9 * HOUR }), pane({ id: 'keep' })]
  const plan = reclaimPlan(gone, over, DEFAULT_RECLAIM, NOW)
  eq('an exited pane is closeable', plan[0].id, 'dead')
  eq('but frees no agent', reclaimedMb([plan[0]]), 0)
}

{
  // The clock, for a machine with nobody at it. Off by default is the load-bearing half:
  // the desk somebody is sitting at must behave exactly as it did before this existed.
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 120 }
  const panes = [
    pane({ id: 'a', lastKeyboard: NOW - 5 * HOUR }),
    pane({ id: 'b', lastKeyboard: NOW - 3 * HOUR }),
    pane({ id: 'fresh', lastKeyboard: NOW - 30 * 60_000 })
  ]
  // It ships ON now - the card carries the countdown and the press that stops it, so the
  // close is visible for the whole wait rather than only in a mascot bubble in a corner.
  // Zero is still how it is turned off.
  eq('on by default', DEFAULT_RECLAIM.idleCloseMinutes, IDLE_CLOSE_MINUTES)
  // The number itself is asked for by name: it is what the Settings SWITCH writes, so it is
  // a user-visible duration and not an implementation detail. Robert, 2026-08-27: "the idle
  // close is 30 minutes and i want 10", then "actually sorry its 5 min".
  eq('...at five minutes', IDLE_CLOSE_MINUTES, 5)
  eq('off when the number is zero', idleClosePlan(panes, { ...DEFAULT_RECLAIM, idleCloseMinutes: 0 }, NOW).length, 0)
  eq('and off when reclaim itself is off', idleClosePlan(panes, { ...CLOCKED, enabled: false }, NOW).length, 0)
  eq('oldest quiet first, and only past the clock', ids(idleClosePlan(panes, CLOCKED, NOW)), 'a,b')
  eq('a pane inside the window is left alone', ids(idleClosePlan([panes[2], pane({ id: 'k', lastKeyboard: NOW })], CLOCKED, NOW)), '')

  // Every refusal the pressure sweep makes, this makes too - except `visible`, which is
  // the one it cannot keep: on a desk nobody is sitting at, every pane in the grid is "on
  // screen", and keeping it would mean the feature can never fire on the machine it was
  // built for.
  for (const state of ['working', 'starting', 'stalled']) {
    const p = [pane({ id: 'x', state, lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'keep', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })]
    check(
      `the clock never closes a pane that is ${state}`,
      !idleClosePlan(p, CLOCKED, NOW).some((r) => r.id === 'x'),
      ids(idleClosePlan(p, CLOCKED, NOW))
    )
  }
  {
    const p = [pane({ id: 'x', state: 'needsYou', asking: true, lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'keep', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })]
    check('the clock never closes a pane holding a live question', !idleClosePlan(p, CLOCKED, NOW).some((r) => r.id === 'x'), ids(idleClosePlan(p, CLOCKED, NOW)))
  }
  {
    // The pair that decides whether the clock can ever fire at all: with `needsYou`
    // refused outright it could only reach a CLI nobody had typed into, which on a real
    // desk is no pane at all.
    const p = [pane({ id: 'x', state: 'needsYou', asking: false, lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })]
    check('but a finished turn is exactly what it is for', idleClosePlan(p, CLOCKED, NOW).some((r) => r.id === 'x'), ids(idleClosePlan(p, CLOCKED, NOW)))
  }
  const guarded = [
    pane({ id: 'focused', focused: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'mirror', remote: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'seen', visible: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'pad', lastKeyboard: NOW })
  ]
  eq(
    'never the focused pane and never another device s pty - but a drawn one nobody has typed into for hours IS closed',
    ids(idleClosePlan(guarded, CLOCKED, NOW)),
    'seen'
  )
  eq('never the last pane', idleClosePlan([pane({ id: 'only', lastKeyboard: NOW - 9 * HOUR })], CLOCKED, NOW).length, 0)
  eq(
    'at most maxPerSweep at a time',
    idleClosePlan(
      [pane({ id: 'a', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'b', lastKeyboard: NOW - 8 * HOUR }), pane({ id: 'c', lastKeyboard: NOW - 7 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })],
      { ...CLOCKED, maxPerSweep: 1 },
      NOW
    ).length,
    1
  )
  // A config written by an older build has no such field at all, and reading `undefined`
  // as "close everything that is older than never" would be the worst possible default.
  const legacy = { enabled: true, minIdleMinutes: 15, maxPerSweep: 2 }
  eq('a config from before this feature closes nothing', idleClosePlan(panes, legacy, NOW).length, 0)
}

// The pane that was closed mid-answer on 2026-08-21, in both sweeps.
//
// A person types one prompt and walks away; the agent works for two hours. `lastKeyboard`
// has not moved in those two hours, so every idle reading in the app said "quiet since
// this morning" about a pane that had never stopped printing - and `status` needs only
// four seconds of silence with no readable footer to call the turn finished, so one pause
// inside a long turn made it `needsYou` and the countdown started over a live session.
//
// The load-bearing half is the CONTROL beneath each: the same pane with its output as old
// as its keystrokes is still closed, or these pass by refusing everything.
{
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 120 }
  const working = pane({ id: 'x', state: 'needsYou', lastKeyboard: NOW - 9 * HOUR, lastOutput: NOW - 2000 })
  // ...and read: `lastFocus` after the last byte, or the unread refusal below holds it and
  // this control proves nothing about output.
  const finished = pane({
    id: 'x',
    state: 'needsYou',
    lastKeyboard: NOW - 9 * HOUR,
    lastOutput: NOW - 9 * HOUR,
    lastFocus: NOW - 8 * HOUR
  })
  const pad = pane({ id: 'pad', lastKeyboard: NOW, lastOutput: NOW })
  eq('the clock never closes a pane that is still printing', idleClosePlan([working, pad], CLOCKED, NOW).length, 0)
  eq('...and the control: the same pane, actually quiet, IS closed', ids(idleClosePlan([finished, pad], CLOCKED, NOW)), 'x')
  eq('pressure never closes a pane that is still printing', reclaimPlan([working, pad], over, DEFAULT_RECLAIM, NOW).length, 0)
  eq(
    '...and the control under pressure',
    ids(reclaimPlan([finished, pad], over, DEFAULT_RECLAIM, NOW)),
    'x'
  )
  const busy = pane({ id: 'x', state: 'needsYou', lastKeyboard: NOW - 9 * HOUR, lastOutput: NOW - 9 * HOUR, busy: true })
  eq('a run clock that is still going is a refusal of its own', idleClosePlan([busy, pad], CLOCKED, NOW).length, 0)
  eq('and under pressure too', reclaimPlan([busy, pad], over, DEFAULT_RECLAIM, NOW).length, 0)
}


{
  // ---------------------------------------------------------------------------
  // The deadline the CARD draws. Its whole job is to agree with the sweep: a countdown on
  // a pane nothing will close is a threat the app does not carry out, and a pane closing
  // with no countdown in front of it is what the countdown exists to prevent.
  // ---------------------------------------------------------------------------
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 60 }
  const quiet = pane({ id: 'q', lastKeyboard: NOW - 30 * 60_000 })
  eq('the deadline is quiet-since plus the setting', idleCloseAt(quiet, CLOCKED, NOW), NOW - 30 * 60_000 + 60 * 60_000)
  eq('nothing to draw with the clock off', idleCloseAt(quiet, { ...CLOCKED, idleCloseMinutes: 0 }, NOW), null)
  eq('nor with reclaim itself off', idleCloseAt(quiet, { ...CLOCKED, enabled: false }, NOW), null)

  // A pane already past its deadline is due NOW, never overdue: the sweep runs on a minute
  // timer, so `now` is regularly a little past the moment, and a chip counting UP from zero
  // reads as a clock that has jammed.
  const late = pane({ id: 'late', lastKeyboard: NOW - 5 * HOUR })
  eq('a pane past its deadline is due now, not overdue', idleCloseAt(late, CLOCKED, NOW), NOW)

  // The refusals, and the shell one is the reason this was asked for: a pane running
  // `npm run build` and a pane that has finished look identical in the sidebar, and
  // `paneJob.ts` is the only thing that tells them apart (through `runSince` -> busy).
  eq('a shell pane still running a command has no deadline', idleCloseAt(pane({ id: 'b', busy: true, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  eq('nor does a pane holding a question', idleCloseAt(pane({ id: 'a', state: 'needsYou', asking: true, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  eq('nor the pane being looked at', idleCloseAt(pane({ id: 'f', focused: true, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  eq('nor another device pty', idleCloseAt(pane({ id: 'r', remote: true, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  eq('nor one already being moved', idleCloseAt(pane({ id: 'h', handingOff: true, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  for (const state of ['working', 'starting', 'stalled']) {
    eq(`nor one that is ${state}`, idleCloseAt(pane({ id: 'x', state, lastKeyboard: NOW - 5 * HOUR }), CLOCKED, NOW), null)
  }

  // ...and the two must not drift: everything the sweep closes had a deadline, and it had
  // already passed. This is the assertion that fails if either side grows a refusal the
  // other does not have.
  const many = [
    pane({ id: 'a', lastKeyboard: NOW - 5 * HOUR }),
    pane({ id: 'b', lastKeyboard: NOW - 3 * HOUR }),
    pane({ id: 'busy', busy: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'ask', state: 'needsYou', asking: true, lastKeyboard: NOW - 9 * HOUR }),
    pane({ id: 'fresh', lastKeyboard: NOW })
  ]
  for (const r of idleClosePlan(many, CLOCKED, NOW)) {
    const p = many.find((m) => m.id === r.id)
    check(`${r.id} was counted down before it was closed`, idleCloseAt(p, CLOCKED, NOW) === NOW, String(idleCloseAt(p, CLOCKED, NOW)))
  }
  check('and a pane with no deadline is never in the plan', !idleClosePlan(many, CLOCKED, NOW).some((r) => idleCloseAt(many.find((m) => m.id === r.id), CLOCKED, NOW) === null))
}


// A shell pane running a BACKGROUND command.
//
// `busy` is set from `runSince`, which on POSIX is set from the tty's FOREGROUND process -
// and `cmd &` leaves the shell itself in front of the tty. So a pane with two monitors
// running in it reported `busy: false` and the clock started on it (2026-08-24: "1 shell 2
// monitors running in session 2, why is it trying to close it"). `job` is the second,
// independent reading; the load-bearing case is that it refuses ON ITS OWN, with `busy`
// false, because that is exactly the shape the bug had.
{
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: IDLE_CLOSE_MINUTES }
  const HOURS = 5 * 60 * 60 * 1000
  const withJob = pane({ id: 'mon', job: 'monitor', busy: false, lastKeyboard: NOW - HOURS })
  const noJob = pane({ id: 'plain', job: null, busy: false, lastKeyboard: NOW - HOURS })

  eq('a background job refuses the clock with busy false', idleCloseAt(withJob, CLOCKED, NOW), null)
  check('...and the idle sweep leaves it alone', !idleClosePlan([withJob, noJob], CLOCKED, NOW).some((r) => r.id === 'mon'))
  // The control: without the job that same pane IS closeable, or the assertion above would
  // pass on a plan that closes nothing at all.
  check('control - the same pane with no job is closed', idleClosePlan([withJob, noJob], CLOCKED, NOW).some((r) => r.id === 'plain'))

  const CRITICAL = { level: 'critical', mb: 0, panes: 0 }
  check('and the pressure sweep refuses it too', !reclaimPlan([withJob, noJob], CRITICAL, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'mon'))
}

// ...and the same thing for what an AGENT pane left running, which is a different reading
// again (`shared/paneBackJobs.ts`, off the usage sampler's process table). `job` refuses to
// speak about an agent pane at all, so a `run_in_background` build, a Monitor loop or an
// `npm run build` an agent started went completely unseen here: the turn ends, the footer
// stops, `engaged` drops, the card reads finished, and the ladder closed the pane on top of
// work that was still going. Robert, 2026-08-27: "it shouldnt close or clear mid build".
{
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: IDLE_CLOSE_MINUTES }
  const HOURS = 5 * 60 * 60 * 1000
  const building = pane({
    id: 'build',
    job: null,
    backJob: 'npm run build',
    busy: false,
    lastKeyboard: NOW - HOURS
  })
  const done = pane({ id: 'done', job: null, backJob: null, busy: false, lastKeyboard: NOW - HOURS })

  eq('a background job an agent started refuses the clock', idleCloseAt(building, CLOCKED, NOW), null)
  check(
    '...and the idle sweep leaves it alone',
    !idleClosePlan([building, done], CLOCKED, NOW).some((r) => r.id === 'build')
  )
  // The control, exactly as above: without it that same pane closes.
  check(
    'control - the same pane with nothing running is closed',
    idleClosePlan([building, done], CLOCKED, NOW).some((r) => r.id === 'done')
  )
  const CRIT = { level: 'critical', mb: 0, panes: 0 }
  check(
    'and the pressure sweep refuses it too',
    !reclaimPlan([building, done], CRIT, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'build')
  )
  check(
    'control - pressure still closes the finished one',
    reclaimPlan([building, done], CRIT, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'done')
  )
}

// Looking at a pane is USING it, and this is the bug that made the whole clock read as
// broken: `quietSince` counted from the last keystroke while the pane sat focused on
// screen, so a pane read for ten minutes was already past its five-minute deadline the
// instant the keyboard moved elsewhere. Its card's first word about it was a red
// `closes 0:01` - a countdown nobody can act on. Robert, 2026-08-24: "some bug when i
// opened session it showed red with 0:01 to close i think then after that countdown
// started". The focused pane is refused by every rule here already; the only thing missing
// was the moment focus LEFT.
{
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 60 }
  const read = pane({ id: 'read', lastKeyboard: NOW - 10 * 60_000, lastFocus: NOW - 1000 })
  eq(
    'a pane the keyboard has just left starts its clock there, not at the last keystroke',
    idleCloseAt(read, CLOCKED, NOW),
    NOW - 1000 + 60 * 60_000
  )
  check(
    'so the sweep leaves it alone and takes the genuinely quiet one',
    ids(idleClosePlan([read, pane({ id: 'other', lastKeyboard: NOW - 5 * HOUR })], CLOCKED, NOW)) === 'other'
  )
  // CONTROL: the same pane with no focus reading at all is the old behaviour - overdue on
  // the spot, which is what the report was.
  const blind = pane({ id: 'read', lastKeyboard: NOW - 10 * HOUR })
  eq('CONTROL: with nothing but keystrokes it is due at once', idleCloseAt(blind, CLOCKED, NOW), NOW)
  // ...and focus is not a way to keep a pane alive for ever: left an hour ago, it is due.
  const left = pane({ id: 'left', lastKeyboard: NOW - 5 * HOUR, lastFocus: NOW - 2 * HOUR })
  eq('a pane left two hours ago is due', idleCloseAt(left, CLOCKED, NOW), NOW)
  check(
    'and the sweep and the card agree about it',
    idleClosePlan([left, pane({ id: 'keep', lastKeyboard: NOW })], CLOCKED, NOW).map((r) => r.id).join() === 'left'
  )
}

// "Keep this pane open" - a person overruling the clock outright, not for an hour.
// `keptUntil` is the hour-long hold the countdown chip arms and it is the right answer for
// "not now"; a pane holding something the app has no reading for (a watcher, a paragraph
// somebody is part way through) needs "not ever", or the clock starts again an hour later.
// Robert, 2026-08-24: "you can make it so stops closing in 5min timer always keeps
// starting". It refuses BOTH sweeps: a person who said keep this one did not mean unless
// memory is tight.
{
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 60 }
  const kept = pane({ id: 'kept', pinned: true, lastKeyboard: NOW - 5 * HOUR })
  const plain = pane({ id: 'plain', lastKeyboard: NOW - 5 * HOUR })
  eq('a pinned pane has no deadline at all', idleCloseAt(kept, CLOCKED, NOW), null)
  check('CONTROL: the same pane unpinned is due now', idleCloseAt(plain, CLOCKED, NOW) === NOW)
  check('the clock leaves it and takes the other', ids(idleClosePlan([kept, plain], CLOCKED, NOW)) === 'plain')
  const CRIT = { level: 'critical', mb: 0, panes: 0 }
  check(
    'and pressure does not overrule it either',
    !reclaimPlan([kept, plain], CRIT, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'kept')
  )
  check(
    'CONTROL: pressure does close the unpinned one',
    reclaimPlan([kept, plain], CRIT, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'plain')
  )
}

// -- Nobody at the machine: the clock freezes rather than running through the absence. ---
//
// Robert, 2026-08-24: "i wasnt at my laptop for like 10 mins and all tabs closed because i
// wasnt here to stop it". The countdown is only honest while somebody could act on it, so
// while the OS reports no input it is frozen at the moment they left. The load-bearing
// half is the two negatives: a machine no person has ever touched (the second desk this
// feature exists for) must keep today's behaviour exactly, and the pause may only ever
// DELAY a close - it can never resurrect a pane that was already due.
{
  const awayFile = join(work, 'away.bundle.cjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: ['src/shared/away.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: awayFile
  })
  const { readAway, deskNow, NOBODY_YET, AWAY_AFTER_MS } = createRequire(import.meta.url)(awayFile)

  const here = readAway(NOBODY_YET, 0, NOW)
  eq('typing here means nobody is away', here.awaySince, null)
  eq('...and that a person has been seen', here.sawPerson, true)

  const gone = readAway(here, 10 * 60_000, NOW)
  eq('ten minutes of no input is away, stamped where they left', gone.awaySince, NOW - 10 * 60_000)
  const back = readAway(gone, 5_000, NOW)
  eq('a mouse move ends it', back.awaySince, null)

  eq('a few seconds of stillness is not away', readAway(here, AWAY_AFTER_MS - 1, NOW).awaySince, null)

  // The second desk. Nobody has ever touched its own keyboard, so there is nobody to be
  // away and nothing pauses - the machine this whole clock was turned on for.
  const desk2 = readAway(NOBODY_YET, 6 * HOUR, NOW)
  eq('a machine no person has touched is never "away"', desk2.awaySince, null)
  eq('...and still has not seen anybody', desk2.sawPerson, false)

  eq('present: the clock is wall time', deskNow(NOW, null), NOW)
  eq('away: the clock is frozen where they left', deskNow(NOW, NOW - 10 * 60_000), NOW - 10 * 60_000)
  eq('a clock ahead of now is clamped, never rewound forward', deskNow(NOW, NOW + HOUR), NOW)

  // What it buys, through the sweep itself: five minutes' work, then ten minutes away.
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 10 }
  const left = NOW - 10 * 60_000
  const p = pane({ id: 'coffee', lastKeyboard: left - 5 * 60_000 })
  check('CONTROL: wall time closes it', ids(idleClosePlan([p, pane({ id: 'other', lastKeyboard: NOW })], CLOCKED, NOW)) === 'coffee')
  check(
    'the frozen clock does not',
    idleClosePlan([p, pane({ id: 'other', lastKeyboard: NOW })], CLOCKED, deskNow(NOW, left)).length === 0
  )
  eq(
    'and the card counts down to the same frozen moment',
    idleCloseAt(p, CLOCKED, deskNow(NOW, left)),
    left - 5 * 60_000 + 10 * 60_000
  )
  // The pause holds a pane that was still counting; it does not undo a decision.
  const overdue = pane({ id: 'overdue', lastKeyboard: left - 60 * 60_000 })
  check(
    'a pane already past its deadline when they left still goes',
    ids(idleClosePlan([overdue, pane({ id: 'other', lastKeyboard: NOW })], CLOCKED, deskNow(NOW, left))) === 'overdue'
  )
}

{
  // A turn nobody has read has no countdown in front of it. Robert, 2026-08-27: "if you
  // havent read the output then the closes in countdown wont start".
  const CLOCKED = { ...DEFAULT_RECLAIM, idleCloseMinutes: 10 }
  // Printed an hour ago, and the keyboard has not been at it since (it left two hours ago).
  const fresh = pane({
    id: 'unread',
    lastKeyboard: NOW - 3 * HOUR,
    lastFocus: NOW - 2 * HOUR,
    lastOutput: NOW - HOUR
  })
  // Same pane, looked at AFTER the output landed.
  const seen = pane({
    id: 'seen',
    lastKeyboard: NOW - 3 * HOUR,
    lastOutput: NOW - 2 * HOUR,
    lastFocus: NOW - HOUR
  })

  check('output printed since the keyboard left is unread', unread(fresh))
  check('CONTROL: output the keyboard came back to is read', !unread(seen))
  check('a pane with no output at all is not unread', !unread(pane({})))

  eq('an unread pane has no deadline at all', idleCloseAt(fresh, CLOCKED, NOW), null)
  eq(
    'CONTROL: the read one is due, counting from the moment the keyboard left it',
    idleCloseAt(seen, CLOCKED, NOW),
    NOW
  )
  eq('the clock leaves the unread one and takes the read one', ids(idleClosePlan([fresh, seen], CLOCKED, NOW)), 'seen')

  // The refusal holds the CLOCK only. Under real memory pressure holding an unread pane
  // open is the more expensive of the two mistakes, so that sweep is untouched.
  check(
    'CONTROL: real pressure still closes an unread pane',
    reclaimPlan([fresh, seen], over, DEFAULT_RECLAIM, NOW).some((r) => r.id === 'unread')
  )

  // ...and on a machine no person has touched this run, nothing is ever read, so the
  // refusal would switch the whole feature off on the one desk it exists for.
  // Both are eligible there, and the last-pane rule keeps one back - so the answer is the
  // unread one, which is exactly the pane the refusal above was holding.
  eq('a desk with nobody at it closes it anyway', ids(idleClosePlan([fresh, seen], CLOCKED, NOW, false)), 'unread')
  eq('...and its card counts down', idleCloseAt(fresh, CLOCKED, NOW, false), NOW)
}

// ------------------------------------------------ the rung above closing: sleeping
// A pane nobody has used gives its agent back and keeps its card. It is ON by default,
// which is only defensible because being wrong is cheap: the card, its place, its screen
// and its conversation all survive, so the weight here is that it refuses everything the
// close clock refuses - and, unlike that one, that it does NOT keep a pane back or cap
// the sweep, because it empties nothing.
{
  const SLEEPY = { ...DEFAULT_RECLAIM, idleSleepMinutes: 30 }
  eq('on by default', DEFAULT_RECLAIM.idleSleepMinutes, IDLE_SLEEP_MINUTES)
  eq('...at half an hour', IDLE_SLEEP_MINUTES, 30)
  // A config written by an older build has no such field at all, and that must read as the
  // default rather than as "never" (undefined) or "immediately" (0).
  const older = { ...DEFAULT_RECLAIM }
  delete older.idleSleepMinutes
  eq(
    'a config from before this existed gets the default, not silence',
    ids(idleSleepPlan([pane({ id: 'old', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })], older, NOW)),
    'old'
  )
  eq('off when the number is zero', idleSleepPlan([pane({ id: 'a', lastKeyboard: NOW - 9 * HOUR })], { ...SLEEPY, idleSleepMinutes: 0 }, NOW).length, 0)
  eq('and off when reclaim itself is off', idleSleepPlan([pane({ id: 'a', lastKeyboard: NOW - 9 * HOUR })], { ...SLEEPY, enabled: false }, NOW).length, 0)
  eq(
    'a pane inside the window is left alone',
    ids(idleSleepPlan([pane({ id: 'fresh', lastKeyboard: NOW - 29 * 60_000 })], SLEEPY, NOW)),
    ''
  )
  // The two the close clock does that this must not.
  eq(
    'the LAST pane may sleep - sleeping empties no window',
    ids(idleSleepPlan([pane({ id: 'only', lastKeyboard: NOW - 9 * HOUR })], SLEEPY, NOW)),
    'only'
  )
  eq(
    'and the sweep is not capped, because nothing here depends on re-reading the machine',
    idleSleepPlan(
      [
        pane({ id: 'a', lastKeyboard: NOW - 9 * HOUR }),
        pane({ id: 'b', lastKeyboard: NOW - 8 * HOUR }),
        pane({ id: 'c', lastKeyboard: NOW - 7 * HOUR })
      ],
      { ...SLEEPY, maxPerSweep: 1 },
      NOW
    ).length,
    3
  )
  // ...and every refusal it shares with the close clock, which is the rest of them.
  for (const [what, extra] of [
    ['is working', { state: 'working' }],
    ['is starting', { state: 'starting' }],
    ['is stalled', { state: 'stalled' }],
    ['holds a live question', { state: 'needsYou', asking: true }],
    ['is the one being looked at', { focused: true }],
    ['belongs to another machine', { remote: true }],
    ['is being handed over', { handingOff: true }],
    ['is running a command', { job: 'npm' }],
    ['left a background job', { backJob: 'npm' }],
    ['somebody said to keep open', { pinned: true }],
    ['is already asleep', { asleep: NOW - HOUR }]
  ]) {
    const p = [pane({ id: 'x', lastKeyboard: NOW - 9 * HOUR, ...extra }), pane({ id: 'pad', lastKeyboard: NOW })]
    check(`never a pane that ${what}`, !idleSleepPlan(p, SLEEPY, NOW).some((r) => r.id === 'x'), ids(idleSleepPlan(p, SLEEPY, NOW)))
  }
  // The control: the same pane with none of those true really is slept, or every line
  // above passes for the wrong reason.
  eq(
    'a quiet finished pane IS slept',
    ids(idleSleepPlan([pane({ id: 'x', state: 'needsYou', lastKeyboard: NOW - 9 * HOUR }), pane({ id: 'pad', lastKeyboard: NOW })], SLEEPY, NOW)),
    'x'
  )
  // A pane that has printed since the keyboard left it has not been READ yet, and the same
  // refusal the close clock makes is made here - while there is somebody here to read it.
  // Quiet for two hours (so it is well past the clock) but it PRINTED after the keyboard
  // last left it, which is the whole of `unread`.
  // ...and the ONE refusal it does not share, which is the difference between the two
  // rungs: `unread` is about a pane VANISHING before somebody has seen its last turn, and
  // sleeping vanishes nothing. A pane never focused at all is unread for ever
  // (`lastFocus` undefined), so keeping it would make this clock inert - measured on this
  // machine at a one-minute setting: two eligible panes, quiet 126s, neither slept.
  const unreadPane = pane({ id: 'unread', lastKeyboard: NOW - 9 * HOUR, lastOutput: NOW - 2 * HOUR, lastFocus: NOW - 5 * HOUR })
  check('the close clock refuses a turn nobody has read yet', unread(unreadPane), '')
  eq('...and the sleep clock takes it, because nothing goes away', ids(idleSleepPlan([unreadPane], SLEEPY, NOW)), 'unread')
  eq(
    'a pane nobody has ever focused is not held back either',
    ids(idleSleepPlan([pane({ id: 'never', lastKeyboard: NOW - 9 * HOUR, lastOutput: NOW - 9 * HOUR })], SLEEPY, NOW)),
    'never'
  )
}

// The wiring: a plan nothing calls sleeps nothing.
{
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  check('the desk runs the sleep sweep', /idleSleepPlan\(/.test(app), '')
  check('...and it really sleeps the panes it names', /for \(const p of plan\) void api\.sleepSession\(p\.id\)/.test(app), '')
  check(
    'and "Sleep this pane" is gone from the card menu - the clock does it',
    !/key: 'sleep'/.test(app),
    ''
  )
}

// A slept pane still has a SHAPE, and the pane it wakes into must be that shape.
//
// `sleep()` gives a pane `status: 'exited'`, and `resize()` used to drop every call for an
// exited session - so a sleeping pane's grid froze at whatever it was spawned with while
// the renderer went on fitting the terminal to its own box, and `wake()` spawned the CLI
// at the frozen number. Everything an agent prints is absolute column moves and a terminal
// clamps a column it cannot reach, so the woken pane painted one word over the last down
// its right-hand edge. Measured 2026-08-29 with `npm run boot-timing --panes 8`: 4 of 7
// restored panes ended with the terminal at 26x17 and the pty recorded at 120x30, and 7 of
// 7 agree with the guard below. Red-proof it by putting `s.meta.status === 'exited'` back
// on its own.
{
  const src = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const guard = /if \(!s \|\| \(s\.meta\.status === 'exited' && !s\.meta\.asleep\)\) return/.test(src)
  check('a resize is recorded for an asleep pane, and only a dead one is dropped', guard, '')
  check(
    '...and waking one spawns at the grid it was kept at',
    /live\.proc = this\.spawn\(live\.req, live\.meta\.agent, live\.cols, live\.rows/.test(src),
    ''
  )
}

console.log(`reclaim: ${checks} checks passed`)
