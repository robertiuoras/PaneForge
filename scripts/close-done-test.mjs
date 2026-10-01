// A pane automation opened for one job, closing itself once the job is really over.
//
// The weight is in the negatives, as usual, and for a sharper reason than most: this is
// the only rule in the app that CLOSES a pane with nobody watching and no countdown in
// front of it. Everything it refuses is work that would be lost - a turn still running, a
// question nobody answered, a build an agent left in the background - and the last of
// those is why "the turn ended" is not the reading: that answer comes off a process table
// sampled every four seconds, so a pane closing on its turn's own edge takes the build.
//
// The last block is a SOURCE assertion: a decision nothing calls closes nothing.
//
//   node scripts/close-done-test.mjs

import { buildSync, transformSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-close-done-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'closeWhenDone.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/closeWhenDone.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { doneEnough, closeRefused, closeByOf, CLOSE_DONE_QUIET_MS } = require(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}

const NOW = 1_000_000_000
const QUIET = CLOSE_DONE_QUIET_MS
const done = { printed: NOW - 60_000, status: 'idle' }

// ---------------------------------------------------------------- what closes
ok(doneEnough(done, QUIET, NOW), 'a pane that printed, finished and went quiet closes itself')
ok(doneEnough({ ...done, busyUntil: NOW - 1 }, QUIET, NOW), 'a footer that has already expired is not busy')
is(CLOSE_DONE_QUIET_MS, 8_000, 'two process-table samples plus the sweep, and it is a named number')

// ------------------------------------------------------------ what does not
is(doneEnough(done, QUIET - 1, NOW), false, 'not one millisecond before the quiet window is up')
is(doneEnough({ ...done, printed: undefined }, QUIET, NOW), false, 'a pane that has printed nothing has not started, let alone finished')
is(doneEnough({ ...done, runSince: NOW - 1000 }, QUIET, NOW), false, 'never mid-turn')
is(doneEnough({ ...done, busyUntil: NOW + 1000 }, QUIET, NOW), false, "...nor while the CLI's own footer still says so")
is(doneEnough({ ...done, ask: { title: 'Which?' } }, QUIET, NOW), false, 'never a pane holding a question - the answer would be thrown away')
is(doneEnough({ ...done, drafting: true }, QUIET, NOW), false, 'never a pane whose prompt failed before submission')
is(doneEnough({ ...done, job: 'npm' }, QUIET, NOW), false, 'never while a command is running in front of the tty')
is(doneEnough({ ...done, backJob: 'npm' }, QUIET, NOW), false, 'never while the agent left something running in the background')
is(doneEnough({ ...done, serving: 'node' }, QUIET, NOW), false, 'never while something it runs is listening on a port - a dev server is quiet on purpose')
is(doneEnough({ ...done, status: 'exited' }, QUIET, NOW), false, 'an ended pane has nothing to close')
is(doneEnough({ ...done, asleep: NOW - 1000 }, QUIET, NOW), false, 'and a SLEEPING pane is being kept, not finished')
// By status alone: log review 2026-10-01 found two Codex panes closed while `working`
// (s16-munpf9fk 09-30 08:05Z, s2-munmghtf 08:47Z) with no turn clock the rule could read.
is(doneEnough({ ...done, status: 'working' }, QUIET, NOW), false, 'never a pane whose status says working, however quiet it reads')

// ------------------------------------------------ who may close a working pane
for (const by of ['user', 'phone', 'remote', 'pf', 'handoff'])
  is(closeRefused(by, 'working'), undefined, `${by}: a close somebody named this pane in goes through mid-turn`)
for (const by of ['review', 'close-when-done', 'idle-clock', 'exited-sweep', 'exit-close', 'cwd-gone', 'tidy-dupes', 'unnamed'])
  ok(typeof closeRefused(by, 'working') === 'string', `${by}: the app's own close of a working pane is refused`)
is(closeRefused('idle-clock', 'idle'), undefined, '...and only mid-turn')
is(closeByOf(true, 'pf'), 'user', 'the window is a person, whatever it says')
is(closeByOf(false, 'user'), 'phone', "the window's own code in a phone's browser is a person on the phone")
is(closeByOf(false, 'pf'), 'pf', 'pf says so')
is(closeByOf(false, 'tidy-dupes'), 'tidy-dupes', '...and so does its duplicate sweep')
is(closeByOf(false, 'review'), 'unnamed', "a caller from outside cannot claim one of the app's own names")
is(closeByOf(false, undefined), 'unnamed', 'a script that names nobody is not a person')

// ------------------------------------------------------------- the wiring
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
ok(/if \(live\.req\.closeWhenDone\) this\.sweepCloseWhenDone\(live, now, quiet\)/.test(sessions), 'the idle sweep asks, every second')
ok(/doneEnough\(\{ \.\.\.meta, busyUntil: live\.busyUntil \}, quiet, now\)/.test(sessions), '...through this rule, with the footer reading it alone holds')
// Told BEFORE the kill: `kill()` deletes the session, and the request naming who to tell
// goes with it.
const body = sessions.slice(sessions.indexOf('private sweepCloseWhenDone'), sessions.indexOf('/** Start a countdown that was queued'))
ok(/this\.owesPrompt\(live\)/.test(body), 'an owed or uncertain prompt refuses the explicit close path')
ok(/meta\.agent !== 'shell' && meta\.finished !== true/.test(body), 'startup paint without a completed native reply refuses the explicit close path')
ok(body.indexOf('queuePrompt') < body.indexOf("this.kill(meta.id, 'close-when-done')"), 'the opener is told before the pane is killed, and the close names itself')
ok(/PF_PANE: id/.test(sessions), 'every pane knows which pane it is, so `pf` can name the opener')

const ctl = readFileSync(join(root, 'scripts/pf-ctl.mjs'), 'utf8')
ok(/--close-when-done/.test(ctl), 'pf open takes the flag')
ok(/process\.env\.PF_PANE/.test(ctl), '...and reports back to the pane that ran it, unasked')

// ...and armed on a pane that is ALREADY open, which the flag cannot reach: a chat opened
// by hand, finished, that would otherwise wait out the idle clock.
ok(/armCloseWhenDone\(id: string, reportTo\?: string\): boolean/.test(sessions), 'a live pane can be armed')
ok(/live\.req\.closeWhenDone = true/.test(sessions), '...by setting the very request the sweep reads, so no second rule decides when')
ok(/reportTo !== id/.test(sessions), '...and a pane is never told about its own closing')
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok(/ipcMain\.handle\('sessions:closeWhenDone'/.test(main), 'the channel is registered')
ok(/remote\.owns\(id\) \? remote\.armCloseWhenDone\(id\)/.test(main), 'a mirrored pane is armed on the device that owns it')
const remoteHost = readFileSync(join(root, 'src/main/remote/host.ts'), 'utf8')
ok(/case 'closeDone':[\s\S]*armCloseWhenDone\?\.\(id\)/.test(remoteHost), 'the owner applies the remote close request to its own session manager')
const surface = readFileSync(join(root, 'src/shared/surface.ts'), 'utf8')
ok(/'sessions:closeWhenDone'/.test(surface), "...on the one list both ends build from, or it would not compile")
ok(/cmd === 'close-when-done'/.test(ctl), 'pf close-when-done arms it')
ok(/close-when-done needs a pane/.test(ctl), '...and refuses by name when it cannot tell which pane')

// ------------------------------------------------- an automatic clear on its way in
// 2026-10-01, Mac 0.8.232: two `--close-when-done` panes lane.mjs opened were killed while
// their own autoclear was on its way in, and the handoff's open steps went with them.
// s28-mupc5ct1: countdown armed 13:04:36.682Z, close-request 84ms later. s57-mupk43r8
// ("Finish preserved work"): settle hold logged 14:03:24.438Z, close-request 179ms later,
// three next steps not done. The sweep read `doneEnough` and nothing the app still owed the
// pane. The real method bodies run here, `owesPrompt` included, so a copy cannot drift.
{
  const methodBody = (sig) => {
    const at = sessions.indexOf(sig)
    assert.ok(at >= 0, `real method exists: ${sig.trim()}`)
    return sessions.slice(at, sessions.indexOf('\n  }\n', at) + 4)
  }
  const code = transformSync(
    `class Fixture { ${methodBody('  private owesPrompt(live: Live)')} ${methodBody('  private sweepCloseWhenDone(')} }`,
    { loader: 'ts' },
  ).code
  const Fixture = new Function('doneEnough', `${code}; return Fixture`)(doneEnough)
  const kills = []
  const told = []
  const manager = new Fixture()
  manager.autoClearPending = new Map()
  manager.autoClearArmTimers = new Map()
  manager.keptOpen = () => false
  manager.openerOf = () => 'opener'
  manager.queuePrompt = (id, text) => told.push([id, text])
  manager.kill = (id) => kills.push(id)
  const at = Date.now()
  const pane = () => ({
    meta: { id: 'pane', title: 'Finish preserved work', cwd: '/fixture', agent: 'claude', finished: true, status: 'idle', printed: at - 60_000 },
    req: { closeWhenDone: true },
    busyUntil: 0,
  })
  const sweep = (live) => manager.sweepCloseWhenDone(live, Date.now(), QUIET)

  const queued = pane()
  manager.autoClearPending.set('pane', { seconds: 15 })
  sweep(queued)
  is(kills, [], 'a clear asked for during the turn keeps the pane open (s57-mupk43r8)')
  manager.autoClearPending.clear()

  const holding = pane()
  manager.autoClearArmTimers.set('pane', 0)
  sweep(holding)
  is(kills, [], '...and so does the settle hold in front of its countdown')
  manager.autoClearArmTimers.clear()

  const counting = pane()
  counting.meta.autoClearAt = Date.now() + 15_000
  sweep(counting)
  is(kills, [], '...and the countdown itself (s28-mupc5ct1, killed 84ms after it armed)')

  const handover = pane()
  handover.meta.handoverUntil = Date.now() + 30_000
  sweep(handover)
  is(kills, [], '...and the handover between `/clear` and the resume prompt')

  const owed = pane()
  owed.meta.owedPrompt = true
  sweep(owed)
  is(kills, [], '...and a queued prompt that has not landed yet')
  is(told, [], 'the opener is told nothing while the pane is still owed a prompt')

  // Quiet but no completed reply on record (startup paint): not done either.
  const unfinished = pane()
  unfinished.meta.finished = undefined
  sweep(unfinished)
  is(kills, [], '...and a Claude pane whose reply has not completed')

  // The resume turn ran and finished: nothing owed, quiet again. Now it is done.
  const resumed = pane()
  sweep(resumed)
  is(kills, ['pane'], 'once the resume turn has finished, the pane closes itself as asked')
  is(told.length, 1, '...and the opener is told, once')
}

rmSync(work, { recursive: true, force: true })
console.log(`close-done: ${checks} checks passed`)
