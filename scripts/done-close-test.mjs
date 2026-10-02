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
const { seedTurnEnd, doneVerdict, folderLeftover, whyNotDone, doneReviewId, doneQuietMs, personLooking, replyFinished, closeHeldBy, wasRead, waitsForYou, AUTO_CLOSE_QUIET_MS, DONE_COUNTDOWN_MS, READ_QUIET_MS } = await bundle('src/shared/doneClose.ts', 'shared.cjs')
const { handoffOpenAfter } = await bundle('src/shared/handoffSteps.ts', 'handoffsteps.cjs')
const digest = await bundle('src/shared/finishedDigest.ts', 'digest.cjs')
const main = await bundle('src/main/doneClose.ts', 'main.cjs')

const NOW = 1_800_000_000_000
const finished = (over = {}) => ({
  agent: 'claude', printed: NOW - 600_000, status: 'idle', lastKeyboard: NOW - 400_000,
  turnEndedAt: NOW - AUTO_CLOSE_QUIET_MS - 1000, reply: 'Built it.\n\n## Next steps\n- None', runningAgents: 0, ...over
})

// A native async question finishes its terminal turn before GuardDeck receives the
// answer. Exercise the manager's actual methods, with only their environment stubbed.
{
  const source = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const method = (name, next) => {
    const start = source.indexOf(`  ${name}(`)
    const end = source.indexOf(`  ${next}(`, start)
    assert.ok(start >= 0 && end > start, `real ${name} method exists`)
    return source.slice(start, end)
  }
  const fixture = join(work, 'question-manager.ts')
  writeFileSync(fixture, `
import { heldByGuardDeck } from ${JSON.stringify(join(root, 'src/shared/autoAnswer.ts'))}
import { guardDeckQuestions, readGuardDeckQuestions } from ${JSON.stringify(join(root, 'src/main/guardDeckQuestions.ts'))}
import { closeHeldBy, personLooking } from ${JSON.stringify(join(root, 'src/shared/doneClose.ts'))}
const backJobWaitOnly = () => false
let native: string | undefined = 'synthetic-native'
const resumeIdFor = () => native
export const nativeClaim = (value: string | undefined) => { native = value }
export class Harness {
  sessions = new Map(); activeId = null; killed: unknown[] = []
  windowFocused = () => false; deskWatched = () => false
  openChildrenOf = () => 0; workingChildrenOf = () => 0; digestPending = () => false; owesPrompt = () => false
  kill(id: string, by: string) { this.killed.push([id, by]); this.sessions.delete(id); return true }
  replyFor = null; turnOpenFor = () => null
${method('doneReadings', 'turnRead')}
${method('closeAfterResult', 'killAll')}
}
`)
  const { Harness, nativeClaim } = await bundle(fixture, 'question-manager.cjs')
  const now = Date.now()
  let directory = 0
  const previousDir = process.env.GD_QUESTIONS_DIR
  const records = (values) => {
    const dir = join(work, `questions-${directory++}`)
    mkdirSync(dir)
    values.forEach((value, i) => writeFileSync(join(dir, `${i}.json`), value === 'bad-json' ? '{' : JSON.stringify(value)))
    process.env.GD_QUESTIONS_DIR = dir
  }
  const question = (over = {}) => ({ pane: { id: 'synthetic-pane' }, session_id: 'synthetic-native', state: 'open', created: new Date(now).toISOString(), ...over })
  const fresh = (over = {}) => {
    const h = new Harness()
    h.sessions.set('synthetic-pane', { meta: { id: 'synthetic-pane', agent: 'codex', printed: now - 600_000, status: 'idle', lastKeyboard: now - 400_000, ...over }, busyUntil: 0, footerEndedAt: now - AUTO_CLOSE_QUIET_MS - 1000 })
    return h
  }
  const verdict = (h) => doneVerdict({ ...h.doneReadings()[0], reply: 'PROBE_READY', runningAgents: 0 }, now)
  try {
    for (const state of ['open', 'sending', 'queued']) {
      records([question({ state })])
      const h = fresh()
      assert.equal(verdict(h).close, false, `${state}: pending GuardDeck question keeps a finished native turn open`)
      assert.deepEqual(h.closeAfterResult('synthetic-pane', now), { closed: false, reason: 'session has a question' }, `${state}: final close boundary also holds`)
      assert.deepEqual(h.killed, [])
    }
    records([question({ pane: { id: 'previous-pane' } })])
    let h = fresh()
    assert.equal(verdict(h).close, false, 'a reopened pane of the same verified native conversation remains open')
    assert.equal(h.closeAfterResult('synthetic-pane', now).closed, false)
    for (const value of [
      question({ pane: { id: 'other-pane' }, session_id: 'other-native' }),
      question({ state: 'answered' }), question({ state: 'expired' }),
      question({ created: new Date(now - 25 * 60 * 60_000).toISOString() }),
      question({ created: undefined }), null, 'bad-json'
    ]) {
      records([value]); h = fresh()
      assert.equal(verdict(h).close, true, 'foreign, resolved, expired or unreadable questions do not disable ordinary autoclose')
      assert.deepEqual(h.closeAfterResult('synthetic-pane', now), { closed: true })
      assert.deepEqual(h.killed, [['synthetic-pane', 'review']])
    }
    nativeClaim(undefined)
    records([question({ pane: { id: 'other-pane' } })]); h = fresh()
    assert.equal(verdict(h).close, true, 'matching a reopened pane requires a verified native identity')
    nativeClaim('synthetic-native')
    records([]); h = fresh({ ask: { question: 'terminal question' } })
    assert.equal(verdict(h).close, false, 'terminal questions still hold')
    assert.equal(h.closeAfterResult('synthetic-pane', now).closed, false)
    records([]); h = fresh()
    assert.equal(verdict(h).close, true)
    writeFileSync(join(process.env.GD_QUESTIONS_DIR, 'new.json'), JSON.stringify(question()))
    assert.equal(h.closeAfterResult('synthetic-pane', now).closed, false, 'a question arriving after the sweep reading prevents the kill')
    assert.deepEqual(h.killed, [])

    // s48-mupgz5iq, 1 Oct 9:58-10:06pm Gold Coast: a finished pane closeAfterResult holds (a
    // handoff with open steps) got a 30-second close countdown on every sweep, twelve in all,
    // each refused at its end and armed again. The sweep refuses on the same holds first.
    records([]); h = fresh({ agent: 'claude', handoffOpen: 2 })
    const heldReply = join(work, 'held.jsonl')
    writeFileSync(heldReply, JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n## Next steps\n- None' }] } }))
    const clocks = []
    const rows = []
    const heldLines = []
    const heldDeps = {
      enabled: () => true, readings: () => h.doneReadings(), now: () => now,
      transcriptFor: () => heldReply, resumeIdFor: () => 'synthetic-native', history: () => [],
      titleOf: () => ({ title: 'held', cwd: '/Users/r/Projects/assistant', agent: 'claude' }), otherwiseBusy: () => null,
      record: (input, native) => { rows.push(input.id); return { ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false } },
      notify: () => {}, close: (id, at) => h.closeAfterResult(id, at), noteClose: () => {}, writeNotice: () => {}, activity: () => {},
      setClosing: (id, at) => clocks.push([id, at]), log: (l) => heldLines.push(l)
    }
    for (let i = 0; i < 3; i++) assert.deepEqual(main.sweepDoneClose(heldDeps), [])
    assert.deepEqual(clocks.filter(([, at]) => at !== undefined), [], 'a held pane never gets a close countdown')
    assert.deepEqual(rows, [], 'and no Review row')
    assert.deepEqual(heldLines, ['synthetic-pane stays - session has a handoff with open steps'], 'the reason is logged once')
    assert.deepEqual(h.killed, [])
    console.log('done-close: real manager preserves pending async questions at both boundaries, exact reopened identity and ordinary closure ok')
  } finally {
    if (previousDir === undefined) delete process.env.GD_QUESTIONS_DIR
    else process.env.GD_QUESTIONS_DIR = previousDir
  }
}

// 1. The one shape that closes, and its person-only steps.
{
  const v = doneVerdict(finished(), NOW)
  assert.deepEqual(v, { close: true, personSteps: [], read: false })
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
  // Robert, 2026-10-03: "if i go in paneforge in that chat it shouldn't stop the coutndown".
  assert.equal(doneVerdict(finished({ focused: true, lookedAt: NOW - 1_000 }), NOW).close, true, 'looking at it never holds it')
  // Robert, 2026-09-29: a pane he kept open for a long job must stay to be read and continued.
  assert.equal(refuse({ kept: true }), 'kept open by hand')
  assert.equal(refuse({ kept: true, lookedAt: NOW - 60_000, turnEndedAt: NOW - 90_000 }), 'kept open by hand', 'read does not undo a keep')
  assert.equal(refuse({ lastKeyboard: NOW - 10_000 }), 'not quiet long enough', 'typing restarts the clock')
  assert.equal(refuse({ turnEndedAt: NOW - 30_000 }), 'not quiet long enough')
  assert.equal(refuse({ ask: { q: 'which?' } }), 'a question on screen')
  assert.equal(refuse({ drafting: true }), 'an unsent draft in its prompt box')
  assert.equal(refuse({ backJob: 'npm run build' }), 'a background job (npm run build)')
  assert.equal(refuse({ backJob: 'npm run build', backWaitOnly: false }), 'a background job (npm run build)')
  assert.equal(doneVerdict(finished({ backJob: 'gh', backWaitOnly: true }), NOW).close, true, 'a pane only waiting on CI closes')
  assert.match(refuse({ backJob: 'gh', backWaitOnly: true, reply: 'Which branch?' }), /question/, 'a wait never excuses a question')
  assert.equal(refuse({ runSince: NOW - 1000 }), 'a turn running')
  assert.equal(refuse({ busyUntil: NOW + 1000 }), 'a turn running', 'the footer still saying so')
  assert.equal(refuse({ status: 'exited' }), 'its program has exited')
  assert.equal(refuse({ asleep: NOW - 1000, status: 'exited' }), 'asleep')
  assert.equal(refuse({ printed: 0 }), 'not started')
  assert.equal(refuse({ job: 'vim' }), 'busy or running something')
  // Quiet past the one-minute wait but printed in the last 8 s cannot happen through
  // doneVerdict (the same clock), so the 8 s refusal is asked of whyNotDone directly.
  assert.equal(whyNotDone(finished(), 3000, NOW), 'printed in the last 8 s')
  assert.equal(whyNotDone(finished(), 9000, NOW), null)
  assert.equal(refuse({ reply: undefined }), 'reply not read')
  assert.equal(refuse({ runningAgents: 2 }), '2 subagents still running')
  assert.equal(refuse({ reply: 'Which port should it use?' }), 'the reply ends in a question')
  assert.equal(refuse({ reply: 'Done.\n\n## Next steps\n- Wire the PC watcher\n- Robert: approve' }), '1 step an agent could take')
  console.log('done-close: refusals ok')
}

// 2b. s42 on 1 Oct, finished 11:53pm Thu: its real report, read the way the sweep reads it
// (`main/doneClose.ts` `readReply` over `fixtures/claude-stophook-followup.jsonl`). Its
// steps sit under `**Next steps:**`, a label and not a heading, so none were read: the
// GuardDeck card never got 'Say "release"', and step 1 read as nobody's.
{
  const s42 = main.readReply('claude', join(root, 'scripts/fixtures/claude-stophook-followup.jsonl'))
  const v = doneVerdict(finished({ reply: s42.text, runningAgents: s42.runningAgents }), NOW)
  assert.equal(v.close, true, JSON.stringify(v))
  assert.match(v.personSteps[0] ?? '', /^Say "release" to ship main/, 'the release is Robert\'s step')
  assert.ok(!v.personSteps.some((x) => /^record a test call|^read today/.test(x)), 'sub-bullets under a step are not steps')
  // The same label shapes, on their own.
  const steps = (reply) => doneVerdict(finished({ reply }), NOW)
  assert.equal(steps('Done.\n\n**Next steps:**\n1. Wire the PC watcher').reason, '1 step an agent could take', 'a label line is a heading')
  assert.equal(steps('Done.\n\nNext steps: wire the PC watcher').reason, '1 step an agent could take', 'a step on the label line itself')
  assert.equal(steps('Done.\n\n**Next steps:** None').close, true)
  assert.equal(steps('Done.\n\n**Next steps:**\n- None\n\n**Notes:**\n- the PC was slow').close, true, 'a bold label ends the steps')
  assert.deepEqual(steps('Done.\n\n**Next steps:**\n1. Tell me which port to use').personSteps, ['Tell me which port to use'])
  assert.deepEqual(steps('Done.\n\n## Next steps\n- Reply "yes" to merge').personSteps, ['Reply "yes" to merge'])
  console.log('done-close: s42 report read, its release step is Robert\'s ok')
}

// 2a. A machine short of memory waits less. Robert 2026-09-28: "id rather they close than
// sleep" - the pressure sleep's own clocks (1 min tight, 30 s over) move to the close.
{
  // Robert, 2026-10-03: "3 minutes is too long i think make it 1 minute by default".
  assert.equal(AUTO_CLOSE_QUIET_MS, 60_000)
  assert.equal(doneQuietMs('ok'), AUTO_CLOSE_QUIET_MS)
  assert.equal(doneQuietMs('tight'), 30_000)
  assert.equal(doneQuietMs('over'), 15_000)
  const ninety = finished({ turnEndedAt: NOW - 45_000 })
  assert.equal(doneVerdict(ninety, NOW).reason, 'not quiet long enough', 'the default wait is one minute')
  assert.equal(doneVerdict(ninety, NOW, doneQuietMs('ok')).close, false, 'room to spare: still one minute')
  assert.equal(doneVerdict(ninety, NOW, doneQuietMs('tight')).close, true, 'tight: forty-five seconds is enough')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 20_000 }), NOW, doneQuietMs('tight')).close, false, 'tight: twenty seconds is not')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 20_000 }), NOW, doneQuietMs('over')).close, true, 'over: twenty seconds is')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 61_000 }), NOW).close, true, 'a minute and a second: closes')
  // The sweep passes its dep through to both verdicts; unset is the default wait.
  const transcript = join(work, 'quiet.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n## Next steps\n- None' }] } }))
  const shut = []
  const deps = (quietMs) => ({
    enabled: () => true,
    readings: () => [{ id: 'q1', ...finished({ turnEndedAt: NOW - 45_000, reply: undefined, runningAgents: undefined }) }],
    transcriptFor: () => transcript, resumeIdFor: () => 'native-q', history: () => [],
    titleOf: () => ({ title: 'quiet', cwd: '/Users/r/Projects/site', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => ({ ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false }),
    notify: () => {}, markRead: () => {},
    close: (id) => { shut.push(id); return { closed: true } }, noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, ...(quietMs ? { quietMs } : {})
  })
  assert.deepEqual(main.sweepDoneClose(deps()), [], 'no quietMs dep: one minute')
  assert.deepEqual(main.sweepDoneClose(deps(() => doneQuietMs('tight'))), ['q1'], 'the sweep uses the dep')
  console.log('done-close: a short machine waits less ok')
}

// 2b. A folder with work left NEVER holds a finished pane (Robert, 2026-10-02: "we dont need
// that guard anymore since we have reports"). The pane closes into Review and the Review record
// says what it left behind. 748 of ~950 holds on 1-2 Oct were the folder.
{
  const v = (folder) => doneVerdict(finished({ folder }), NOW)
  for (const folder of [undefined, null, { dirty: 0, ahead: 0 }, { dirty: 3, ahead: 0 }, { dirty: 0, ahead: 2 }, 'unread'])
    assert.equal(v(folder).close, true, `closes whatever its folder holds: ${JSON.stringify(folder)}`)
  assert.equal(doneVerdict(finished({ folder: { dirty: 3, ahead: 0 }, reply: 'Which port?' }), NOW).reason, 'the reply ends in a question', 'the reply still speaks first')
  // The words a person reads: plain, singular and plural right, nothing for a clean or unknown folder.
  assert.equal(folderLeftover(undefined, 'site'), undefined, 'not asked')
  assert.equal(folderLeftover(null, 'site'), undefined, 'not a repo')
  assert.equal(folderLeftover('unread', 'site'), undefined, 'no read yet: say nothing rather than guess')
  assert.equal(folderLeftover({ dirty: 0, ahead: 0 }, 'site'), undefined, 'clean and pushed')
  assert.equal(folderLeftover({ dirty: 1, ahead: 0 }, 'site'), 'Left in site: 1 changed file')
  assert.equal(folderLeftover({ dirty: 6, ahead: 0 }, 'site'), 'Left in site: 6 changed files')
  assert.equal(folderLeftover({ dirty: 0, ahead: 1 }, 'site'), 'Left in site: 1 commit not pushed')
  assert.equal(folderLeftover({ dirty: 0, ahead: 2 }, 'site'), 'Left in site: 2 commits not pushed')
  assert.equal(folderLeftover({ dirty: 6, ahead: 2 }, 'toolstash'), 'Left in toolstash: 6 changed files, 2 commits not pushed')
  assert.equal(folderLeftover({ dirty: 1, ahead: 1 }, 'toolstash'), 'Left in toolstash: 1 changed file, 1 commit not pushed')
  assert.doesNotMatch(folderLeftover({ dirty: 6, ahead: 2 }, 'x'), /dirty|ahead|worktree|lane|uncommitted/i, 'no git words')
  // The sweep reads the folder only for a pane past every cheap gate, never holds for it,
  // and writes what was left into the Review row and the close log line.
  const transcript = join(work, 'folder.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n## Next steps\n- None' }] } }))
  const asked = []
  const lines = []
  const records = []
  let answers = [{ dirty: 6, ahead: 2 }]
  const deps = {
    enabled: () => true,
    readings: () => [{ id: 'f1', ...finished({ reply: undefined, runningAgents: undefined }) }, { id: 'f2', ...finished({ turnEndedAt: NOW - 10_000 }) }, { id: 'f3', ...finished({ lastKeyboard: NOW - 5_000 }) }],
    folderOf: (id) => { asked.push(id); return answers.length > 1 ? answers.shift() : answers[0] },
    transcriptFor: () => transcript, resumeIdFor: () => 'native-f', history: () => [],
    titleOf: () => ({ title: 'folder', cwd: '/Users/r/Projects/toolstash', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => { records.push(input); return { ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false } },
    notify: () => {}, markRead: () => {},
    close: () => ({ closed: true }), noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, log: (l) => lines.push(l)
  }
  assert.deepEqual(main.sweepDoneClose(deps), ['f1'], 'changed files and unpushed commits no longer hold it')
  assert.ok(asked.length >= 1 && asked.every((id) => id === 'f1'), 'a pane mid-quiet or just typed into never costs a folder read')
  assert.deepEqual(records[0].evidence, ['Left in toolstash: 6 changed files, 2 commits not pushed'], 'the Review row says what was left')
  assert.match(lines.find((l) => l.startsWith('f1')), /^f1 finished and closed itself into Review \(done_f1_\d+\) - Left in toolstash: 6 changed files, 2 commits not pushed$/, 'done-close.log says it too')
  // A clean folder, not a repo, and a read still in flight: closes, writes no line.
  for (const [what, answer] of [['clean', { dirty: 0, ahead: 0 }], ['not a repo', null], ['unread', 'unread']]) {
    records.length = 0; lines.length = 0; asked.length = 0
    answers = [answer]
    assert.deepEqual(main.sweepDoneClose(deps), ['f1'], `${what}: closes`)
    assert.deepEqual(records[0].evidence, [], `${what}: no leftover line in the row`)
    assert.doesNotMatch(lines.find((l) => l.startsWith('f1')), / - Left in/, `${what}: no leftover in the log`)
  }
  // 'unread' on the first ask (a read was started) is asked again at the real close.
  records.length = 0; lines.length = 0; asked.length = 0
  answers = ['unread', { dirty: 1, ahead: 0 }]
  assert.deepEqual(main.sweepDoneClose(deps), ['f1'])
  assert.ok(asked.length >= 2, 'asked again at the close')
  assert.deepEqual(records[0].evidence, ['Left in toolstash: 1 changed file'], 'the second answer is the one written')
  const git = readFileSync(join(root, 'src/main/git.ts'), 'utf8')
  assert.match(git, /export function gitCached\(/, 'the cached read exists')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(index, /folderOf: \(id, since\) => \{[\s\S]{0,160}gitCached\(cwd, since\)/, 'index.ts feeds the sweep the cached read, never a spawn, no older than the turn')
  const since = []
  answers = [{ dirty: 0, ahead: 0 }]
  main.sweepDoneClose({ ...deps, folderOf: (id, t) => { since.push([id, t]); return answers[0] } })
  assert.equal(since[0][0], 'f1')
  assert.equal(since[0][1], deps.readings()[0].turnEndedAt, 'the sweep hands the folder read its turn end')
  console.log('done-close: a folder with work left no longer holds its pane, the review says what was left ok')
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
    notify: (id, looked, opener) => { cards.push(id); openers.push(opener) },
    markRead: (id) => reads.push(id),
    activity: (what, why) => activity.push([what, why]),
    openerOf: (id) => (id === 'p1' ? 'boss' : undefined),
    finished: (opener, note) => told.push([opener, note]),
    now: () => NOW
  }
  const told = []
  const cards = []
  const openers = []
  const reads = []
  closeAnswer = { closed: false, reason: 'session is busy or has a background job' }
  assert.deepEqual(main.sweepDoneClose(deps), [])
  main.sweepDoneClose(deps)
  assert.equal(records.length, 2, 'the record call is idempotent upstream, so it is made each tick')
  assert.equal(written.length + cards.length, 0, 'a refused close sends nothing to GuardDeck: no to-do, no card (s93)')
  assert.equal(notes.filter((n) => n[1]).length, 2, 'each refused close is noted')
  closeAnswer = { closed: true }
  assert.deepEqual(main.sweepDoneClose(deps), ['p1'])
  assert.equal(written.length, 2, 'the to-dos go once the pane has closed')
  assert.deepEqual(cards, [doneReviewId('p1', readings[0].turnEndedAt)], 'steps left and nobody read it: one result card, after the close')
  assert.deepEqual(openers, ['boss'], "the opener reaches the notice, so the phone push is the opener's to send (one push, not two)")
  assert.deepEqual(reads, [], 'unread stays unread in Review')
  const rec = records[0]
  assert.equal(rec.id, doneReviewId('p1', readings[0].turnEndedAt))
  assert.equal(rec.kind, 'result')
  assert.equal(rec.proof, 'unverified')
  assert.equal(rec.prompt, 'fix the login')
  assert.match(rec.report, /Fixed the login/)
  assert.equal(rec.noRemainingWork, false)
  assert.equal(rec.closeSession, true)
  assert.equal(rec.notify, true, 'the row carries the card; `record` holds it (index.ts) until `notify` sends it')
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

// 4a. Read, then close (guarddeck chat s94's brief, 2026-09-28). Robert, 3:54am: "shouldn't
// have shown me report ... that had no manual things that i needed to see ... i already
// reviewed the session ... should've closed that session automatically after like 30secs
// after i read it".
{
  // (c) Looking never holds, delays or cancels a close (Robert, 2026-10-03: "if i go in
  // paneforge in that chat it shouldn't stop the coutndown"). It only marks the verdict
  // read, which spares the phone a push. Typing still restarts the quiet.
  assert.equal(READ_QUIET_MS, undefined, 'the 30 s after-a-look wait is gone')
  const ended = NOW - AUTO_CLOSE_QUIET_MS - 1_000
  const v = (over, now = NOW) => doneVerdict(finished({ turnEndedAt: ended, lastKeyboard: ended - 5_000, ...over }), now)
  assert.equal(v({ lookedAt: NOW - 1_000 }).close, true, 'a look a second ago does not hold it')
  assert.equal(v({ lookedAt: NOW - 1_000 }).read, true, 'and the verdict says it was read')
  assert.equal(v({}).read, false, 'nobody looked: unread')
  assert.equal(v({ lookedAt: ended - 1 }).read, false, 'a look from before this turn ended is an earlier turn\'s')
  assert.equal(wasRead({ turnEndedAt: ended, lookedAt: ended - 1 }), false)
  assert.equal(wasRead({ turnEndedAt: ended, lookedAt: ended }), true, 'watching it finish is reading it')
  assert.equal(v({ lookedAt: NOW - 20_000, lastKeyboard: NOW - 10_000 }).reason, 'not quiet long enough', 'typing restarts the quiet')
  assert.equal(v({ focused: true, lookedAt: NOW }).close, true, 'selected, window up, person here: still closes')
  assert.equal(v({ lookedAt: NOW - 1_000, reply: 'Which port?' }).reason, 'the reply ends in a question', 'read never excuses a question')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 59_000 }), NOW).reason, 'not quiet long enough', '59 s is not a minute')
  for (const reply of ['- **Unfinished:** tracking verification.', 'Seven tasks remain open.', 'The client job itself is not finished.', 'The check is queued.']) {
    assert.equal(doneVerdict(finished({ reply }), NOW).close, false, reply)
  }
  assert.equal(doneVerdict(finished({ reply: 'The work is complete.' }), NOW).close, true)
  // The sweep end to end, including the lost-report path: a selected pane was
  // inferred read, but its answer had no person-only action and was never acknowledged.
  const transcript = (name, text) => {
    const f = join(work, `${name}.jsonl`)
    writeFileSync(f, JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } }))
    return f
  }
  const files = {
    none: transcript('none', "That icon is uBlock Origin Lite, the ad blocker. The number is how many requests it has blocked."),
    noneLooked: transcript('noneLooked', 'Research complete. The report contains the findings.'),
    steps: transcript('steps', 'Built it.\n\n## Next steps\n- Robert: approve the Vercel build'),
    stepsRead: transcript('stepsRead', 'Built it.\n\n## Next steps\n- Robert: approve the Vercel build')
  }
  const at = NOW
  const readings = [
    { id: 'none', ...finished({ reply: undefined, runningAgents: undefined }) },
    { id: 'steps', ...finished({ reply: undefined, runningAgents: undefined }) },
    { id: 'stepsRead', ...finished({ reply: undefined, runningAgents: undefined, turnEndedAt: at - 60_000, lookedAt: at - 31_000 }) },
    { id: 'noneLooked', ...finished({ reply: undefined, runningAgents: undefined, turnEndedAt: at - 60_000, lookedAt: at - 31_000 }) }
  ]
  const cards = []
  const reads = []
  const todos = []
  const shut = []
  const lines = []
  const deps = {
    enabled: () => true,
    readings: () => readings,
    transcriptFor: (id) => files[id], resumeIdFor: (id) => `native-${id}`, history: () => [],
    titleOf: (id) => ({ title: id, cwd: '/Users/r/Projects/assistant', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => ({ ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false }),
    close: (id) => { shut.push(id); return { closed: true } }, noteClose: () => {},
    writeNotice: (path) => todos.push(path), notify: (id) => cards.push(id), markRead: (id) => reads.push(id),
    activity: () => {}, now: () => at, log: (l) => lines.push(l)
  }
  // `dry` (pf tidy --dry-run): the same answer, nothing touched.
  const recordsBefore = []
  const dry = main.sweepDoneClose({ ...deps, dry: true, record: (i) => { recordsBefore.push(i); throw new Error('dry run wrote a row') } })
  assert.deepEqual(dry, ['none', 'steps', 'stepsRead', 'noneLooked'], 'dry: what would close')
  assert.equal(shut.length + cards.length + reads.length + todos.length + lines.length + recordsBefore.length, 0, 'dry: no row, no close, no notice, no log line')
  // `quietMs: 0` is pf tidy's real run: the same refusals, no wait.
  assert.deepEqual(main.sweepDoneClose({ ...deps, dry: true, readings: () => [{ id: 'none', ...finished({ turnEndedAt: at - 20_000 }) }] }), [], 'not quiet: stays')
  assert.deepEqual(main.sweepDoneClose({ ...deps, dry: true, quietMs: () => 0, readings: () => [{ id: 'none', ...finished({ turnEndedAt: at - 20_000 }) }] }), ['none'], 'tidy asks without the quiet wait')
  assert.deepEqual(main.sweepDoneClose({ ...deps, dry: true, quietMs: () => 0, readings: () => [{ id: 'none', ...finished({ turnEndedAt: at - 20_000, reply: 'Which port?' }) }], transcriptFor: () => transcript('q', 'Which port?') }), [], 'and keeps every refusal')
  assert.deepEqual(main.sweepDoneClose({ ...deps, readings: () => readings.map(r => ({ ...r, kept: true })) }), [], 'kept sessions never start a close warning')
  assert.deepEqual(main.sweepDoneClose(deps), ['none', 'steps', 'stepsRead', 'noneLooked'])
  assert.deepEqual(cards, readings.map(r => doneReviewId(r.id, r.turnEndedAt)), 'every closed result requests delivery, including a looked-at answer with no actions')
  assert.deepEqual(reads, [], 'a glance never acknowledges any report')
  assert.equal(todos.length, 2, 'both panes with a person step still send their to-do')
  assert.ok(lines.some((l) => l === `stepsRead finished and closed itself into Review (${doneReviewId('stepsRead', readings[2].turnEndedAt)}), looked at`))

  // Automatic closure publishes a DONE_COUNTDOWN_MS warning (GuardDeck draws it). Looking at
  // the pane neither cancels nor restarts it; Keep open (`kept`, `sessions:keepOpen`) does.
  assert.equal(DONE_COUNTDOWN_MS, 15_000, 'Robert, 2026-10-03: "like 15secs"')
  let clock = at
  let focused = false
  let kept = false
  const deadlines = []
  const warned = { ...deps, readings: () => [{ ...readings[0], id: 'warning', focused, lookedAt: focused ? clock : undefined }],
    transcriptFor: () => files.none, now: () => clock,
    setClosing: (id, deadline) => deadlines.push([id, deadline]) }
  assert.deepEqual(main.sweepDoneClose(warned), [])
  assert.deepEqual(deadlines.at(-1), ['warning', at + 15_000])
  clock += 13_000
  focused = true
  const published = deadlines.length
  assert.deepEqual(main.sweepDoneClose(warned), [], 'going into the pane with 2 s left')
  assert.equal(deadlines.length, published, 'looking neither cancels nor restarts the countdown')
  clock += 2_000
  assert.deepEqual(main.sweepDoneClose(warned), ['warning'], 'it closes on time while somebody is looking')
  assert.deepEqual(deadlines.at(-1), ['warning', undefined])
  const stop = { ...warned, readings: () => [{ ...readings[0], id: 'stop', kept }] }
  assert.deepEqual(main.sweepDoneClose(stop), [])
  assert.deepEqual(deadlines.at(-1), ['stop', clock + 15_000])
  kept = true
  assert.deepEqual(main.sweepDoneClose(stop), [], 'GuardDeck Stop = Keep open')
  assert.deepEqual(deadlines.at(-1), ['stop', undefined], 'Keep open drops the countdown')
  clock += 15_000
  assert.deepEqual(main.sweepDoneClose(stop), [], 'and it never closes')
  kept = false
  main.sweepDoneClose(stop)
  assert.deepEqual(deadlines.at(-1), ['stop', clock + 15_000], 'unkept: a fresh countdown')
  main.sweepDoneClose({ ...stop, enabled: () => false })
  assert.equal(deadlines.at(-1)[1], undefined, 'disabling cancels published clock')

  // The close lands on the published deadline, not a tick later (review of e7965562). The
  // sweep runs every 15 s (index.ts) and reads `now` after building its readings, so on a
  // fake clock: tick 0 reads 40 ms in, tick 1 reads 3 ms in - 37 ms short of the deadline.
  // Before: tick 1 refused, the close came at tick 2, 14,963 ms late.
  const TICK = 15_000
  const t0 = at + 200_000
  let t = t0 + 40
  const lands = { ...warned, readings: () => [{ ...readings[0], id: 'lands' }], now: () => t }
  assert.deepEqual(main.sweepDoneClose(lands), [], 'tick 0 publishes the deadline')
  const deadline = deadlines.at(-1)[1]
  assert.equal(deadline, t0 + 40 + DONE_COUNTDOWN_MS)
  let closedAt
  for (let k = 1; k <= 3 && closedAt === undefined; k++) {
    t = t0 + k * TICK + 3
    if (main.sweepDoneClose(lands).includes('lands')) closedAt = t
  }
  assert.ok(closedAt !== undefined && Math.abs(closedAt - deadline) <= 1_000, `the close landed ${closedAt - deadline} ms from its deadline`)
  console.log(`done-close: the close landed ${closedAt - deadline} ms from its published deadline (a whole tick late before)`)
  t = t0 + 10 * TICK
  const early = { ...lands, readings: () => [{ ...readings[0], id: 'early' }] }
  main.sweepDoneClose(early)
  t += DONE_COUNTDOWN_MS - 1_500
  assert.deepEqual(main.sweepDoneClose(early), [], 'a second and a half early is still counting')

  // (d) What held s93-muk43els at 17:52:44Z on 27 Sep (done-close.log 258): `handoffOpen` -
  // /Users/robertiuoras/Projects/assistant's session-handoff.md, another chat's, five steps
  // open, written 16:06:40Z; the pane's prompt was 17:48. Now named, and ignored as stale.
  assert.deepEqual(closeHeldBy({ handoffOpen: 5 }), ['a handoff with open steps'])
  assert.deepEqual(closeHeldBy({ drafting: true, owedPrompt: 'queued', handoverUntil: NOW + 1 }, NOW), ['a draft', 'a queued prompt', 'a prompt being handed over'])
  assert.deepEqual(closeHeldBy({ handoverUntil: NOW - 1 }, NOW), [], 'a hand-over that has ended holds nothing')
  const s93Hand = { path: '/Users/robertiuoras/.claude/projects/-Users-robertiuoras-Projects-assistant/memory/session-handoff.md', open: 5, mtimeMs: Date.parse('2026-09-27T16:06:40Z') }
  assert.equal(handoffOpenAfter(s93Hand, Date.parse('2026-09-27T17:48:01Z')), undefined, 's93: a handoff older than the prompt holds nothing')
  assert.deepEqual(closeHeldBy({ handoffOpen: handoffOpenAfter(s93Hand, Date.parse('2026-09-27T17:48:01Z')) }), [], 's93 closes')
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.match(sessions, /if \(held\.length\) return \{ closed: false, reason: `session has \$\{held\.join\(', '\)\}` \}/, 'closeAfterResult names the flags')
  assert.match(sessions, /personLooking\(true, this\.windowFocused\(\), this\.deskWatched\(\)\)\) seen\.lookedAt = now/, 'the sweep stamps who is looking')
  assert.match(sessions, /lookedAt: live\.lookedAt \|\| undefined/, 'and the reading carries it')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(index, /record: \(input, native\) => recordReview\(input, native, true\)/, 'the sweep writes its row without the card')
  assert.match(index, /const card = cardAfterClose\(session\.id\)\r?\n\s+close = manager\.closeAfterResult/, 'autoclose rows: the card waits for the close')
  console.log('done-close: read then close, card only when something is left ok')
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
  const readings = [{ id: 'sel', ...finished({ drafting: true }) }, { id: 'mid', ...finished({ turnEndedAt: 0, status: 'working', runSince: NOW - 60_000 }) }]
  const deps = {
    enabled: () => true, readings: () => readings, transcriptFor: () => null, resumeIdFor: () => undefined,
    history: () => [], titleOf: () => undefined, otherwiseBusy: () => null, record: () => { throw new Error('no') },
    close: () => ({ closed: false }), noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, log: (line) => lines.push(line)
  }
  main.sweepDoneClose(deps)
  main.sweepDoneClose(deps)
  assert.deepEqual(lines, ['sel stays - an unsent draft in its prompt box'], 'one line per reason; a pane mid-turn says nothing')
  readings[0] = { id: 'sel', ...finished() }
  main.sweepDoneClose(deps)
  assert.equal(lines.at(-1), 'sel stays - reply not read', 'a new reason is a new line')
  console.log('done-close: stay reasons are logged ok')
}

