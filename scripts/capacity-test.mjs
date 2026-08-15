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

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Same approach as grid-layout-test: the only TypeScript in the module is its type
// annotations, so they are stripped and it runs as plain ESM against the real source.
const src = readFileSync(join(here, '..', 'src', 'shared', 'capacity.ts'), 'utf8')
const js = src
  .replace(/^export type .*$/gm, '')
  .replace(/^export interface [\s\S]*?^}$/gm, '')
  .replace(/: (Machine|Verdict|Level|Pressure|PaneRef|OffloadCandidate|OffloadAnswer|OffloadStick|OffloadPlan|Offload|Trim|Trim\[\]|number|string|boolean)(\[\])?( \| null)?/g, '')
  .replace(/<[A-Za-z]+(\[\])?>/g, '')
const dir = join(tmpdir(), 'paneforge-capacity-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'capacity.mjs')
writeFileSync(mod, js, 'utf8')
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

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
