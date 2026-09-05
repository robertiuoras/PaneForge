// Which panes may be put to sleep, and - much more of this file - which may not.
//
// Sleeping ends a real process, so every refusal here is something that would be LOST
// rather than paused. The conversation is deliberately not one of them: it is on disk and
// `--resume` brings it back, which is the whole reason a sleeping pane is cheap.
//
// The last block is a SOURCE assertion, and it is the load-bearing half. A sleeping pane
// wears `status: 'exited'` so that every existing "has this pane a live process" guard
// keeps working - and `exited` is in `reclaim.ts`'s own CLOSEABLE set, so without an
// explicit refusal both sweeps would close the very pane sleeping exists to keep, buying
// nothing at all for it (there is no agent left in a sleeping pane to reclaim).
//
//   node scripts/sleep-test.mjs

import { buildSync, transformSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-sleep-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'sleep.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/sleep.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { canSleep, keptWords, sleepRefusal, sleepWords } = require(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const idle = { status: 'idle' }

// ---------------------------------------------------------------------------
// What may sleep

ok(canSleep(idle), 'a quiet pane is exactly what this is for')
ok(canSleep({ status: 'working', lastOutput: 1 }), 'printing is not the reading - a TURN is')
ok(canSleep({ ...idle, job: '' }), 'an empty job is no job')
ok(canSleep({ ...idle, asleep: 0 }), 'never slept is not asleep')

// The two `reclaim.ts` refuses and this one must not, or the feature is unreachable on a
// desk showing every pane at once: sleeping is a press on that pane's own menu.
ok(canSleep({ ...idle, focused: true, visible: true }), 'the pane whose menu is open may sleep')

// ---------------------------------------------------------------------------
// ...and what may not

is(canSleep({ ...idle, busy: true }), false, 'a turn is running')
is(canSleep({ ...idle, asking: true }), false, 'the pane is owed an answer')
is(canSleep({ ...idle, drafting: true }), false, 'an unsent prompt would be lost')
is(canSleep({ ...idle, job: 'npm' }), false, 'a shell pane running a command')
is(canSleep({ ...idle, backJob: 'node' }), false, 'a background job the turn left behind')
is(canSleep({ ...idle, mirror: true }), false, "another machine's pty is not ours to end")
is(canSleep({ status: 'exited' }), false, 'an ended run has nothing left to give back')
is(canSleep({ ...idle, asleep: 1 }), false, 'and one already asleep has given it')

// ---------------------------------------------------------------------------
// Why, in words - a greyed row that does not say which of the six it is says nothing

is(sleepRefusal(idle), '', 'no refusal, no sentence')
ok(/mid-turn/.test(sleepRefusal({ ...idle, busy: true })), 'busy says so')
ok(/waiting for an answer/.test(sleepRefusal({ ...idle, asking: true })), 'a question says so')
ok(/unsent prompt/.test(sleepRefusal({ ...idle, drafting: true })), 'a draft says so')
ok(/npm/.test(sleepRefusal({ ...idle, job: 'npm' })), 'the job is named')
ok(/another machine/.test(sleepRefusal({ ...idle, mirror: true })), 'a mirror says whose it is')
// The order matters: an asking pane that is also busy is asked about first, because the
// answer is owed to a person and the turn is not.
ok(
  /waiting for an answer/.test(sleepRefusal({ ...idle, asking: true, busy: true })),
  'the person-owed reason wins over the machine one'
)

// ---------------------------------------------------------------------------
// The words on the chip. A minute clock, because nothing finer is drawn - see AsleepChip.

const t = 1_700_000_000_000
is(sleepWords(t, t + 5_000), 'asleep', 'under a minute says nothing about the seconds')
is(sleepWords(t, t + 90_000), 'asleep 1m', 'a minute')
is(sleepWords(t, t + 59 * 60_000), 'asleep 59m', 'up to an hour')
is(sleepWords(t, t + 61 * 60_000), 'asleep 1h 01m', 'and hours are padded, for tabular figures')
is(sleepWords(t, t - 5_000), 'asleep', 'a clock behind the record never goes negative')

// ---------------------------------------------------------------------------
// The refusals that are not in this file, asserted where they live

const reclaim = readFileSync(join(root, 'src/shared/reclaim.ts'), 'utf8')
ok(/asleep\?: number/.test(reclaim), 'reclaim reads the sleeping flag')
// The pressure sweep and the sleep clock refuse a sleeping pane (nothing to reclaim, already
// the outcome); the idle CLOSE clock does not - since 2026-09-02 a pane that came back asleep
// after a restart closes like any other, or it sits on the desk for ever.
const body = (name) => reclaim.slice(reclaim.indexOf(`function ${name}(`)).split('\n}')[0]
ok(/!p\.asleep &&/.test(body('reclaimPlan')), 'the pressure sweep refuses a sleeping pane')
ok(/!p\.asleep &&/.test(body('sleepable')), 'and so does the sleep clock')
ok(!/!p\.asleep &&/.test(body('keepable')), 'but the idle close clock takes one')

const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
ok(/if \(meta\.asleep\) return/.test(sessions), 'the exit handler does not stamp a code on a sleep')
ok(
  /\.filter\(\(s\) => s\.meta\.status !== 'exited' \|\| Boolean\(s\.meta\.asleep\)\)/.test(sessions),
  'and a sleeping pane is in the snapshot, or a restart loses the card it exists to keep'
)
// Waking must not write a terminal reset: the screen the pane went to sleep with is still
// in the renderer's xterm buffer, and that is what "it should show layout perfectly" is.
const wake = sessions.slice(sessions.indexOf('  wake(id: string)'), sessions.indexOf('   * A pane\'s folder no longer exists'))
ok(wake.length > 200, 'found wake()')
is(/RESET/.test(wake), false, 'waking writes no reset - the old screen IS the screen')
ok(/resumableTranscript\(resumeCwd, resumeId, live\.meta\.agent\)/.test(wake), 'wake revalidates the saved conversation before spawning')
ok(/live\.meta\.agent !== 'shell' && !resumable/.test(wake), 'an invalid restored agent placeholder remains asleep')
ok(/Wake refused: this saved conversation could not be verified/.test(wake), 'the placeholder explains why wake was refused')
ok(wake.indexOf("live.meta.agent !== 'shell' && !resumable") < wake.indexOf('live.proc = this.spawn'), 'invalid wake returns before a pty can spawn')
ok(wake.indexOf("live.meta.agent !== 'shell' && !resumable") < wake.indexOf('live.meta.asleep = undefined'), 'invalid wake leaves the pane asleep')
ok(/live\.meta\.agent !== 'shell' && !resumable/.test(wake), 'a verified named agent session reaches the existing spawn path and shell remains allowed')
ok(/const resumeCwd = live\.req\.resumeCwd \?\? live\.meta\.cwd/.test(wake), 'wake validates a rehomed saved conversation against its original folder')
ok(/resumableTranscript\(resumeCwd, resumeId, live\.meta\.agent\)/.test(wake), 'the original folder is used only for exact resume validation')
ok(/resumeCwd: s\.req\.resumeCwd/.test(sessions), 'snapshot persists the original folder that verifies the named conversation')
ok(/resumeCwd \?\? from/.test(sessions), 'rehome preserves the original folder for a sleeping named conversation')
ok(/noteSession\(id, resumeCwd, live\.meta\.agent/.test(wake), 'wake keeps the verified original folder bound to the named conversation')

// ---------------------------------------------------------------------------
// Sleeping keeps its lane (lane-split 2026-09-04): the app marks the ledger asleep
// before it kills the CLI, so the SessionEnd hook parks the hold instead of releasing it.

ok(/sleep\(id: string, reason: SleepReason = 'manual'\)/.test(sessions), 'sleep takes a reason, default manual')
ok(/ledgerSleep\(live\.meta\.cwd, id\)/.test(sessions), 'sleep marks the ledger before the CLI dies')
ok(/ledgerWake\(live\.meta\.cwd, id\)/.test(sessions), 'wake clears the ledger mark once the CLI is running again')
ok(/backJob: live\.meta\.backJob/.test(sessions), 'manual sleep keeps an agent background job alive')
// A pane put to sleep before it ever ran (`queued`) is woken to do the work it was opened
// for; every other reason drops the launch prompt, or waking would replay finished work.
const sleepBody = sessions.slice(sessions.indexOf('  sleep(id: string'), sessions.indexOf('  /**\n   * Start a sleeping'))
ok(/prompt: reason === 'queued' \? live\.req\.prompt : undefined/.test(sleepBody), 'only `queued` keeps the launch prompt on wake')
ok(/live\.meta\.asleepReason = reason/.test(sleepBody), 'the reason is recorded, not only the timestamp')
ok(/const resumeId = resumeIdFor\(id\)/.test(sleepBody), 'sleep captures one verified resume id before ending the process')
ok(/resumableTranscript\(resumeCwd, resumeId, live\.meta\.agent\)/.test(sleepBody), 'sleep requires a completed transcript, not only a saved id')
ok(/live\.meta\.agent !== 'shell' && !resumable/.test(sleepBody), 'every agent conversation without an exact id refuses sleep before an unnamed resume')
ok(/Sleep refused: this conversation could not be verified/.test(sleepBody), 'the running pane explains why sleep was refused')
ok(sleepBody.indexOf("live.meta.agent !== 'shell' && !resumable") < sleepBody.indexOf('ledgerSleep('), 'conversation refusal happens before the ledger and process are changed')

// Exercise the real manager method across repeated idle sweeps. A failed identity
// check must keep the process alive without filling its terminal with warnings.
const events = []
let verified = false
let kills = 0
let ledgerChanges = 0
const deps = {
  canSleep, resumeIdFor: () => 'exact-conversation',
  resumableTranscript: () => verified ? '/fixture/rollout.jsonl' : null,
  ledgerSleep: () => ledgerChanges++, killPaneStrays() {}, stopPipe() {},
  recordEnd() {}, logReclaim() {}, basename: () => 'fixture', SLEEP_MARK: 'asleep'
}
const method = transformSync(`class Fixture { ${sleepBody} }`, { loader: 'ts' }).code
const Fixture = new Function(...Object.keys(deps), `${method}; return Fixture`)(...Object.values(deps))
const manager = new Fixture()
const live = {
  meta: { id: 'pane', agent: 'codex', cwd: '/fixture', status: 'idle' },
  req: {}, busyUntil: 0, buffer: { push: (text) => events.push(['buffer', text]) },
  proc: { pid: 1, kill: () => kills++ }
}
manager.sessions = new Map([['pane', live]])
manager.emit = (...args) => events.push(args)
manager.emitSessions = () => events.push(['sessions'])
manager.endRun = () => {}
for (let sweep = 0; sweep < 50; sweep++) is(manager.sleep('pane'), null, 'unverified conversation remains running')
is(kills, 0, 'repeated refusals never kill the process')
is(ledgerChanges, 0, 'repeated refusals leave lane ownership intact')
is(events.filter(([kind]) => kind === 'data').length, 1, 'fifty idle sweeps print one warning')
is(events.filter(([kind]) => kind === 'buffer').length, 1, 'one warning enters the replay buffer')
is(events.filter(([kind]) => kind === 'sessions').length, 1, 'refusals do not repeatedly raise attention')
verified = true
ok(manager.sleep('pane')?.asleep, 'later exact conversation proof still permits sleep')
is(kills, 1, 'verified sleep ends the process once')
live.meta.asleep = undefined
live.meta.status = 'idle'
verified = false
manager.sleep('pane')
is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 2, 'a new refusal after successful sleep is visible again')
const changeStart = sessions.indexOf('      if (slash && /^\\s*\\/(clear|new|resume)')
ok(changeStart >= 0, 'found the actual conversation-change handler')
const changeSource = sessions.slice(changeStart, sessions.indexOf('      const quiet =', changeStart))
const changeConversation = new Function('slash', 'live', 'id', 'noteSession', changeSource)
for (const [i, command] of ['/clear', '/new', '/resume exact-id'].entries()) {
  live.typed = command
  changeConversation(true, live, 'pane', () => {})
  manager.sleep('pane')
  manager.sleep('pane')
  is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 3 + i, `${command} permits one warning for the changed conversation`)
}
live.typed = '/help'
changeConversation(true, live, 'pane', () => {})
manager.sleep('pane')
is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 5, 'an unrelated command does not reset suppression')

// ---------------------------------------------------------------------------
// The pin, on a card that is already saying something

// `kept open` above `asleep 2h 36m` was two readings that disagree: the word people take
// out of `open` is "still running", and a slept pane is exactly not that (reported
// 2026-08-30). The pin still means something there - both sweeps refuse a pinned pane, so
// the CARD never goes - so only the word narrows.
is(keptWords(false), 'kept open', 'a running pinned pane says what the pin does')
is(keptWords(true), 'kept', 'a sleeping one does not claim to be open')
ok(!keptWords(true).includes('open'), 'the contradiction itself is the assertion')

const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
ok(/\{keptWords\(Boolean\(s\.asleep\)\)\}/.test(app), 'the card asks keptWords rather than spelling it')
is(
  /^\s+kept open$/m.test(app),
  false,
  'and no literal `kept open` is left behind to go stale beside it'
)

console.log(`sleep: ${checks} checks passed`)
