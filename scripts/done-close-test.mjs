// A finished pane closes itself into Review; everything that would be LOST keeps it open.
//
// Half the file is refusals, as with close-done-test: a person in the pane, a step an
// agent could take, a subagent still out, a reply ending in a question. The sweep half
// runs `main/doneClose.ts` against fake pane readings and a fake disk: one Review row per
// finished turn, one GuardDeck to-do per person-only step naming its machine, and a
// refused close that records once, not every tick.
//
//   node scripts/done-close-test.mjs

import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-done-close-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const require = createRequire(import.meta.url)

const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/profile$/ }, () => ({ path: 'profile', namespace: 'stub' }))
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({ contents: 'exports.app={isPackaged:true}', loader: 'js' }))
    b.onLoad({ filter: /^profile$/, namespace: 'stub' }, () => ({ contents: 'exports.profileName=()=>undefined', loader: 'js' }))
  }
}
async function bundle(entry, name) {
  const out = join(work, name)
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [stubs] })
  return require(out)
}
const { doneVerdict, doneReviewId, personLooking, replyFinished, AUTO_CLOSE_QUIET_MS } = await bundle('src/shared/doneClose.ts', 'shared.cjs')
const digest = await bundle('src/shared/finishedDigest.ts', 'digest.cjs')
const main = await bundle('src/main/doneClose.ts', 'main.cjs')

const NOW = 1_800_000_000_000
const finished = (over = {}) => ({
  agent: 'claude', printed: NOW - 600_000, status: 'idle', lastKeyboard: NOW - 400_000,
  turnEndedAt: NOW - AUTO_CLOSE_QUIET_MS - 1000, reply: 'Built it.\n\n## Next steps\n- None', runningAgents: 0, ...over
})

// 1. The one shape that closes, and its person-only steps.
{
  const v = doneVerdict(finished(), NOW)
  assert.deepEqual(v, { close: true, personSteps: [] })
  const steps = doneVerdict(finished({ reply: 'Done.\n\n## Next steps\n- Robert: run /login on the PC\n- After that lands, nothing' }), NOW)
  assert.equal(steps.close, true)
  assert.deepEqual(steps.personSteps, ['Robert: run /login on the PC'])
  console.log('done-close: closes a finished pane, keeps person steps ok')
}

// 2. Every refusal.
{
  const refuse = (over, why) => {
    const v = doneVerdict(finished(over), NOW)
    assert.equal(v.close, false, why)
    return v.reason
  }
  assert.equal(refuse({ agent: 'shell' }), 'shell pane')
  assert.equal(refuse({ turnEndedAt: 0 }), 'no finished turn')
  assert.equal(refuse({ focused: true }), 'somebody is looking at it')
  assert.equal(refuse({ lastKeyboard: NOW - 10_000 }), 'not quiet long enough', 'typing restarts the clock')
  assert.equal(refuse({ turnEndedAt: NOW - 30_000 }), 'not quiet long enough')
  assert.match(refuse({ ask: { q: 'which?' } }), /busy, asking/)
  assert.match(refuse({ drafting: true }), /busy, asking/)
  assert.match(refuse({ backJob: 'npm run build' }), /busy, asking/)
  assert.match(refuse({ backJob: 'npm run build', backWaitOnly: false }), /busy, asking/)
  assert.equal(doneVerdict(finished({ backJob: 'gh', backWaitOnly: true }), NOW).close, true, 'a pane only waiting on CI closes')
  assert.match(refuse({ backJob: 'gh', backWaitOnly: true, reply: 'Which branch?' }), /question/, 'a wait never excuses a question')
  assert.match(refuse({ runSince: NOW - 1000 }), /busy, asking/)
  assert.match(refuse({ status: 'exited' }), /busy, asking/)
  assert.match(refuse({ asleep: NOW - 1000 }), /busy, asking/)
  assert.equal(refuse({ reply: undefined }), 'reply not read')
  assert.equal(refuse({ runningAgents: 2 }), '2 subagents still running')
  assert.equal(refuse({ reply: 'Which port should it use?' }), 'the reply ends in a question')
  assert.equal(refuse({ reply: 'Done.\n\n## Next steps\n- Wire the PC watcher\n- Robert: approve' }), '1 step an agent could take')
  console.log('done-close: refusals ok')
}

// 3. One id per finished turn.
assert.equal(doneReviewId('pane 1', 1_800_000_000_500), 'done_pane_1_1800000000')

