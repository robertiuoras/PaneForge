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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// 2026-09-18, s15-mu6q4smz: a pressure sweep armed a sleep on a pane between `/clear`
// landing and its resume prompt going in - the general fact `owedPrompt` covers, whoever
// queued the prompt.
is(canSleep({ ...idle, owedPrompt: true }), false, 'the app itself owes this pane a prompt')
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
ok(/still being sent/.test(sleepRefusal({ ...idle, owedPrompt: true })), 'an owed prompt says so')
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
ok(
  /if \(p\.asleep \|\| p\.state === 'exited'\) return false/.test(body('sleepable')),
  'the sleep clock refuses both sleeping and already-exited panes'
)
// One per-pane control, not two (Robert 2026-09-08). `pinned` is "leave this pane alone":
// off the sleep CLOCK as well as the close one, and handed back only under measured pressure.
ok(/pressure !== 'ok'/.test(body('sleepable')), 'a kept pane sleeps only when the machine is short')
ok(/return keepable\(p, personHere\)/.test(body('sleepable')), 'and keeps its pin against the clock')
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
// 2026-09-07: a saved conversation the CLI would refuse no longer leaves the pane asleep
// for ever ("Wake refused ... start a new session to replace it" on every press). It
// wakes FRESH in its own folder, says so once, and never widens to `--continue`.
ok(/could not be resumed, so this pane starts a new one in the same folder/.test(wake), 'an unresumable placeholder says it is starting fresh')
ok(/resume: false, resumeId: undefined, resumeCwd: undefined/.test(wake), 'the fresh wake drops the saved id rather than adopting a sibling conversation')
is(/Wake refused/.test(wake), false, 'nothing in wake() refuses a press any more')
ok(wake.indexOf("live.meta.agent !== 'shell' && !resumable") < wake.indexOf('live.proc = this.spawn'), 'the resume check runs before a pty can spawn')
ok(/live\.meta\.agent !== 'shell' && !resumable/.test(wake), 'a verified named agent session reaches the existing spawn path and shell remains allowed')
ok(/const resumeCwd = live\.req\.resumeCwd \?\? live\.meta\.cwd/.test(wake), 'wake validates a rehomed saved conversation against its original folder')
ok(/resumableTranscript\(resumeCwd, resumeId, live\.meta\.agent\)/.test(wake), 'the original folder is used only for exact resume validation')
ok(/resumeCwd: s\.req\.resumeCwd/.test(sessions), 'snapshot persists the original folder that verifies the named conversation')
ok(/resumeCwd \?\? from/.test(sessions), 'rehome preserves the original folder for a sleeping named conversation')
ok(/noteSession\(id, fresh \? live\.meta\.cwd : resumeCwd, live\.meta\.agent/.test(wake), 'wake keeps the verified original folder bound to the named conversation, and a fresh wake binds its own folder')

// ---------------------------------------------------------------------------
// Sleeping keeps its lane (lane-split 2026-09-04): the app marks the ledger asleep
// before it kills the CLI, so the SessionEnd hook parks the hold instead of releasing it.

ok(/sleep\(id: string, reason: SleepReason,/.test(sessions), 'sleep() has no default reason - every caller names why it took the pane')
ok(!/reason === 'manual' \? 'manual' : 'unknown'/.test(sessions), 'nothing dresses an unlabelled caller up as a click')
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
/** The reason and source lists sleep() checks against, read off shared/types.ts. */
function listsFromTypes() {
  const types = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')
  const pick = (name) => [
    ...(types.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1] ?? '')
      .matchAll(/'([a-z-]+)'/g)
  ].map((m) => m[1])
  return { SLEEP_REASONS: pick('SLEEP_REASONS'), SLEEP_SOURCES: pick('SLEEP_SOURCES') }
}

const events = []
let resumeIdNow = 'exact-conversation'
let verified = false
let kills = 0
let ledgerChanges = 0
const reclaimEvents = []
const deps = {
  canSleep, sleepRefusal, resumeIdFor: () => resumeIdNow, claimFromCli: () => false,
  resumableTranscript: () => verified ? '/fixture/rollout.jsonl' : null,
  // The refusal says WHICH failure it was, so the fixture has to answer that too. It
  // decides nothing - `resumableTranscript` above is still the gate.
  resumeEvidence: () => verified
    ? { file: '/fixture/rollout.jsonl', exists: true, bytes: 4096, mark: 'response_item/message/assistant', reply: true }
    : { file: '/fixture/rollout.jsonl', exists: true, bytes: 4096, mark: 'response_item/message/assistant', reply: false },
  ledgerSleep: () => ledgerChanges++, killPaneStrays() {}, stopPipe() {},
  recordEnd() {}, logReclaim: row => reclaimEvents.push(row), basename: () => 'fixture', SLEEP_MARK: 'asleep',
  // sleep() reads the one shared list of reasons rather than a hand-written copy (the two
  // copies that existed disagreed, and rewrote 'handoff' and 'restored' to 'unknown').
  // The fixture runs the method body outside its module, so it has to supply them.
  ...listsFromTypes()
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
manager.redraw = () => events.push(['redraw'])
manager.endRun = () => {}
for (let sweep = 0; sweep < 50; sweep++) is(manager.sleep('pane'), null, 'unverified conversation remains running')
is(kills, 0, 'repeated refusals never kill the process')
is(ledgerChanges, 0, 'repeated refusals leave lane ownership intact')
is(events.filter(([kind]) => kind === 'data').length, 1, 'fifty idle sweeps print one warning')
is(events.filter(([kind]) => kind === 'buffer').length, 1, 'one warning enters the replay buffer')
is(events.filter(([kind]) => kind === 'sessions').length, 1, 'refusals do not repeatedly raise attention')
is(events.filter(([kind]) => kind === 'redraw').length, 1, 'the refusal asks the CLI to repaint the composer it was written over')
ok(sleepBody.indexOf('this.redraw(id)') > sleepBody.indexOf("emit('data', id, note)"), 'the repaint is asked for after the line is written, never before')
const redrawStart = sessions.indexOf('  redraw(id: string)')
ok(redrawStart >= 0, 'found the actual redraw method')
const redrawBody = sessions.slice(redrawStart, sessions.indexOf('\n  /**', redrawStart))
const redrawClass = transformSync(`class RedrawFixture { ${redrawBody} }`, { loader: 'ts' }).code
for (const cols of [20, 80]) {
  const resizes = []
  const timers = []
  const RedrawFixture = new Function('setTimeout', `${redrawClass}; return RedrawFixture`)(
    (callback) => timers.push(callback)
  )
  const repaint = new RedrawFixture()
  repaint.sessions = new Map([['pane', {
    meta: { status: 'idle' }, cols, rows: 24,
    proc: { resize: (...size) => resizes.push(size) }
  }]])
  repaint.redraw('pane')
  ok(resizes.length === 1 && resizes[0][0] !== cols && resizes[0][1] === 24,
    `${cols}-column repaint changes the actual pty dimensions`)
  is(timers.length, 1, 'one deferred resize restores the pane')
  timers[0]()
  ok(resizes.length === 2 && resizes[1][0] === cols && resizes[1][1] === 24,
    `${cols}-column repaint restores the actual size`)
}
verified = true
ok(manager.sleep('pane', 'pressure', { source: 'renderer-idle-sweep', pressure: 'over', idleMs: 31_000, thresholdMs: 30_000 })?.asleep, 'later exact conversation proof still permits sleep')
const decision = reclaimEvents.find(row => row.action === 'sleep-request')
is(decision.reason, 'pressure', 'request records the actual pressure reason')
is(decision.source, 'renderer-idle-sweep', 'request identifies the automatic caller')
is(decision.resumeId, 'exact-conversation', 'decision identifies the conversation it will stop')
is(decision.processPid, 1, 'decision identifies the process it will stop')
is(decision.thresholdMs, 30_000, 'decision explains the shortened pressure threshold')
is(reclaimEvents.at(-1).action, 'sleep', 'successful sleep has a separate completion record')
// The idle time an idle sweep's sleep is logged under is measured at the DEADLINE, not
// carried from the arm (s17-muexgy28, 2026-09-24: logged 45371ms against a 60000ms
// threshold on a pane that was 60.0s quiet) - and a pane that printed during the count
// is refused rather than slept under it.
{
  // A fresh pane each time: a sleep rewrites the meta it was handed. Its own kill count,
  // because the checks below this block count the fixture pane's.
  let kills = 0
  const pane = (id, outputAgo, pid) => ({
    meta: { id, agent: 'codex', cwd: '/fixture', status: 'idle', lastKeyboard: Date.now() - 300_000, lastOutput: Date.now() - outputAgo },
    req: {}, busyUntil: 0, buffer: { push() {} }, proc: { pid, kill: () => kills++ }
  })
  manager.sessions.set('quiet', pane('quiet', 61_000, 2))
  const before = 0
  ok(manager.sleep('quiet', 'pressure', { source: 'renderer-idle-sweep', pressure: 'tight', idleMs: 45_000, thresholdMs: 60_000 })?.asleep,
    'a pane past its threshold at the deadline sleeps even though it was under it when armed')
  const slept = reclaimEvents.filter((row) => row.pane === 'quiet' && row.action === 'sleep').at(-1)
  ok(slept.idleMs >= 61_000 && slept.idleMs < 70_000, `the sleep is logged under the idle time at the deadline (${slept.idleMs})`)
  is(slept.armedIdleMs, 45_000, '...with the armed reading kept beside it')
  is(kills, before + 1, 'that sleep really ended the process')

  manager.sessions.set('woke', pane('woke', 5_000, 3))
  is(manager.sleep('woke', 'pressure', { source: 'renderer-idle-sweep', pressure: 'tight', idleMs: 59_000, thresholdMs: 60_000 }), null,
    'a pane that printed during the countdown is refused')
  const refused = reclaimEvents.filter((row) => row.pane === 'woke').at(-1)
  is(refused.refusal, 'under-idle-threshold', '...and the refusal says why')
  ok(refused.idleMs < 10_000, '...under the idle time measured now')
  is(kills, before + 1, 'the refused pane kept its process')

  manager.sessions.set('edge', pane('edge', 59_600, 4))
  ok(manager.sleep('edge', 'pressure', { source: 'renderer-idle-sweep', pressure: 'tight', idleMs: 45_000, thresholdMs: 60_000 })?.asleep,
    'a deadline timer landing a moment early is not a pane that woke up')
  manager.sessions.set('hand', pane('hand', 1_000, 5))
  ok(manager.sleep('hand', 'manual', { source: 'menu' })?.asleep, 'a press is never held to the sweep threshold')
}
is(reclaimEvents.filter(row => row.refusal === 'conversation-unverified').length, 1, 'repeated missing-conversation refusals write one diagnostic')
// A refusal that names only itself cannot be diagnosed from the log: nineteen of them
// over two days on this desk said `conversation-unverified` and nothing about which file
// was looked at (2026-09-17, panes `s15-mu3zrr31` and `s42-mu5gkqxf`).
const unverified = reclaimEvents.find(row => row.refusal === 'conversation-unverified')
is(unverified.transcript, '/fixture/rollout.jsonl', 'the refusal names the file it looked in')
is(unverified.transcriptExists, true, '...whether that file is there')
is(unverified.transcriptBytes, 4096, '...how big it is')
is(unverified.replyMark, 'response_item/message/assistant', '...and the mark it searched for')
is(unverified.reply, false, '...and that the mark was not found, which is the actual refusal')
is(unverified.resumeCwd, '/fixture', 'the refusal names the folder the resume was looked for in')
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

// The latch is per conversation. A Codex pane is often refused while its rollout has not
// been discovered yet (`resumeIdFor` answering nothing), and the discovery can succeed
// minutes later - a latch held on the PANE meant it was refused in silence from then on,
// whatever the reading underneath it became (2026-09-12, pane `s2-mtwz8uej`).
resumeIdNow = undefined
manager.sleep('pane')
is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 6, 'losing the conversation entirely is a new refusal, said out loud')
manager.sleep('pane')
is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 6, '...and is then suppressed like any other')
resumeIdNow = 'a-conversation-that-was-finally-found'
manager.sleep('pane')
is(events.filter(([kind, , text]) => kind === 'data' && text?.includes('Sleep refused')).length, 7, 'a conversation discovered after the refusal is owed the sentence again')
resumeIdNow = 'exact-conversation'

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

