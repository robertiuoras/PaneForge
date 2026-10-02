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
const { seedTurnEnd, doneVerdict, folderLeftover, whyNotDone, doneReviewId, doneQuietMs, personLooking, replyFinished, closeHeldBy, wasRead, AUTO_CLOSE_QUIET_MS, READ_QUIET_MS } = await bundle('src/shared/doneClose.ts', 'shared.cjs')
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
  openChildrenOf = () => 0; digestPending = () => false; owesPrompt = () => false
  kill(id: string, by: string) { this.killed.push([id, by]); this.sessions.delete(id) }
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
  assert.equal(refuse({ focused: true }), 'somebody is looking at it')
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
  // Quiet past the three-minute wait but printed in the last 8 s cannot happen through
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
  assert.equal(doneQuietMs('ok'), AUTO_CLOSE_QUIET_MS)
  assert.equal(doneQuietMs('tight'), 60_000)
  assert.equal(doneQuietMs('over'), 30_000)
  const ninety = finished({ turnEndedAt: NOW - 90_000 })
  assert.equal(doneVerdict(ninety, NOW).reason, 'not quiet long enough', 'the default wait is three minutes')
  assert.equal(doneVerdict(ninety, NOW, doneQuietMs('ok')).close, false, 'room to spare: still three minutes')
  assert.equal(doneVerdict(ninety, NOW, doneQuietMs('tight')).close, true, 'tight: ninety seconds is enough')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 40_000 }), NOW, doneQuietMs('tight')).close, false, 'tight: forty seconds is not')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 40_000 }), NOW, doneQuietMs('over')).close, true, 'over: forty seconds is')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 90_000, focused: true }), NOW, doneQuietMs('over')).close, false, 'pressure never closes the pane somebody is looking at')
  // The sweep passes its dep through to both verdicts; unset is the default wait.
  const transcript = join(work, 'quiet.jsonl')
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n\n## Next steps\n- None' }] } }))
  const shut = []
  const deps = (quietMs) => ({
    enabled: () => true,
    readings: () => [{ id: 'q1', ...finished({ turnEndedAt: NOW - 90_000, reply: undefined, runningAgents: undefined }) }],
    transcriptFor: () => transcript, resumeIdFor: () => 'native-q', history: () => [],
    titleOf: () => ({ title: 'quiet', cwd: '/Users/r/Projects/site', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => ({ ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false }),
    notify: () => {}, markRead: () => {},
    close: (id) => { shut.push(id); return { closed: true } }, noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, ...(quietMs ? { quietMs } : {})
  })
  assert.deepEqual(main.sweepDoneClose(deps()), [], 'no quietMs dep: three minutes')
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
    readings: () => [{ id: 'f1', ...finished({ reply: undefined, runningAgents: undefined }) }, { id: 'f2', ...finished({ turnEndedAt: NOW - 10_000 }) }, { id: 'f3', ...finished({ focused: true }) }],
    folderOf: (id) => { asked.push(id); return answers.length > 1 ? answers.shift() : answers[0] },
    transcriptFor: () => transcript, resumeIdFor: () => 'native-f', history: () => [],
    titleOf: () => ({ title: 'folder', cwd: '/Users/r/Projects/toolstash', agent: 'claude' }), otherwiseBusy: () => null,
    record: (input, native) => { records.push(input); return { ...input, ...native, provider: 'claude', reportPath: '/x', createdAt: 'now', attention: false } },
    notify: () => {}, markRead: () => {},
    close: () => ({ closed: true }), noteClose: () => {}, writeNotice: () => {}, activity: () => {},
    now: () => NOW, log: (l) => lines.push(l)
  }
  assert.deepEqual(main.sweepDoneClose(deps), ['f1'], 'changed files and unpushed commits no longer hold it')
  assert.ok(asked.length >= 1 && asked.every((id) => id === 'f1'), 'a pane mid-quiet or looked at never costs a folder read')
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
  // (c) A read pane closes READ_QUIET_MS after the look ended; an unread one waits as before.
  assert.equal(READ_QUIET_MS, 30_000)
  const ended = NOW - 60_000
  const lookEnded = NOW - 40_000
  const read = (at) => doneVerdict(finished({ turnEndedAt: ended, lastKeyboard: ended - 5_000, lookedAt: lookEnded }), lookEnded + at)
  assert.equal(read(29_000).close, false, 'read: 29 s after looking away it stays')
  assert.equal(read(29_000).reason, 'not quiet long enough')
  assert.equal(read(31_000).close, true, 'read: 31 s after looking away it closes')
  assert.equal(read(31_000).read, true, 'and the verdict says it was read')
  const unread = (at) => doneVerdict(finished({ turnEndedAt: ended, lastKeyboard: ended - 5_000 }), lookEnded + at)
  assert.equal(unread(31_000).close, false, 'unread: 31 s is nothing, the normal wait holds')
  assert.equal(unread(AUTO_CLOSE_QUIET_MS - 20_000).close, true, 'unread: closes once three minutes since the turn ended')
  assert.equal(doneVerdict(finished({ turnEndedAt: ended, lookedAt: ended - 1 }), lookEnded + 31_000).close, false, 'a look from before this turn ended is an earlier turn\'s')
  assert.equal(wasRead({ turnEndedAt: ended, lookedAt: ended - 1 }), false)
  assert.equal(wasRead({ turnEndedAt: ended, lookedAt: ended }), true, 'watching it finish is reading it')
  const typed = doneVerdict(finished({ turnEndedAt: ended, lookedAt: lookEnded, lastKeyboard: lookEnded + 10_000 }), lookEnded + 31_000)
  assert.equal(typed.close, false, 'typing after the look restarts the 30 s')
  assert.equal(doneVerdict(finished({ turnEndedAt: ended, lookedAt: lookEnded, focused: true }), lookEnded + 31_000).reason, 'somebody is looking at it')
  assert.equal(doneVerdict(finished({ turnEndedAt: ended, lookedAt: lookEnded, reply: 'Which port?' }), lookEnded + 31_000).reason, 'the reply ends in a question', 'read never excuses a question')
  assert.equal(doneVerdict(finished({ turnEndedAt: NOW - 90_000, lookedAt: NOW - 85_000 }), NOW, doneQuietMs('tight')).close, true, 'read quiet interval has elapsed under tight pressure')
  assert.equal(doneVerdict(finished({ lookedAt: NOW - 1_000 }), NOW).close, false, 'old turn cannot override a recent look')
  assert.equal(doneVerdict(finished({ lookedAt: NOW - 1_000 }), NOW, doneQuietMs('over')).close, false, 'pressure cannot override a recent look')
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

  // Automatic closure publishes a full warning, with cancellation and a fresh deadline.
  let clock = at
  let focused = false
  const deadlines = []
  const warned = { ...deps, readings: () => [{ ...readings[0], id: 'warning', focused }],
    transcriptFor: () => files.none, now: () => clock,
    setClosing: (id, deadline) => deadlines.push([id, deadline]) }
  assert.deepEqual(main.sweepDoneClose(warned), [])
  assert.equal(deadlines.at(-1)[1], at + 30_000)
  clock += 29_000
  assert.deepEqual(main.sweepDoneClose(warned), [])
  focused = true
  assert.deepEqual(main.sweepDoneClose(warned), [])
  assert.equal(deadlines.at(-1)[1], undefined, 'returning to pane cancels warning')
  focused = false
  main.sweepDoneClose(warned)
  assert.equal(deadlines.at(-1)[1], clock + 30_000, 'fresh warning after cancellation')
  clock += 30_000
  assert.deepEqual(main.sweepDoneClose(warned), ['warning'])
  assert.equal(deadlines.at(-1)[1], undefined)
  main.sweepDoneClose(warned)
  main.sweepDoneClose({ ...warned, enabled: () => false })
  assert.equal(deadlines.at(-1)[1], undefined, 'disabling cancels published clock')

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
  const readings = [{ id: 'sel', ...finished({ focused: true }) }, { id: 'mid', ...finished({ turnEndedAt: 0, status: 'working', runSince: NOW - 60_000 }) }]
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
  assert.match(sessions, /openedOthers: this\.openChildrenOf\(m\.id\) > 0 \|\| this\.digestPending\(m\.id\)/, 'open children or a waiting summary')
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