// 4. The sweep: records, notices, closes; a refused close records once.
{
  const transcript = join(work, 'pane.jsonl')
  const row = (type, content) => JSON.stringify({ type, isSidechain: false, message: { role: type, content } })
  writeFileSync(transcript, [
    row('user', 'fix the login'),
    row('assistant', [{ type: 'text', text: 'Fixed the login.\n\n## Next steps\n- Robert: run /login on the PC\n- Robert: approve the Vercel build' }])
  ].join('\n'))
  const written = []
  const records = []
  const closes = []
  const notes = []
  const activity = []
  let closeAnswer = { closed: true }
  const readings = [{ id: 'p1', ...finished({ reply: undefined, runningAgents: undefined }) }, { id: 'sh', ...finished({ agent: 'shell' }) }]
  const deps = {
    enabled: () => true,
    readings: () => readings,
    transcriptFor: (id) => (id === 'p1' ? transcript : null),
    resumeIdFor: (id) => (id === 'p1' ? 'native-1' : undefined),
    history: () => [{ id: 'p1', title: 'login fix', cwd: '/Users/r/Projects/site', agent: 'claude', startedAt: NOW - 600_000, bytes: 1, gist: 'fix the login', askLines: ['fix the login'] }],
    titleOf: (id) => (id === 'p1' ? { title: 'login fix', cwd: '/Users/r/Projects/site', agent: 'claude' } : undefined),
    otherwiseBusy: () => null,
    record: (input, native) => { records.push(input); return { ...input, ...native, provider: native.agent ?? 'claude', title: native.title, reportPath: '/x', createdAt: 'now', attention: false } },
    close: (id, at) => { closes.push([id, at]); return closeAnswer },
    noteClose: (id, reason, at) => notes.push([id, reason, at]),
    writeNotice: (path, body) => written.push([path, JSON.parse(body)]),
    activity: (what, why) => activity.push([what, why]),
    openerOf: (id) => (id === 'p1' ? 'boss' : undefined),
    finished: (opener, note) => told.push([opener, note]),
    now: () => NOW
  }
  const told = []
  closeAnswer = { closed: false, reason: 'session is busy or has a background job' }
  assert.deepEqual(main.sweepDoneClose(deps), [])
  main.sweepDoneClose(deps)
  assert.equal(records.length, 2, 'the record call is idempotent upstream, so it is made each tick')
  assert.equal(written.length, 2, 'notices are written once per turn, not per tick')
  assert.equal(notes.filter((n) => n[1]).length, 2, 'each refused close is noted')
  closeAnswer = { closed: true }
  assert.deepEqual(main.sweepDoneClose(deps), ['p1'])
  const rec = records[0]
  assert.equal(rec.id, doneReviewId('p1', readings[0].turnEndedAt))
  assert.equal(rec.kind, 'result')
  assert.equal(rec.proof, 'unverified')
  assert.equal(rec.prompt, 'fix the login')
  assert.match(rec.report, /Fixed the login/)
  assert.equal(rec.noRemainingWork, false)
  assert.equal(rec.closeSession, true)
  assert.equal(rec.notify, true, 'a chat that closes itself asks GuardDeck for a result card')
  const [path, notice] = written[0]
  // `noticesDir()` joins with the platform separator, so on Windows this is
  // `...\guarddeck\notices\...`; normalize before matching against the posix-style pattern.
  assert.match(path.split('\\').join('/'), /guarddeck\/notices\/paneforge-step-done_p1_\d+-1\.json$/)
  assert.equal(notice.actor, 'paneforge')
  assert.equal(notice.kind, 'step')
  assert.equal(notice.machine, 'pc', 'the step said "on the PC"')
  assert.equal(written[1][1].machine, process.platform === 'win32' ? 'pc' : 'mac', 'a step naming no machine is this machine')
  assert.equal(notice.title, 'To do: Robert: run /login on the PC')
  assert.equal(notice.detail, 'site - fix the login')
  assert.deepEqual(Object.keys(notice.reopen).sort(), ['agent', 'cwd', 'prompt', 'resumeId', 'title'])
  assert.equal(notice.reopen.resumeId, 'native-1')
  assert.equal(notes.at(-1)[0], rec.id)
  assert.ok(notes.at(-1)[2], 'the close is stamped on the record')
  assert.deepEqual(activity, [['login fix', 'finished, 2 things left for you']])
  assert.equal(closes.length, 3)
  assert.equal(told.length, 1, 'the opener is noted once, and only for the close that happened')
  assert.equal(told[0][0], 'boss')
  assert.equal(told[0][1].project, 'site')
  assert.match(told[0][1].summary, /Fixed the login/)
  assert.deepEqual(told[0][1].personSteps, ['Robert: run /login on the PC', 'Robert: approve the Vercel build'], 'person steps travel with the summary')
  // Off means off, before any disk is touched.
  assert.deepEqual(main.sweepDoneClose({ ...deps, enabled: () => false, transcriptFor: () => { throw new Error('read') } }), [])
  console.log('done-close: sweep records, notices, closes ok')
}