// A pane restored ASLEEP claims its conversation on arrival. `snapshot()` asks
// `resumeIdFor` on every desk write, and that reads the claim `noteSession` makes - so a
// restore branch that returned before making it wrote `resumeId: null` for every sleeping
// pane, and the next restart woke each one fresh (2026-09-10, pizza-ovens-r-us and
// simon-hubspot, transcripts on disk throughout).
{
  const startAt = sessions.indexOf('    if (born) {')
  const born = sessions.slice(startAt, sessions.indexOf('    this.attach(live)', startAt))
  assert.match(born, /noteSession\(id, req\.resumeCwd \?\? req\.cwd, agent, req\.resume \? req\.resumeId : undefined\)/, 'a pane restored asleep claims its saved conversation before it returns')
  assert.ok(born.indexOf('noteSession(') < born.indexOf('return meta'), 'and the claim is made before the early return, not after it')
  checks += 2
}

// The countdown in front of a sleep said the wrong thing, and then did nothing.
//
// 2026-09-11, pane s17: the card read `Putting ... to sleep` while the chip on the same
// row read `closes 0:09` - `CloseClock` only knew one word. And the deadline sent
// `{ source: 'renderer-idle-sweep' }` with no `pressure`, so main filed every sweep sleep
// as reason `unknown` from `renderer`; when main REFUSED, the renderer heard nothing,
// logged nothing, and re-armed the same 10s countdown every 15s for ever (eight `armed`
// lines in 2.5 minutes, no `sleep`, no `skipped`, no `sleep-refused`).
{
  const chip = app.slice(app.indexOf('function CloseClock('), app.indexOf('const api = window.api'))
  assert.match(chip, /sleep \? 'sleeps' : 'closes'/, 'the chip has a word for a sleep countdown')
  assert.match(chip, /going to sleep/, '...and its hover says what a sleep keeps')
  const row = app.slice(app.indexOf('{alarmAt(s.id) ?? s.closingAt ? ('), app.indexOf('onKeep={() => keepOpen([s.id])}'))
  assert.match(row, /sleep=\{alarmSleeps\(s\.id\)\}/, 'the row tells the chip whether the armed countdown is a sleep')
  const at = app.indexOf('if (soon.sleep) {', app.indexOf('// One timer per card'))
  const deadline = app.slice(at, app.indexOf('const mb = pendingMb.current[key] ?? 0', at))
  assert.match(deadline, /source: 'renderer-idle-sweep',\s*pressure: soon\.pressure/, 'the deadline hands main the pressure it was armed under')
  assert.match(deadline, /idleMs: soon\.idleMs/, '...and how long the pane had been quiet')
  assert.match(deadline, /skipClose\(\[id\], `the app refused to sleep it/, 'a refusal is written down where the arm was')
  assert.match(deadline, /sleepHeld\.current\[id\] = Date\.now\(\) \+ hold/, '...and holds the pane off the sleep clock instead of re-arming it every sweep')
  // Every ten minutes for two hours, armed/due/refused, on a pane whose refusal was not
  // going to change (2026-09-16, s15-mu3zrr31): the hold now doubles per refusal.
  assert.match(deadline, /const hold = sleepHoldMs\(refusals\)/, '...for a wait that grows with each refusal in a row')
  assert.match(deadline, /if \(slept\) \{\s*delete sleepRefusals\.current\[id\]/, '...and a sleep that goes through starts the count over')
  const arm = app.slice(app.indexOf('armSleepRef.current = (plan, pressure) => {'), app.indexOf('armCloseRef.current = (plan, why, log) => {'))
  assert.match(arm, /sleepHeld\.current\[p\.id\]/, 'the sleep arm reads that hold')
  assert.match(arm, /seconds: Math\.round\(\(deadline - now\) \/ 1000\)/, 'the armed line says how long the card really counts')
  assert.doesNotMatch(app, /console\.info\(`reclaim: countdown dropped - somebody came to \$\{id\}`\)/, 'a countdown dropped by a press is not a console line')
  assert.match(app, /skipClose\(soon\.ids, 'somebody came to it'\)/, '...it is a skipped line in reclaim.log like every other end')
  const refuse = sessions.indexOf("refusal: 'conversation-unverified'")
  const once = sessions.indexOf('if (live.sleepRefusalShown) return null')
  assert.ok(refuse > 0 && once > refuse, 'main writes the unverified refusal down every time, and only the on-screen note is once')
  checks += 12
}

// ---------------------------------------------------------------------------
// A Codex pane with a real rollout on disk is sleepable
//
// This is the bug Robert reported on 2026-09-12: session 1, a codex pane, refused
// `conversation-unverified` on every press of `Sleep now` and on every idle sweep. The
// refusal in sleep() is correct - a conversation that cannot be resumed must not be
// ended. What was wrong is upstream: a codex pane's rollout was only ever matched when
// the rollout was CREATED after the pane started, so a pane restored onto an older
// conversation could never be identified, and `resumeIdFor` answered nothing for ever.
{
  const bundle = join(work, 'transcripts.bundle.cjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: ['src/main/transcripts.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    outfile: bundle
  })
  const home = join(work, 'codex-home')
  process.env.CODEX_HOME = home
  mkdirSync(join(home, 'sessions', '2026', '09', '12'), { recursive: true })
  const cwd = join(work, 'a-project')
  mkdirSync(cwd, { recursive: true })

  const { noteSession, noteSubmittedPrompt, resumeIdFor, resumableTranscript } = require(bundle)
  const id = '4f2a9c11-7b0e-4d33-9a55-2c9f6b1d8e40'
  const line = 'fix the sleep refusal on this codex pane'
  const rollout = join(home, 'sessions', '2026', '09', '12', `rollout-${id}.jsonl`)

  noteSession('codex-pane', cwd, 'codex')
  noteSubmittedPrompt('codex-pane', line)
  is(resumeIdFor('codex-pane'), undefined, 'a codex pane with no rollout on disk names no conversation')

  // Written AFTER the pane started, but stamped two hours earlier - exactly the shape of
  // a conversation the pane was resumed into, and the one the old time gate refused.
  const born = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: born } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } }),
    ''
  ].join('\n'))

  is(resumeIdFor('codex-pane'), id, 'a rollout the pane can prove it typed into is its conversation, whenever it was created')
  ok(resumableTranscript(cwd, id, 'codex') === rollout, '...and that conversation is resumable, so the pane may sleep')

  // An antigravity transcript has no `assistant` row: its answers are PLANNER_RESPONSE
  // steps. Read for `assistant`, every antigravity pane was "never answered", refused
  // sleep `conversation-unverified` for the life of the app, and re-armed by the idle
  // sweep every ten minutes (2026-09-16, pane s15-mu3zrr31, 2+ hours of it).
  const gemini = join(work, 'gemini-home')
  process.env.PF_GEMINI_HOME = gemini
  const agyId = 'a1012c04-2365-4628-81b4-7b5f50961ee2'
  const agyLogs = join(gemini, 'antigravity-cli', 'brain', agyId, '.system_generated', 'logs')
  mkdirSync(agyLogs, { recursive: true })
  const agyFile = join(agyLogs, 'transcript.jsonl')
  // Row shapes copied from a real transcript.jsonl of 2026-09-16.
  const asked = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-16T11:03:04Z', content: '<USER_REQUEST>\nwhich post is best\n</USER_REQUEST>' })
  const answered = JSON.stringify({ step_index: 1, source: 'AGENT', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-16T11:03:09Z', content: 'The third one.' })
  writeFileSync(agyFile, asked + '\n')
  is(resumableTranscript(cwd, agyId, 'antigravity'), null, 'an antigravity conversation nobody has answered is not resumable')
  writeFileSync(agyFile, asked + '\n' + answered + '\n')
  is(resumableTranscript(cwd, agyId, 'antigravity'), agyFile, '...and one with a PLANNER_RESPONSE step is - that is what an antigravity reply looks like')

  // The proof is the typed line, never the folder alone: a rollout in the same folder
  // this pane never said anything into belongs to somebody else.
  noteSession('other-pane', cwd, 'codex')
  is(resumeIdFor('other-pane'), undefined, 'a pane that has proved nothing still claims no conversation')

  const source = readFileSync(join(root, 'src/main/transcripts.ts'), 'utf8')
  const discovery = source.slice(source.indexOf('const matches = codexRollouts('), source.indexOf('if (matches.length !== 1) return null'))
  ok(!/row\.at >= s\.at - START_SLACK_MS/.test(discovery), 'and no birth-time gate is put back on top of that proof')
  delete process.env.CODEX_HOME
}

// ---------------------------------------------------------------------------
// A Claude pane whose transcript the CLI wrote LATE is still its own, and sleepable
//
// 2026-09-22, installed 0.8.221: panes s38-mud2ugs8, s47-mud4ooh4 and s30-mud1wtus were
// refused sleep `conversation-unverified` (and s30 a PC move, "no resumable ID") while
// their conversations sat on disk. Claude Code 2.1.280 only creates the file around the
// first exchange: s38 opened 19:38:41, its `SessionStart:startup` record is stamped
// 19:39:11, and the file was born 19:40:53 - 132s later, past the 60s launch window, so
// the pane's own chat read as somebody else's launch. The record head below is copied
// from that real file (b5b25160), content scrubbed.
{
  const bundle = join(work, 'transcripts.bundle.cjs')
  const { noteSession, resumeIdFor, resumableTranscript } = require(bundle)
  const home = join(work, 'claude-home')
  process.env.PF_CLAUDE_HOME = home
  const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
  const realNow = Date.now

  function lateTranscript(cwd, id, stampedAt) {
    const dir = join(home, 'projects', slug(cwd))
    mkdirSync(dir, { recursive: true })
    const at = new Date(stampedAt).toISOString()
    const row = (o) => JSON.stringify({ ...o, sessionId: id })
    writeFileSync(join(dir, `${id}.jsonl`), [
      row({ type: 'last-prompt', leafUuid: '99c3d854-7668-4a82-9672-233db2d9d836' }),
      row({ type: 'mode', mode: 'normal' }),
      row({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      row({ type: 'atis-latch', atis: '' }),
      row({ type: 'ai-title', aiTitle: 'Paneforge and penaforge improvements' }),
      row({ parentUuid: null, isSidechain: false, attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: 'hook said "timestamp":"2020-01-01T00:00:00.000Z"' }, type: 'attachment', uuid: '16fc5714-5165-425a-b995-fe21b04fad48', timestamp: at, cwd, version: '2.1.280' }),
      row({ parentUuid: '16fc5714-5165-425a-b995-fe21b04fad48', isSidechain: false, type: 'user', message: { role: 'user', content: 'improve the pane' }, uuid: 'u1', timestamp: at, cwd }),
      row({ parentUuid: 'u1', isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] }, uuid: 'a1', timestamp: at, cwd }),
      ''
    ].join('\n'))
  }

  // The pane opened 132s ago; the CLI stamped its start 30s after that; the file is born now.
  const ownCwd = join(work, 'PaneForge-c')
  const ownId = 'b5b25160-2519-4a13-b295-5b45798e8f37'
  const opened = realNow() - 132_000
  Date.now = () => opened
  noteSession('late-pane', ownCwd, 'claude')
  Date.now = realNow
  lateTranscript(ownCwd, ownId, opened + 30_000)
  is(resumeIdFor('late-pane'), ownId, 'a Claude pane whose file was created 132s after launch still names the conversation its CLI started 30s after launch')
  ok(Boolean(resumableTranscript(ownCwd, ownId, 'claude')), '...and that answered conversation is resumable, so sleep is not refused')

  // s47-mud4ooh4: SessionStart hooks on a loaded desk took the first record to 60.1s.
  const slowCwd = join(work, 'claude-memory-a')
  const slowId = '3c017c1c-40c9-47ef-ba36-680c9ec49dcc'
  const slowOpened = realNow() - 142_000
  Date.now = () => slowOpened
  noteSession('slow-pane', slowCwd, 'claude')
  Date.now = realNow
  lateTranscript(slowCwd, slowId, slowOpened + 60_100)
  is(resumeIdFor('slow-pane'), slowId, 'a CLI whose slow hooks stamped its start 60.1s after the pane opened is still that pane\'s')

  // Controls: the window still refuses a chat somebody launched later, and nothing on disk is nothing.
  const otherCwd = join(work, 'taskdriver.ai-c')
  const later = realNow() - 180_000
  Date.now = () => later
  noteSession('rival-pane', otherCwd, 'claude')
  noteSession('empty-pane', join(work, 'taskdriver.ai-h'), 'claude')
  Date.now = realNow
  lateTranscript(otherCwd, '2df0c87c-146a-4829-b1e2-5ede2ea5f3c6', later + 150_000)
  is(resumeIdFor('rival-pane'), undefined, 'a startup chat whose CLI began 150s after this pane is still somebody else\'s launch')
  is(resumeIdFor('empty-pane'), undefined, 'a pane with no transcript on disk still names no conversation, so its sleep stays refused')
  delete process.env.PF_CLAUDE_HOME
}

console.log(`sleep: ${checks} checks passed`)