// 4d. "Waits for you" (Robert, 2026-10-03): a finished chat that asks him something, reports
// unfinished work, lists agent steps, has subagents out, a handoff with open steps, or opened
// other panes STAYS OPEN until he acts - and not only from this sweep: it is published as
// `Session.waitsForYou` for the idle clock, `closeIntoReview` and the asleep sweep.
{
  const plain = 'Built it.\n\n## Next steps\n- None'
  assert.equal(waitsForYou({ reply: plain }), null, 'plain done: nothing')
  assert.equal(waitsForYou({ reply: 'Built it.\n\n## Next steps\n- Robert: approve the Vercel build' }), null, 'person-only steps never count')
  assert.equal(waitsForYou({ reply: 'Which port should it use?' }), 'the reply ends in a question')
  assert.equal(waitsForYou({ reply: 'Done.\n\n## Next steps\n- Wire the PC watcher' }), '1 step an agent could take')
  assert.equal(waitsForYou({ reply: 'Seven tasks remain open.' }), 'the reply reports unfinished work')
  assert.equal(waitsForYou({ reply: plain, runningAgents: 2 }), '2 subagents still running')
  assert.equal(waitsForYou({ reply: plain, openedOthers: true }), 'it opened other panes and collects their summary')
  assert.equal(waitsForYou({ reply: plain, handoffOpen: 3 }), 'a handoff with open steps')
  assert.equal(waitsForYou({ reply: undefined }), null, 'reply not read: say nothing')
  assert.equal(waitsForYou({ reply: plain, drafting: true }), null, 'a draft holds the close itself, it is not "waits for you"')

  // The sweep publishes it on every tick, before the gates that skip a pane, and clears it.
  const file = (name, rows) => {
    const f = join(work, `wait-${name}.jsonl`)
    writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n'))
    return f
  }
  const say = (text) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const files = {
    ask: file('ask', [say('Which port should it use?')]),
    look: file('look', [say('Done.\n\n## Next steps\n- Wire the PC watcher')]),
    plain: file('plain', [say(plain)]),
    person: file('person', [say('Built it.\n\n## Next steps\n- Robert: approve the Vercel build')]),
    // Restored asleep: no screen turn end, the transcript's own turn-end row says it ended.
    slept: file('slept', [say('Which branch?'), { type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: new Date(NOW - 600_000).toISOString() }]),
    open: file('open', [say('Which port?'), { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }])
  }
  const asked = 'the reply ends in a question'
  const readings = [
    { id: 'ask', ...finished({ turnEndedAt: NOW - 5_000, reply: undefined }) },
    { id: 'look', ...finished({ focused: true, lookedAt: NOW, reply: undefined }) },
    { id: 'plain', ...finished({ reply: undefined }) },
    { id: 'person', ...finished({ reply: undefined }) },
    { id: 'opener', ...finished({ openedOthers: true, reply: undefined }) },
    { id: 'slept', ...finished({ turnEndedAt: 0, status: 'exited', asleep: NOW - 60_000, reply: undefined }) },
    { id: 'busy', ...finished({ runSince: NOW - 1_000, waitsForYou: asked, reply: undefined }) },
    { id: 'same', ...finished({ waitsForYou: asked, reply: undefined }) },
    { id: 'open', ...finished({ waitsForYou: asked, reply: undefined }) },
    { id: 'sh', ...finished({ agent: 'shell', reply: undefined }) }
  ]
  const published = []
  const deps = {
    enabled: () => false, readings: () => readings,
    transcriptFor: (id) => files[id] ?? (id === 'same' || id === 'busy' ? files.ask : files.plain),
    resumeIdFor: () => undefined, history: () => [], titleOf: () => undefined, otherwiseBusy: () => null,
    record: () => { throw new Error('no row') }, close: () => ({ closed: false }), noteClose: () => {},
    writeNotice: () => {}, activity: () => {}, notify: () => {}, now: () => NOW,
    setWaiting: (id, why) => published.push([id, why])
  }
  main.sweepDoneClose({ ...deps, dry: true })
  assert.deepEqual(published, [], 'dry touches nothing')
  main.sweepDoneClose(deps)
  assert.deepEqual(published, [
    ['ask', asked],
    ['look', '1 step an agent could take'],
    ['opener', 'it opened other panes and collects their summary'],
    ['slept', 'the reply ends in a question'],
    ['busy', undefined],
    ['open', undefined]
  ], 'published with the close off, not yet quiet, looked at, asleep; cleared by a running or open turn; only on a change')
  // Fails CLOSED (review of e7965562): a transcript that is gone or will not read is no
  // evidence the chat stopped waiting, so the flag stays; a pane whose program really
  // exited keeps it too. Any idle pane with no screen turn end reads the transcript's.
  published.length = 0
  const unread = [
    { id: 'gone', ...finished({ waitsForYou: asked, reply: undefined }) },
    { id: 'unreadable', ...finished({ waitsForYou: asked, reply: undefined }) },
    { id: 'quit', ...finished({ status: 'exited', waitsForYou: asked, reply: undefined }) },
    { id: 'handedIn', ...finished({ turnEndedAt: 0, reply: undefined }) }
  ]
  main.sweepDoneClose({ ...deps, readings: () => unread,
    transcriptFor: (id) => (id === 'gone' ? null : id === 'unreadable' ? join(work, 'no-such-transcript.jsonl') : files.slept) })
  assert.deepEqual(published, [['handedIn', asked]], 'an unreadable transcript keeps the flag; an idle pane with no screen turn end takes the transcript\'s')
  console.log('done-close: waits-for-you is read and published ok')
}