// 4b. "Somebody is looking at it" needs a person, not just a selected pane. PC 2026-09-24:
// the selected pane of a four-pane desk sat finished for 14 minutes with the window behind
// another app, because there is always a selected pane.
{
  assert.equal(personLooking(true, true, true), true, 'selected, window has the keyboard, person at the desk')
  assert.equal(personLooking(true, false, true), false, 'window behind another app')
  assert.equal(personLooking(true, true, false), false, 'nobody at the desk, or the window minimised')
  assert.equal(personLooking(false, true, true), false, 'a different pane is selected')
  console.log('done-close: looking needs a person ok')
}

// 4c. Why a pane stayed lands in a log, once per change of reason.
{
  const lines = []
  const readings = [{ id: 'sel', ...finished({ focused: true }) }, { id: 'mid', ...finished({ turnEndedAt: 0 }) }]
  const deps = {
    enabled: () => true, readings: () => readings, transcriptFor: () => null, resumeIdFor: () => undefined,
    history: () => [], titleOf: () => undefined, otherwiseBusy: () => null, record: () => { throw new Error('no') },
    close: () => ({ closed: false }), noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, log: (line) => lines.push(line)
  }
  main.sweepDoneClose(deps)
  main.sweepDoneClose(deps)
  assert.deepEqual(lines, ['sel stays - somebody is looking at it'], 'one line per reason; a pane mid-turn says nothing')
  readings[0] = { id: 'sel', ...finished({ focused: false }) }
  main.sweepDoneClose(deps)
  assert.equal(lines.at(-1), 'sel stays - reply not read', 'a new reason is a new line')
  console.log('done-close: stay reasons are logged ok')
}

