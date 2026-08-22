// What the app is allowed to promise about this machine, and what it gives up first.
//
// Worth its own test because every failure mode here is one the user pays for silently.
// A model that over-promises invites the pane that starts the thrash; one that
// under-promises nags a machine that was fine; and a trim plan with an off-by-one in the
// focus rule shortens the scrollback of the pane somebody is reading, which destroys the
// record of an agent turn with no undo and no error message.
//
// The pressure branch is the one that matters most: a machine can be thrashing at 40% of
// its RAM because of what runs beside the app (measured 2026-08-14: ~4 GB of browser and
// a 1442 MB `next build` on a 16 GB laptop), so the kernel's verdict has to beat the
// arithmetic every time they disagree.
//
//   node scripts/capacity-test.mjs

import { buildSync } from 'esbuild'
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// esbuild, not a regex over the source. This used to strip type annotations with a list of
// every type name in the file, which is a test that goes red on the SYNTAX of a change
// rather than on its behaviour: a return type the list did not know about (`Verdict['why']`,
// `number | undefined`) left half an annotation behind and the module failed to parse, so
// the failure named a line number and said nothing about capacity at all. Same approach as
// autohandoff-test, against the same real source.
const dir = join(tmpdir(), 'paneforge-capacity-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'capacity.mjs')
buildSync({
  absWorkingDir: join(here, '..'),
  entryPoints: ['src/shared/capacity.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: mod
})
const {
  assess,
  trimPlan,
  paneCostMb,
  savingMb,
  SESSION_MB,
  BUFFER_MB_PER_1K,
  FULL_SCROLLBACK,
  TRIMMED_SCROLLBACK,
  offloadTarget,
  offloadPlan,
  lagLevel,
  keepLocalOf,
  worstPressure,
  LAG_WARN,
  LAG_HARD,
  restorePlan,
  stickFor,
  OFFLOAD_STICK_MS,
  projectNameOf
} = await import('file://' + mod.replace(/\\/g, '/'))

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}
const GB = 1024
const machine = (o) => ({ totalMb: 16 * GB, pressure: 'normal', localPanes: 0, ...o })

// ---------------------------------------------------------------- the measured costs

// These three assertions are the whole point of the module being honest. If somebody
// changes a constant, the number the UI shows the user changes with it, and the comment
// in capacity.ts citing the measurement stops being true.
ok('an agent pane costs its CLI plus its buffer', paneCostMb(20000) === Math.round(SESSION_MB + 7.2))
ok('the agent dominates: buffer is under 4% of a pane', 7.2 / paneCostMb(20000) < 0.04)
ok('a mirrored pane costs only its buffer', paneCostMb(20000, false) === 7)
ok('trimming to 2000 lines costs 1 MB', Math.round((TRIMMED_SCROLLBACK / 1000) * BUFFER_MB_PER_1K) === 1)
ok('an empty pane is just the agent', paneCostMb(0) === SESSION_MB)
ok('a negative scrollback cannot credit memory back', paneCostMb(-5000) === SESSION_MB)

// ---------------------------------------------------------------- room on a healthy box

const idle = assess(machine({ localPanes: 0 }))
ok('an empty desk is ok', idle.level === 'ok')
ok('and reports the app base only', idle.usedMb === 250, `got ${idle.usedMb}`)
ok('16 GB at rest has room for panes', idle.roomFor > 10, `got ${idle.roomFor}`)

const six = assess(machine({ localPanes: 6 }))
ok('six panes on a quiet 16 GB is still ok', six.level === 'ok', six.advice)
ok('six panes cost about 1.4 GB', six.usedMb > 1300 && six.usedMb < 1500, `got ${six.usedMb}`)
ok('the advice carries a number, not an adjective', /\d/.test(six.advice))

// A small machine must run out where a big one does not - the same pane count, a
// different verdict, driven only by totalMb.
const small = assess({ totalMb: 8 * GB, pressure: 'normal', localPanes: 16 })
ok('16 panes on 8 GB is not ok', small.level !== 'ok', small.advice)
const big = assess({ totalMb: 64 * GB, pressure: 'normal', localPanes: 16 })
ok('the same 16 panes on 64 GB is fine', big.level === 'ok', big.advice)

// ---------------------------------------------------------------- the kernel beats the sums

// This is the case the whole module exists for: few panes, plenty of RAM on paper, and a
// machine that is already thrashing because of everything else running on it.
const thrash = assess(machine({ localPanes: 6, pressure: 'warn' }))
ok('a warn from the kernel outranks the arithmetic', thrash.level === 'tight', thrash.advice)
ok('and it asks for a trim', thrash.trim === true)
ok('warn never promises more than one more pane', thrash.roomFor <= 1, `got ${thrash.roomFor}`)

const crit = assess(machine({ localPanes: 6, pressure: 'critical' }))
ok('critical is over, whatever the sums say', crit.level === 'over')
ok('critical refuses to name a number of free slots', crit.roomFor === null)
ok('critical still reports what is being held', crit.usedMb > 0 && /MB/.test(crit.advice))

// ---------------------------------------------------------------- offload

ok('no peer, no offload advice', crit.offload === false)
const withPeer = assess(machine({ localPanes: 6, pressure: 'critical', peerAvailable: true }))
ok('a paired device turns the advice into an action', withPeer.offload === true)
ok('and the advice names it', /paired device/.test(withPeer.advice), withPeer.advice)
ok('a healthy machine never nags about the peer',
  assess(machine({ localPanes: 1, peerAvailable: true })).offload === false)

// Mirrored panes are the cheap ones - the point of offloading. Twenty of them must not
// push the machine over when twenty local ones would.
const mirrored = assess(machine({ localPanes: 1, remotePanes: 20 }))
const local = assess(machine({ localPanes: 21 }))
ok('20 mirrored panes cost far less than 20 local ones', mirrored.usedMb * 4 < local.usedMb,
  `${mirrored.usedMb} vs ${local.usedMb}`)
ok('and stay ok where local ones do not', mirrored.level === 'ok' && local.level !== 'ok')

// ---------------------------------------------------------------- the trim plan

const panes = [
  { id: 'focused', focused: true, visible: true },
  { id: 'onscreen', focused: false, visible: true },
  { id: 'offscreen', focused: false, visible: false }
]
const at = (plan, id) => plan.find((t) => t.id === id)

const none = trimPlan(panes, assess(machine({ localPanes: 3 })))
ok('a healthy machine trims nothing', none.length === 0)

const warnPlan = trimPlan(panes, thrash)
ok('warn trims the off-screen pane', at(warnPlan, 'offscreen')?.scrollback === TRIMMED_SCROLLBACK)
ok('warn spares a visible pane', at(warnPlan, 'onscreen') === undefined)
ok('warn never touches the focused pane', at(warnPlan, 'focused') === undefined)

const critPlan = trimPlan(panes, crit)
ok('critical also trims the visible unfocused pane', at(critPlan, 'onscreen')?.scrollback === TRIMMED_SCROLLBACK)
ok('critical STILL never touches the focused pane', at(critPlan, 'focused') === undefined,
  JSON.stringify(critPlan))
ok('the plan only lists panes that change', critPlan.length === 2)

// Recovery: pressure passes and the short panes are allowed to grow back. Without this a
// laptop that was briefly busy would stay permanently degraded.
const restore = trimPlan(panes, assess(machine({ localPanes: 3 })), TRIMMED_SCROLLBACK)
ok('when pressure passes, trimmed panes are restored', restore.length === 3)
ok('restored to the full depth', restore.every((t) => t.scrollback === FULL_SCROLLBACK))
ok('the focused pane is restored too', at(restore, 'focused')?.scrollback === FULL_SCROLLBACK)
ok('nothing to restore is still a no-op', trimPlan(panes, assess(machine({ localPanes: 3 }))).length === 0)

// A trim that frees nothing worth having should be visible as such.
ok('the saving is reported in MB', savingMb(critPlan) === Math.round(2 * (18000 / 1000) * BUFFER_MB_PER_1K),
  `got ${savingMb(critPlan)}`)
ok('an empty plan saves nothing', savingMb([]) === 0)

// ---------------------------------------------------------------- edges

ok('zero panes under critical pressure still says over',
  assess(machine({ localPanes: 0, pressure: 'critical' })).level === 'over')
ok('a tiny machine does not produce a negative room count',
  assess({ totalMb: 512, pressure: 'normal', localPanes: 4 }).roomFor === 0)
ok('an empty pane list plans nothing', trimPlan([], crit).length === 0)


// ------------------------------------------------- where the next pane should start
//
// `offload` was computed and consumed by nothing for as long as the feature existed, so
// these cover the executing half. Every refusal here is a real failure that reached a
// user: a pane started on a path the other machine does not have opens nothing.

const PEER = (o = {}) => ({
  device: 'pc-1',
  deviceName: 'DESKTOP-CMSUCM1',
  online: true,
  projects: [{ name: 'toolstash', path: 'C:\\Users\\Gamer\\Desktop\\Projects\\toolstash' }],
  ...o
})
const full = assess(machine({ pressure: 'critical', localPanes: 6, peerAvailable: true }))
const roomy = assess(machine({ pressure: 'normal', localPanes: 1, peerAvailable: true }))

ok('a full machine with a peer that has the project offloads', !!offloadTarget(full, [PEER()], 'toolstash'))
ok(
  'and it starts on THAT machine\'s path, never this one\'s',
  offloadTarget(full, [PEER()], 'toolstash')?.cwd === 'C:\\Users\\Gamer\\Desktop\\Projects\\toolstash',
  offloadTarget(full, [PEER()], 'toolstash')?.cwd
)
ok('a machine with room keeps its own panes', offloadTarget(roomy, [PEER()], 'toolstash') === null)
ok(
  'a peer that does not have the project is never used',
  offloadTarget(full, [PEER()], 'secondtonone') === null
)
ok('an offline peer is never used', offloadTarget(full, [PEER({ online: false })], 'toolstash') === null)
ok('no peers at all is not an offload', offloadTarget(full, [], 'toolstash') === null)
ok('the setting turns it off outright', offloadTarget(full, [PEER()], 'toolstash', false) === null)
ok('an empty project name never matches', offloadTarget(full, [PEER({ projects: [{ name: '', path: 'C:\\x' }] })], '') === null)
ok(
  'the first online peer that has it wins',
  offloadTarget(full, [PEER({ online: false }), PEER({ device: 'pc-2', deviceName: 'Second' })], 'toolstash')?.device === 'pc-2'
)

// ------------------------------------------------------- who decides where it starts
//
// The move itself was already right; what was missing was the person. Every case below
// is one where getting it wrong costs something real: a pane silently on the other
// machine (the files being edited are HERE), or a dialog on every launch of a busy hour.
const TARGET = { device: 'pc', deviceName: 'Gamer-PC', cwd: 'C:\\x' }
const NOW = 1_000_000

ok('nowhere to send it is never a question', offloadPlan(null, true, null, NOW) === 'local')
ok('asking on by default puts it on screen', offloadPlan(TARGET, true, null, NOW) === 'ask')
ok('asking off keeps the old silent move', offloadPlan(TARGET, false, null, NOW) === 'remote')
ok(
  'a remembered "keep it here" is obeyed, and is not the same as no peer',
  offloadPlan(TARGET, true, stickFor('local', 'pc', NOW), NOW + 60_000) === 'local'
)
ok(
  'a remembered "send it" stops asking',
  offloadPlan(TARGET, true, stickFor('remote', 'pc', NOW), NOW + 60_000) === 'remote'
)
ok(
  'and it expires - the burst is over, so the question comes back',
  offloadPlan(TARGET, true, stickFor('remote', 'pc', NOW), NOW + OFFLOAD_STICK_MS + 1) === 'ask'
)
ok(
  'a remembered "send it" with nowhere to send it is still local',
  offloadPlan(null, true, stickFor('remote', 'pc', NOW), NOW + 1) === 'local'
)

// The three below are the review's confirmed findings, each kept as a case: every one of
// them moved a pane somewhere the person had not been shown, wearing their own approval.
ok(
  'a "yes" about one device does not authorise a second one',
  offloadPlan({ ...TARGET, device: 'laptop-2', deviceName: 'Other' }, true, stickFor('remote', 'pc', NOW), NOW + 60_000) === 'ask'
)
ok(
  'a "keep it here" carries no device - it is about this desk',
  offloadPlan({ ...TARGET, device: 'laptop-2' }, true, stickFor('local', 'pc', NOW), NOW + 60_000) === 'local'
)
ok(
  'with asking switched off the setting wins, not an answer from before it was',
  offloadPlan(TARGET, false, stickFor('local', 'pc', NOW), NOW + 60_000) === 'remote'
)
ok(
  'an expired answer with asking off still moves it',
  offloadPlan(TARGET, false, stickFor('local', 'pc', NOW), NOW + OFFLOAD_STICK_MS + 1) === 'remote'
)
ok('the window is ten minutes', OFFLOAD_STICK_MS === 600_000, OFFLOAD_STICK_MS)

ok('a posix path yields its project name', projectNameOf('/Users/robertiuoras/Projects/toolstash') === 'toolstash')
ok('a windows path yields the same name', projectNameOf('C:\\Users\\Gamer\\Desktop\\Projects\\toolstash') === 'toolstash')
ok('a trailing separator does not produce an empty name', projectNameOf('/Users/rob/Projects/toolstash/') === 'toolstash')
ok('a nameless path is not a match', projectNameOf('/') === '')

// --- what a launch brings back ---------------------------------------------
//
// The reported failure this exists for: six panes restored onto a 16 GB laptop the kernel
// was already reclaiming from, and the desk came back unable to accept a keystroke. Every
// negative below is the half that decides whether the feature is worth having - a restore
// that quietly returns nothing, or one that nags a machine with room, are both worse than
// the bug.
const COLD = (pressure) => ({ totalMb: 16 * GB, pressure, localPanes: 0 })

ok('a healthy machine gets its whole desk back', restorePlan(6, COLD('normal')).fits === 6)
ok('and is told nothing, because there is nothing to say', restorePlan(6, COLD('normal')).note === '')
ok('at warn the desk comes back two at a time', restorePlan(6, COLD('warn')).fits === 2)
ok('at critical, one', restorePlan(6, COLD('critical')).fits === 1)
ok(
  'a machine under pressure says why, with the cost of a pane in it',
  /MB/.test(restorePlan(6, COLD('warn')).note) && /History/.test(restorePlan(6, COLD('warn')).note),
  restorePlan(6, COLD('warn')).note
)
// The window is never emptied - same rule reclaim.ts keeps. An app that restores nothing
// has removed the reason it was reopened, and the person cannot tell it from a lost desk.
ok('never zero, at any pressure', restorePlan(4, COLD('critical')).fits >= 1)
ok('one saved pane is one restored pane, whatever the kernel says', restorePlan(1, COLD('critical')).fits === 1)
ok('an empty desk asks for nothing', restorePlan(0, COLD('critical')).fits === 0)
ok('and says nothing about a desk it cannot restore', restorePlan(1, COLD('critical')).note === '')
ok(
  'it never offers more than were saved',
  restorePlan(2, COLD('normal')).fits === 2 && restorePlan(2, COLD('warn')).fits === 2
)
ok(
  'panes already open count against the room for more',
  restorePlan(6, { totalMb: 4 * GB, pressure: 'normal', localPanes: 4 }).fits <
    restorePlan(6, { totalMb: 4 * GB, pressure: 'normal', localPanes: 0 }).fits
)

// A note is only allowed to send somebody to History when something was really held back.
// Said unconditionally it is a sentence about panes that do not exist.
ok(
  'no "the rest are in History" when everything fits',
  !/History/.test(restorePlan(2, COLD('warn')).note) &&
    !/History/.test(restorePlan(1, COLD('critical')).note),
  restorePlan(2, COLD('warn')).note
)
ok(
  'and it IS there when panes were held back',
  /History/.test(restorePlan(6, COLD('warn')).note) &&
    /History/.test(restorePlan(6, COLD('critical')).note)
)

// ------------------------------------------------------- lagging, and the local budget

// The reading a person actually complains about. Memory pressure is the kernel admitting
// it has already lost; this desk sat at `warn` for an afternoon with nine agent CLIs up
// while the load average ran at 8.70 on 10 cores, which is the number that had moved.
ok('an idle machine is not lagging', lagLevel(0.3) === 'normal')
ok('a core apiece is lagging', lagLevel(LAG_WARN) === 'warn' && lagLevel(1.2) === 'warn')
ok('nearly two apiece is on its knees', lagLevel(LAG_HARD) === 'critical' && lagLevel(4) === 'critical')

// A missing reading must never be the reason a pane is moved. Windows has no load average
// at all - Node answers [0, 0, 0] there - so 0 is "nobody measured", not "idle".
for (const bad of [undefined, null, 0, -1, NaN, Infinity, '2', true, {}]) {
  ok(`no reading (${JSON.stringify(bad) ?? String(bad)}) is never lag`, lagLevel(bad) === 'normal')
}

ok('the worse of the two readings decides', worstPressure('normal', 'warn') === 'warn' && worstPressure('critical', 'warn') === 'critical' && worstPressure('normal', 'normal') === 'normal')

{
  // Lag alone is enough, with memory perfectly happy - which is the whole point: the two
  // readings answer the same question minutes apart.
  const laggy = assess(machine({ localPanes: 3, load: 1.3, peerAvailable: true }))
  ok('lag alone makes the verdict tight', laggy.level === 'tight', laggy)
  ok('...and says lag is what it read', laggy.why === 'lag', laggy.why)
  ok('...and names the number in words a person recognises', /load is 1\.3 per core/.test(laggy.advice), laggy.advice)
  ok('...and offers the paired device', laggy.offload === true)

  const hard = assess(machine({ localPanes: 3, load: 2.5, peerAvailable: true }))
  ok('load past the hard mark is over, not tight', hard.level === 'over' && hard.why === 'lag')

  // The control. Without this every assertion above would also pass on a build that had
  // simply started calling three panes "tight".
  const calm = assess(machine({ localPanes: 3, load: 0.4, peerAvailable: true }))
  ok('the same desk with the load down is ok', calm.level === 'ok' && calm.why === 'ok', calm)
  ok('and a machine with no load reading at all is unchanged', JSON.stringify(assess(machine({ localPanes: 3, peerAvailable: true }))) === JSON.stringify(calm))

  // Memory outranks lag when both are objecting: it is the one with a kernel behind it.
  const both = assess(machine({ localPanes: 3, pressure: 'warn', load: 1.5, peerAvailable: true }))
  ok('memory is named when both readings object', both.why === 'memory', both.why)
}

{
  // The budget: a policy about where agents run, not a reading of how bad things are. The
  // load-bearing half is that it holds at `ok` - a desk that said it keeps two agents is
  // not in trouble with five open, it is three panes past what it asked for.
  const v = assess(machine({ localPanes: 5, keepLocal: 2, peerAvailable: true }))
  ok('a healthy desk past its budget is still ok', v.level === 'ok', v)
  ok('...and says how many panes are past it', v.over === 3, v.over)
  ok('...and says the budget is what it read', v.why === 'budget')
  ok('...and offers the paired device anyway', v.offload === true)
  ok('...and the launch really does resolve a host at level ok', offloadTarget(v, [{ device: 'pc', deviceName: 'PC', online: true, projects: [{ name: 'proj', path: '/pc/proj' }] }], 'proj')?.device === 'pc')
  ok('...and says so in the sentence', /past the 2 this machine keeps/.test(v.advice), v.advice)

  const alone = assess(machine({ localPanes: 5, keepLocal: 2 }))
  ok('with nothing paired there is nowhere to send them', alone.offload === false && alone.over === 3)
  ok('...and it says that rather than promising a move', /No paired device/.test(alone.advice), alone.advice)

  const under = assess(machine({ localPanes: 2, keepLocal: 2, peerAvailable: true }))
  ok('at the budget nothing is over', under.over === 0 && under.why === 'ok' && under.offload === false, under)

  // The control for the whole feature: a desk that never set a budget behaves exactly as
  // it did before this existed.
  const none = assess(machine({ localPanes: 9, peerAvailable: true }))
  ok('no budget, no overshoot', none.over === 0 && none.why !== 'budget', none)
}

// Hardened the same way `offloadMinutes` is, and for the same reason: this comes off
// config.json and off `pf-ctl call config:set`. `true` is not a budget of one.
for (const bad of [true, '2', '', null, undefined, NaN, Infinity, -5, 0, {}]) {
  ok(`keepLocal ${JSON.stringify(bad) ?? String(bad)} is no budget, not a threshold`, keepLocalOf(bad) === 0)
}
ok('a real number is taken as given', keepLocalOf(4) === 4 && keepLocalOf(2.7) === 2)
ok('a boolean budget moves nothing', assess(machine({ localPanes: 9, keepLocal: true, peerAvailable: true })).over === 0)

// The half this file cannot reach by importing the module: WHICH pressure reading the
// offer is built from. `lastPressure` is a module variable the 15s sampler fills in, and
// on a cold launch it has not necessarily ticked - so reading it would report `normal` on
// exactly the launch this feature exists for, and every pane would tick again with the
// test still green. Asserted against the source because the bug is one identifier wide.
const mainSrc = readFileSync(join(here, '..', 'src', 'main', 'index.ts'), 'utf8')
// Comments stripped, or the source's own note explaining why `lastPressure` is the WRONG
// one to read counts as a use of it - a test that fails on the sentence describing the fix.
const offerBody = mainSrc
  .slice(mainSrc.indexOf('function offerRestore('), mainSrc.indexOf("ipcMain.handle('restore:pending'"))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
ok('the restore offer asks the kernel now', /restorePlan\(/.test(offerBody) && /readPressure\(\)/.test(offerBody))
ok('and never off the sampler variable', !/lastPressure/.test(offerBody))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