// 4e. GuardDeck's Stop: `sessions:keepOpen` [id, keep] -> { ok, reason? }, run as written.
{
  const { transformSync } = await import('esbuild')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const from = index.indexOf('function keepPaneOpenHere(')
  const handle = index.indexOf("ipcMain.handle('sessions:keepOpen'", from)
  assert.ok(from > 0 && handle > from, 'keepPaneOpenHere and the channel exist')
  const tail = index.slice(handle).match(/\r?\n\}\)\r?\n/)
  const code = transformSync(index.slice(from, handle + tail.index + tail[0].length), { loader: 'ts' }).code
  let config = { pinnedPanes: ['other'] }
  const calls = []
  const handlers = {}
  const env = {
    getConfig: () => config,
    setConfig: (p) => { config = { ...config, ...p } },
    manager: {
      list: () => [{ id: 's1' }],
      cancelAutoClear: (id) => calls.push(['cancelAutoClear', id]),
      setDoneClosingAt: (id, at) => calls.push(['setDoneClosingAt', id, at])
    },
    send: (ch) => calls.push(['send', ch]),
    allSessions: () => [],
    remote: { owns: (id) => id.startsWith('@pc/'), setKeepOpen: async (id, keep) => { calls.push(['remote', id, keep]); return true } },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } }
  }
  new Function(...Object.keys(env), code)(...Object.values(env))
  const keepOpen = handlers['sessions:keepOpen']
  assert.deepEqual(await keepOpen({}, 's1', true), { ok: true })
  assert.deepEqual(config.pinnedPanes, ['other', 's1'], 'pinned exactly as the card pins it')
  assert.ok(calls.some((c) => c[0] === 'setDoneClosingAt' && c[1] === 's1' && c[2] === undefined), 'the countdown drops at once')
  assert.ok(calls.some((c) => c[0] === 'cancelAutoClear' && c[1] === 's1'), 'an armed clear stands down too')
  assert.ok(calls.some((c) => c[0] === 'send' && c[1] === 'config:changed'), 'the window hears the pin')
  calls.length = 0
  assert.deepEqual(await keepOpen({}, '@pc/s9', true), { ok: true }, 'a pane on another machine goes there')
  assert.deepEqual(calls, [['remote', '@pc/s9', true]])
  assert.deepEqual(config.pinnedPanes, ['other', 's1'], "and never into this machine's pins")
  assert.deepEqual(await keepOpen({}, 's1', false), { ok: true })
  assert.deepEqual(config.pinnedPanes, ['other'], 'keep: false lifts the pin')
  assert.equal((await keepOpen({}, 'nope', true)).ok, false, 'an unknown pane is refused')
  assert.equal((await keepOpen({}, 's1', 'yes')).ok, false, 'args are [id: string, keep: boolean]')
  // Reachable over the phone server's /pf/call: it is an invoke on the surface.
  const surface = readFileSync(join(root, 'src/shared/surface.ts'), 'utf8')
  assert.ok(surface.includes("keepPaneOpen: ['invoke', 'sessions:keepOpen']"), 'on the surface, so /pf/call reaches it')
  assert.ok(index.includes('setKeepOpen: keepPaneOpenHere'), 'the phone and the paired machine keep open the same way')
  // The other closers honour waitsForYou; the countdown is GuardDeck's alone.
  assert.match(index, /if \(pane\?\.waitsForYou\) \{\r?\n\s+logReclaim\(\{ action: 'close-refused', pane: id, reason: 'waits-for-you' \}\)/, 'closeIntoReview refuses it')
  assert.ok(index.includes('waitsForYou: Boolean(s.waitsForYou)'), 'the asleep sweep is told')
  assert.ok(index.includes('setWaiting: (id, why) => manager.setWaitsForYou(id, why)'), 'the sweep publishes through the manager')
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  assert.ok(!/s\.doneClosingAt/.test(app), 'PaneForge draws no finished-chat countdown (GuardDeck does)')
  assert.ok(app.includes('waitsForYou: !!s.waitsForYou'), 'the idle clock is told')
  console.log('done-close: GuardDeck Stop reaches the pane, closers honour waits-for-you ok')
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
  assert.ok(!/doneReadings\(\)[^]*?focused: personLooking[^]*?turnRead\(/.test(sessions), 'looking is no longer a done-close reading (2026-10-03)')
  assert.ok(sessions.includes('waitsForYou: m.waitsForYou'), 'the reading carries what was last published')
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
  // Told once nothing is working, and the text still counts the idle panes left open.
  d.add('boss', { id: 'c1', title: 'one', project: 'p', summary: 'Did it.', personSteps: [] }, NOW)
  let said = ''
  assert.deepEqual(d.flush(() => 0, (_o, text) => { said = text; return true }, NOW + 1, () => 1), ['boss'], 'an idle child does not hold the summary')
  assert.match(said, /1 other pane is still open/, 'and the summary says it is still open')
  assert.equal(d.size(), 0)
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.ok(index.includes('finishedDigest.flush('), 'index.ts flushes the digest')
  assert.ok(index.includes('manager.onFinished ='), '--close-when-done panes feed it too')
  const ctl = readFileSync(join(root, 'scripts/pf-ctl.mjs'), 'utf8')
  assert.doesNotMatch(ctl, /reportTo: closeWhenDone \? reportTo/, 'pf open always says who opened the pane')
  console.log('done-close: one summary back to the opener ok')
}

// 5b. ...and only until then. done-close.log from 08:00Z 27 Sep: a Set kept for the pane's
// whole life held 8 finished openers for good (s26, s68, s63, s59, s73, s58, s44, s72) -
// 27 lines, more than any other reason. Now it holds while a pane it opened is open or
// their summary is waiting, and the summary's own delivery holds it (`owedPrompt`).
{
  const d = new digest.FinishedDigest()
  assert.equal(d.has('boss'), false)
  d.add('boss', { id: 'a', title: 't', project: 'p', summary: 's', personSteps: [] }, NOW)
  assert.equal(d.has('boss'), true, 'a summary waiting holds the opener')
  d.flush(() => 0, () => true, NOW)
  assert.equal(d.has('boss'), false, 'told: it holds no longer')
  assert.equal(doneVerdict(finished({ owedPrompt: true }), NOW).reason, 'a prompt is on its way to it', 'the summary on its way holds it')
  assert.equal(doneVerdict(finished({ openedOthers: false, owedPrompt: false }), NOW).close, true, 'after that it closes like any finished pane')
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.doesNotMatch(sessions, /private openers = new Set/, 'no life-long set of openers')
  assert.match(sessions, /openedOthers: this\.workingChildrenOf\(m\.id\) > 0 \|\| this\.digestPending\(m\.id\)/, 'WORKING children or a waiting summary')
  assert.match(sessions, /owedPrompt: this\.owesPrompt\(live\)/, 'a prompt being delivered is in the reading')
  assert.match(sessions, /\(live\.meta\.handoverUntil \?\? 0\) > Date\.now\(\)/, '...the handover between /clear and its resume included')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(index, /manager\.digestPending = \(id\) => finishedDigest\.has\(id\)/, 'index.ts says when a summary is waiting')
  // The real opener: s44-mujgi828 on 27 Sep (`desk-2026-09-28-sessions.json`), finished,
  // every pane it opened long closed and told. Its reading no longer names the opener rule.
  const fixture = JSON.parse(readFileSync(join(root, 'scripts/fixtures/desk-2026-09-28-sessions.json'), 'utf8'))
  const s44 = fixture.sessions.find((x) => x.id.startsWith('s44-'))
  const at = s44.lastOutput + 10 * 60_000
  const reading = { agent: s44.agent, printed: s44.printed, status: s44.status, lastKeyboard: s44.lastKeyboard, turnEndedAt: s44.lastOutput, openedOthers: false, reply: 'Done.\n\nNext steps: None', runningAgents: 0 }
  assert.equal(doneVerdict(reading, at).close, true, 's44 as it stood, with no pane of its own open, closes')
  console.log('done-close: an opener holds only until its summary lands ok')
}

// 5c. Round 2 of the stuck chats (2026-10-03). An opener waits only while a pane it opened
// is WORKING; every close of a child feeds the digest; the reply classifier stops reading
// automatic, another chat's and dated steps as work.
{
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const from = sessions.indexOf('  workingChildrenOf(')
  const to = sessions.indexOf('\n  }\n', from)
  assert.ok(from > 0 && to > from, 'workingChildrenOf exists')
  const fixture = join(work, 'working-children.ts')
  writeFileSync(fixture, `
const backJobWaitOnly = (id: string) => id === 'waitonly'
export class H {
  sessions = new Map<string, any>()
  openers = new Map<string, string>()
  openerOf(id: string) { return this.openers.get(id) }
  owesPrompt(live: any) { return !!live.owed }
  hasPendingBackground(live: any) { return !!live.pending }
${sessions.slice(from, to + 4)}
}
`)
  const { H } = await bundle(fixture, 'working-children.cjs')
  const h = new H()
  const child = (id, meta = {}, live = {}) => { h.sessions.set(id, { meta: { id, status: 'idle', ...meta }, ...live }); h.openers.set(id, 'boss') }
  h.sessions.set('boss', { meta: { id: 'boss', status: 'idle' } })
  child('done', {}, {})
  child('asks', { ask: { kind: 'question' } })
  child('dead', { status: 'exited', runSince: 1 })
  child('waitonly', { backJob: 'sleep 60' })
  assert.equal(h.workingChildrenOf('boss', NOW), 0, 'idle, finished, waiting on Robert, exited, only waiting: none holds (Mac s15-murh3a5m)')
  for (const [id, meta, live] of [['w1', { status: 'working' }, {}], ['w2', { runSince: NOW - 5_000 }, {}], ['w3', {}, { busyUntil: NOW + 5_000 }], ['w4', {}, { owed: true }], ['w5', { subagent: 'a background agent (x)' }, {}], ['w6', { backJob: 'npm test' }, {}], ['w7', {}, { pending: true }], ['w8', { job: 'npm run build' }, {}]]) {
    child(id, meta, live)
    assert.equal(h.workingChildrenOf('boss', NOW), 1, `${id} working holds`)
    h.sessions.delete(id)
  }
  assert.match(sessions, /const opener = this\.down \? undefined : this\.openerOf\(id\)\r?\n\s+if \(opener && this\.onFinished\) this\.onFinished\(s\.meta, opener\)/, 'every child close feeds the opener digest (Mac s19, 22:24:13Z)')
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.ok(index.includes('finishedDigest.flush((o) => manager.workingChildrenOf(o)'), 'the digest goes once no child is working')
  // The replies that held for nothing (real text), and the one that must still hold.
  const { replyLeaves } = await bundle('src/shared/doneClose.ts', 'shared-r2.cjs')
  const steps = (x) => `Done.\n\n**Next steps:**\n${x}`
  for (const [chat, step] of [
    ['Mac s15-murh3a5m', '- Chat 6 reports when the new GuardDeck is installed and the 5-second test passes.'],
    ['PC s25-murguhxd', "- The Mac's sync pulls the fix by itself. The check booked for 7:50am Sun will confirm the Mac has it and that its tests pass."],
    ['PC s26-muriaoad', '- On or after 5 Oct 2026, run the two checks: whether re-reported fixes are below the baseline of 10.5 per 100 fix claims, and how often agents reopen a trimmed result. Both are carried in the updated handoff file.']
  ]) assert.equal(replyLeaves(steps(step)), null, `${chat} leaves nothing for now`)
  assert.equal(replyLeaves(steps('1. Fix the Background workers panel, with a test for each change and a check of the page in light and dark themes.\n2. Make the four review changes and commit them with the settings text change.\n3. Run the full check again, merge into master, then send the report to the assistant chat and write the `.DONE.md` copy.')), '3 steps an agent could take', 'PC s22-murfd10o still holds')
  console.log('done-close: an opener waits only on working children; dated, automatic and other chats\' steps hold nothing ok')
}

// 5d. Review of e7965562 (2026-10-03): every automatic closer honours waitsForYou, and a
// person pressing "Do it now" on one is told why nothing closed.
{
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const car = sessions.slice(sessions.indexOf('  closeAfterResult('), sessions.indexOf('  killAll('))
  assert.match(car, /if \(m\.waitsForYou\) return \{ closed: false, reason: 'waits for you' \}/, 'closeAfterResult refuses a chat that waits for you')
  assert.ok(car.indexOf('m.waitsForYou') < car.indexOf("this.kill(id, 'review', why)"), 'before it closes')
  const shared = readFileSync(join(root, 'src/shared/doneClose.ts'), 'utf8')
  assert.ok(shared.includes("if (p.handoffOpen) return 'a handoff with open steps'"), 'waitsForYou reads the field, not the display words')
  assert.equal(waitsForYou({ reply: 'Done.', handoffOpen: 2 }), 'a handoff with open steps')
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  const still = app.slice(app.indexOf('const stillCloseable = useCallback('), app.indexOf('const skipClose = useCallback('))
  assert.match(still, /if \(s\.waitsForYou\) return false/, 'the countdown never closes a chat that waits for you')
  const doClose = app.slice(app.indexOf('const doClose = useCallback('), app.indexOf('[stillCloseable, dropSoon, skipClose, skipGone]'))
  assert.match(doClose, /skipClose\(waiting, WAITING_FOR_YOU\)/, 'skipped in plain words')
  assert.match(doClose, /if \(byPerson\)\s+setActed\(\{ what: 'kept'/, '"Do it now" says it did not close')
  assert.ok(doClose.indexOf("what: 'kept'") < doClose.indexOf("what: 'closed'"), 'and never says "closed" for it')
  const { actedWords } = await bundle('src/shared/mascot.ts', 'mascot-kept.cjs')
  assert.equal(actedWords('kept', [{ word: 'claude-memory pane 1' }], undefined, 0, 'the reply ends in a question'),
    'Did not close claude-memory pane 1 - it is waiting for you (the reply ends in a question). Answer it, or close it yourself.')
  const contract = readFileSync(join(root, 'docs/reviews-runtime-contract.md'), 'utf8')
  assert.ok(!/nobody is looking at|quiet three minutes/.test(contract), 'the contract no longer says three minutes or nobody looking')
  assert.ok(contract.includes('`closeAfterResult` refuses it with `waits for you`'), 'and says what holds')
  console.log('done-close: no automatic closer takes a chat that waits for you; "Do it now" says why ok')
}

{
  // 5c. s77-mujwno51 on 27 Sep (`desk-2026-09-28-sessions.json`): finished, `backJob:
  // bg-wait.mjs`, its shell waiting on a CI run under `--label release-check-4dd8e6bd`.
  // `backWaitOnly` is `isWaitScript` over that shell's line (`main/usage.ts`), so the real
  // line goes through the real reader here.
  const { isWaitScript } = await bundle('src/shared/paneBackJobs.ts', 'backjobs.cjs')
  const fixture = JSON.parse(readFileSync(join(root, 'scripts/fixtures/desk-2026-09-28-sessions.json'), 'utf8'))
  const s77 = fixture.sessions.find((x) => x.id.startsWith('s77-'))
  assert.equal(s77.backJob, 'bg-wait.mjs')
  assert.equal(s77.finished, true)
  const script = String.raw`node ~/Projects/claude-memory/claude-config/bg-wait.mjs --probe 'gh run view 36332652272 --repo robertiuoras/taskdriver.ai --json status,conclusion,jobs -q "\"\(.status) \(.conclusion) \([.jobs[].steps[]? | select(.status==\"in_progress\") | .name] | join(\",\"))\""' --done '^completed success' --fail '^completed (failure|cancelled|timed_out|action_required|startup_failure)' --stale 3000 --deadline 5400 --every 30 --label release-check-4dd8e6bd`
  const shell = `/bin/zsh -c source /Users/r/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${script.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-4419-cwd`
  const at = s77.lastOutput + 10 * 60_000
  const reading = { agent: s77.agent, printed: s77.printed, status: s77.status, lastKeyboard: s77.lastKeyboard, turnEndedAt: s77.lastOutput, backJob: s77.backJob, backWaitOnly: isWaitScript(shell), reply: 'Merged.\n\nNext steps: None', runningAgents: 0 }
  assert.equal(doneVerdict(reading, at).close, true, 's77 waiting on CI through bg-wait closes')
  assert.equal(doneVerdict({ ...reading, backWaitOnly: false }, at).reason, 'a background job (bg-wait.mjs)', 'the same pane running real work stays')
  console.log('done-close: a pane only waiting through bg-wait closes (s77) ok')
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

// A pane started ON a conversation whose last turn had already ended never flips busy, so
// nothing ever gave it a turn end and every close rule skipped it without a word. PC,
// 2026-10-02: s8/s9/s10/s12 finished on the Mac, were handed to the PC and sat 1-3 hours,
// `finished` undefined, done-close.log silent. Its transcript's end row seeds the turn end.
{
  const handedIn = { agent: 'claude', status: 'idle', resumed: true, sawFooter: false, turnEndedAt: 0, turnPending: false, transcriptTurnEndedAt: NOW - 3_600_000 }
  assert.equal(seedTurnEnd(handedIn), true, 'handed in / reopened / restored finished: seeded')
  assert.equal(seedTurnEnd({ ...handedIn, transcriptTurnEndedAt: undefined }), false, 'the transcript says a turn is still open')
  assert.equal(seedTurnEnd({ ...handedIn, resumed: false }), false, 'a fresh pane waiting for its first prompt')
  assert.equal(seedTurnEnd({ ...handedIn, sawFooter: true }), false, 'a pane that showed its own footer has its own turn ends')
  assert.equal(seedTurnEnd({ ...handedIn, turnEndedAt: NOW }), false, 'already has one')
  assert.equal(seedTurnEnd({ ...handedIn, turnPending: true }), false, 'a prompt went in this run')
  assert.equal(seedTurnEnd({ ...handedIn, runSince: NOW }), false, 'a run is counting')
  assert.equal(seedTurnEnd({ ...handedIn, status: 'starting' }), false, 'not idle yet')
  assert.equal(seedTurnEnd({ ...handedIn, ask: { q: 1 } }), false, 'a question on screen')
  assert.equal(seedTurnEnd({ ...handedIn, asleep: true }), false, 'asleep')
  assert.equal(seedTurnEnd({ ...handedIn, agent: 'shell' }), false, 'a shell')
  assert.equal(seedTurnEnd({ ...handedIn, agent: 'codex' }), true, 'codex resumes too')
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.match(sessions, /seedTurnEnd\(\{[\s\S]{0,400}transcriptTurnEndedAt: this\.replyFor\(meta\.id, meta\.agent\)\?\.turnEndedAt[\s\S]{0,200}live\.footerEndedAt = now/, 'the sweep seeds footerEndedAt from it (a decision nothing calls closes nothing)')

  // ...and once seeded, the ordinary rules decide: quiet window from the seed, not from the
  // transcript's hour-old end row.
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 1000, lastKeyboard: NOW - 3_600_000 }), NOW).reason, 'not quiet long enough', 'seeded now: waits the quiet window')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - AUTO_CLOSE_QUIET_MS - 1000, lastKeyboard: NOW - 3_600_000 }), NOW).close, true, 'then closes')

  // A pane with NO turn end used to say nothing at all in done-close.log. One line, once.
  const lines = []
  const deps = {
    enabled: () => true, now: () => NOW, log: (l) => lines.push(l),
    readings: () => [
      { id: 'unseeded', ...finished({ turnEndedAt: 0 }) },
      { id: 'working', ...finished({ turnEndedAt: 0, status: 'working' }) },
      { id: 'sleeping', ...finished({ turnEndedAt: 0, asleep: true }) },
      { id: 'kept', ...finished({ turnEndedAt: 0, kept: true }) },
      { id: 'shellpane', ...finished({ turnEndedAt: 0, agent: 'shell' }) }
    ],
    transcriptFor: () => null, resumeIdFor: () => 'r', history: () => [], titleOf: () => undefined, otherwiseBusy: () => null,
    record: () => { throw new Error('no row') }, notify: () => {}, close: () => ({ closed: false }), noteClose: () => {}, writeNotice: () => {}, activity: () => {}
  }
  for (let i = 0; i < 3; i++) assert.deepEqual(main.sweepDoneClose(deps), [])
  assert.deepEqual(lines, ['unseeded stays - no finished turn: it never showed a turn ending here, and its conversation does not say one ended'], 'an idle agent pane with no turn end says why, once; working, asleep, kept and shell panes add nothing')
  console.log('done-close: a pane that arrives finished gets its turn end, and a pane without one says so ok')
}