// 5. A reply longer than the read window still reads its tail.
{
  const big = join(work, 'big.jsonl')
  const filler = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] } })
  writeFileSync(big, [...Array(400).fill(filler), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the end' }] } })].join('\n'))
  assert.equal(main.readReply('claude', big, NOW).text, 'the end')
  assert.equal(main.readReply('claude', join(work, 'missing.jsonl'), NOW), undefined)
  console.log('done-close: tail read ok')
}

// 6. Source: the sweep is wired, the window says which pane it is looking at.
{
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.ok(index.includes('sweepDoneClose({'), 'index.ts runs the sweep')
  assert.ok(index.includes("ipcMain.on('sessions:active'"), 'index.ts hears the active pane')
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.ok(sessions.includes('doneReadings()'), 'the manager supplies readings')
  assert.ok(sessions.includes('focused: personLooking(m.id === this.activeId, this.windowFocused(), this.deskWatched())'), 'focused means a person is looking')
  assert.ok(index.includes('manager.windowFocused = (): boolean => focused'), 'index.ts says when the window has the keyboard')
  assert.ok(index.includes("'done-close.log'"), 'stay reasons are written to disk')
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  assert.ok(app.includes('window.api.activePane(activeId)'), 'the window reports the active pane')
  const settings = readFileSync(join(root, 'src/renderer/src/components/SettingsDialog.tsx'), 'utf8')
  assert.ok(settings.includes('autoCloseDone'), 'there is a switch')
  console.log('done-close: source wiring ok')
}

// 5. The panes a chat opened report back ONCE, when the last has closed (Robert
// 2026-09-23: "get summary in 1 session and leave it open").
{
  assert.equal(doneVerdict(finished({ openedOthers: true }), NOW).close, false, 'an opener is never auto-closed')
  const reply = '## Done\n\nFixed **the login** and `npm test` passes.\n\n- one\n- two\n\n## Next steps\n- None'
  assert.equal(digest.summaryOf(reply), 'Done Fixed the login and npm test passes. one two')
  assert.ok(digest.summaryOf('word '.repeat(200)).length <= digest.SUMMARY_CHARS + 1, 'a long reply is cut to one short line')
  assert.match(digest.summaryOf('word '.repeat(200)), /…$/)
  const d = new digest.FinishedDigest()
  const note = (id, title) => ({ id, title, project: 'taskdriver.ai', summary: `did ${title}`, personSteps: [] })
  const sent = []
  let open = 2
  const tell = (o, t) => { sent.push([o, t]); return true }
  d.add('boss', note('a', 'idea 1'), NOW)
  d.add('boss', note('a', 'idea 1'), NOW)
  assert.deepEqual(d.flush(() => open, tell, NOW + 1000), [], 'held while siblings are still open')
  d.add('boss', { ...note('b', 'idea 2'), personSteps: ['log in on the PC'] }, NOW + 2000)
  open = 0
  assert.deepEqual(d.flush(() => open, tell, NOW + 3000), ['boss'])
  assert.equal(sent.length, 1, 'one prompt for all of them')
  assert.match(sent[0][1], /^All 2 panes you opened have finished and closed into Review\. 1\) "idea 1" \(taskdriver\.ai\): did idea 1 2\) "idea 2"/)
  assert.match(sent[0][1], /Left for you: log in on the PC\./)
  assert.doesNotMatch(sent[0][1], /\n/, 'one line: it is typed into a CLI')
  assert.equal(d.size(), 0)
  d.add('boss', note('c', 'idea 3'), NOW)
  assert.deepEqual(d.flush(() => 1, tell, NOW + digest.DIGEST_MAX_HOLD_MS - 1), [])
  assert.deepEqual(d.flush(() => 1, tell, NOW + digest.DIGEST_MAX_HOLD_MS), ['boss'], 'a stuck sibling does not hold the summary for ever')
  assert.match(sent[1][1], /^The pane you opened for "idea 3".* 1 other pane is still open\.$/)
  d.add('gone', note('d', 'x'), NOW)
  assert.deepEqual(d.flush(() => 0, () => false, NOW), [], 'an opener that has gone is dropped, not retried')
  assert.equal(d.size(), 0)
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.ok(index.includes('finishedDigest.flush('), 'index.ts flushes the digest')
  assert.ok(index.includes('manager.onFinished ='), '--close-when-done panes feed it too')
  const ctl = readFileSync(join(root, 'scripts/pf-ctl.mjs'), 'utf8')
  assert.doesNotMatch(ctl, /reportTo: closeWhenDone \? reportTo/, 'pf open always says who opened the pane')
  console.log('done-close: one summary back to the opener ok')
}

{
  // The card's `done` word: s9-muig454z's real last reply (2026-09-26), which the card
  // called `waiting` though it left nothing for anybody.
  const s9 = 'I saved the stuck-command lesson to the knowledge vault as a draft: a command cut off when its chat dies never records that it finished, so checks now ask whether anything is still writing its output. The auto-close fix it describes is pushed (`58283556a`).\n\nCard 11 is still working on the "waiting" label.\n\nNext steps: None'
  const base = { agent: 'claude', status: 'idle', turnEndedAt: 1, reply: s9 }
  assert.equal(replyFinished(base), true, 'Next steps: None = finished')
  assert.equal(replyFinished({ ...base, reply: 'Done. Want me to ship it?' }), false, 'a question is not finished')
  assert.equal(replyFinished({ ...base, reply: 'Built it.\n\n## Next steps\n1. Run the PC suite and fix what fails' }), false, 'an agent step is not finished')
  assert.equal(replyFinished({ ...base, runningAgents: 1 }), false, 'a subagent still out is not finished')
  assert.equal(replyFinished({ ...base, status: 'working' }), undefined, 'mid-turn: unknown')
  assert.equal(replyFinished({ ...base, ask: { q: 1 } }), undefined, 'a question card: unknown, the ask draws')
  assert.equal(replyFinished({ ...base, agent: 'shell' }), undefined)
  assert.equal(replyFinished({ ...base, turnEndedAt: 0 }), undefined, 'no ended turn: unknown')
  assert.equal(replyFinished({ ...base, reply: '  ' }), undefined, 'empty reply: unknown')
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.match(sessions, /meta\.finished = fin/, 'the sweep sets Session.finished')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(index, /manager\.replyFor = /, 'index.ts gives the sweep the transcript')
  console.log('done-close: finished card word ok')
}
