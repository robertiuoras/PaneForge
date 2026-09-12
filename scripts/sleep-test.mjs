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
ok(/if \(p\.asleep\) return false/.test(body('sleepable')), 'and so does the sleep clock')
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
  canSleep, sleepRefusal, resumeIdFor: () => resumeIdNow,
  resumableTranscript: () => verified ? '/fixture/rollout.jsonl' : null,
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
is(reclaimEvents.filter(row => row.refusal === 'conversation-unverified').length, 1, 'repeated missing-conversation refusals write one diagnostic')
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
  assert.match(deadline, /skipClose\(\[id\], 'the app refused to sleep it/, 'a refusal is written down where the arm was')
  assert.match(deadline, /sleepHeld\.current\[id\] = /, '...and holds the pane off the sleep clock instead of re-arming it every sweep')
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

  // The proof is the typed line, never the folder alone: a rollout in the same folder
  // this pane never said anything into belongs to somebody else.
  noteSession('other-pane', cwd, 'codex')
  is(resumeIdFor('other-pane'), undefined, 'a pane that has proved nothing still claims no conversation')

  const source = readFileSync(join(root, 'src/main/transcripts.ts'), 'utf8')
  const discovery = source.slice(source.indexOf('const matches = codexRollouts('), source.indexOf('if (matches.length !== 1) return null'))
  ok(!/row\.at >= s\.at - START_SLACK_MS/.test(discovery), 'and no birth-time gate is put back on top of that proof')
  delete process.env.CODEX_HOME
}

console.log(`sleep: ${checks} checks passed`)