// s105 (2026-10-02, 7:39:20pm Gold Coast): a client chat was closed into Review MID-TURN.
// The agent was between two Chrome tool calls - a browser tool prints nothing for 10-30 s -
// and the screen's footer read had gone quiet at 09:36:52Z, so the pane looked finished.
// The transcript said otherwise: its last row was a tool result at 09:39:17Z with no turn
// end after it. Replay that moment with the real rows (trimmed): the close must not happen.
{
  const { closedBecause } = await bundle('src/shared/closeWhenDone.ts', 'closewhendone.cjs')
  const { openTurnOf } = await bundle('src/shared/replyRead.ts', 'replyread.cjs')
  const fixture = readFileSync(join(root, 'scripts/fixtures/claude-midturn-browser-calls.jsonl'), 'utf8')
  const transcript = join(work, 's105.jsonl')
  writeFileSync(transcript, fixture)
  const at = (iso) => Date.parse(iso)
  const CLOSE_AT = at('2026-10-02T09:39:20.244Z')
  const lines = []
  const shut = []
  const deps = {
    enabled: () => true, now: () => CLOSE_AT, log: (l) => lines.push(l),
    readings: () => [{
      id: 's105', agent: 'claude', printed: at('2026-10-02T09:39:17.000Z') - 9000, status: 'idle',
      lastKeyboard: at('2026-10-02T09:36:32.034Z'), turnEndedAt: at('2026-10-02T09:36:52.128Z'), lookedAt: at('2026-10-02T09:37:20.000Z')
    }],
    transcriptFor: () => transcript, resumeIdFor: () => 'native-s105', history: () => [],
    titleOf: () => ({ title: 'client setup', cwd: '/Users/r/Projects/clients/clients/client', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => ({ ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false }),
    notify: () => {}, close: (id) => { shut.push(id); return { closed: true } }, noteClose: () => {}, writeNotice: () => {}, activity: () => {}
  }
  assert.deepEqual(main.sweepDoneClose(deps), [], 's105: a turn open in its transcript is never closed into Review')
  assert.deepEqual(shut, [])
  assert.match(lines[0] ?? '', /^s105 stays - its turn is still open - its conversation's last entry is a tool result the agent has not answered yet \(2026-10-02T09:39:17\.212Z\)/, 'done-close.log names the evidence')
  // The same reading the moment the turn really ends closes as before.
  const ended = join(work, 's105-ended.jsonl')
  writeFileSync(ended, fixture +
    JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-10-02T09:45:00.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Set up and verified.\n\n## Next steps\n- None' }] } }) + '\n' +
    JSON.stringify({ type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: '2026-10-02T09:45:00.500Z' }) + '\n')
  const why = []
  const done = { ...deps, now: () => at('2026-10-02T09:50:00Z'), transcriptFor: () => ended, close: (id, _t, w) => { why.push(w); return { closed: true } },
    readings: () => [{ ...deps.readings()[0], turnEndedAt: at('2026-10-02T09:45:01Z'), lookedAt: undefined }] }
  assert.deepEqual(main.sweepDoneClose(done), ['s105'], 'a turn that ended closes')
  assert.match(why[0], /^finished: the screen said its turn ended at 2026-10-02T09:45:01\.000Z, its conversation's last entry is turn-end \(2026-10-02T09:45:00\.500Z\), turn-end row 2026-10-02T09:45:00\.500Z, quiet \d+s, unread/, 'the close carries its reason')

  // Every close writes a plain reason; a close with an open turn says INCIDENT.
  const read = main.readReply('claude', transcript, CLOSE_AT)
  const open = openTurnOf(read, CLOSE_AT)
  const words = closedBecause('idle-clock', undefined, { status: 'idle', footerEndedAt: at('2026-10-02T09:36:52.128Z'), lastEntry: read.lastEntry, openTurn: open })
  assert.match(words, /^the idle countdown ran out\. Asked by: idle-clock\. Seen: status idle, screen said the turn ended at 2026-10-02T09:36:52\.128Z, conversation's last entry tool_result at 2026-10-02T09:39:17\.212Z, no turn-end row\. INCIDENT: closed with its turn still open/)
  assert.doesNotMatch(closedBecause('user', undefined, { status: 'idle', footerEndedAt: 0 }), /INCIDENT/)
  assert.match(closedBecause('user', undefined, { status: 'idle', footerEndedAt: 0 }), /^a person closed it in the window\. Asked by: user\. Seen: status idle, screen showed no finished turn, conversation not read/)

  // The manager wires it: every kill computes the reason and hands it to History, the
  // close-request line carries it, an automatic closer refuses an open turn, and the Review
  // close checks the transcript itself (a decision nothing calls closes nothing).
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.match(sessions, /kill\(id: string, by: CloseBy, why\?: string\)[\s\S]{0,900}closedBecause\(by, why,[\s\S]{0,400}action: 'close-request'[\s\S]{0,200}why: because[\s\S]{0,200}action: 'close-open-turn'[\s\S]{0,1500}recordEnd\(id, resumeIdFor\(id\), because\)/)
  assert.match(sessions, /closeRefusedFor\(id: string, by: CloseBy\)[\s\S]{0,600}closeRefused\(by, 'working'\)[\s\S]{0,200}turnOpenFor/)
  assert.match(sessions, /closeAfterResult\(id: string, reportedAt: number, why\?: string\)[\s\S]{0,1500}turnOpenFor[\s\S]{0,200}its turn is still open[\s\S]{0,100}this\.kill\(id, 'review', why\)/)
  const history = readFileSync(join(root, 'src/main/history.ts'), 'utf8')
  assert.match(history, /if \(closedBecause\) entry\.closedBecause = closedBecause/)
  console.log('done-close: s105 - a turn still open in its transcript is never closed, and every close says why ok')
}
