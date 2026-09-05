// Reopening a desk has to put each pane back into ITS conversation, and the dialog that
// offers them back has to say what each one was doing. Both answers come out of Claude
// Code's own transcripts, and both have a wrong answer that looks right:
//
//   - "the newest chat in that folder" is the same as "this pane's chat" until a second
//     pane opens on the same repo, and then it is the same chat twice.
//   - the last `"type":"user"` record in a transcript is very often not something the
//     user typed: a tool result comes back as a user turn, so does a slash command, and
//     a subagent's whole conversation is in the same file behind isSidechain.
//
//   node scripts/restore-context-test.mjs

import { strict as assert } from 'node:assert'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = (await import('typescript')).default

/** Compile one dependency-free main-process module and hand back its exports. */
function load(file, exportNames) {
  const src = readFileSync(join(root, file), 'utf8')
  const js = tsc.transpileModule(src, {
    compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(
    (id) => require_(id),
    module,
    module.exports
  )
  for (const n of exportNames) assert.ok(module.exports[n], `${file} no longer exports ${n}`)
  return module.exports
}

// The modules under test import only node builtins; give the compiled CommonJS a
// require that can reach them and nothing else.
const builtins = new Map()
function require_(id) {
  if (!builtins.has(id)) throw new Error(`unexpected import: ${id}`)
  return builtins.get(id)
}
for (const id of ['node:fs', 'node:os', 'node:path', 'node:child_process', 'electron']) {
  try {
    builtins.set(id, id === 'electron' ? {} : await import(id))
  } catch {
    /* electron is not importable outside the app - nothing under test needs it */
  }
}

const T = load('src/main/transcripts.ts', [
  'noteSession',
  'forgetSession',
  'transcriptFor',
  'resumeIdFor',
  'noteSubmittedPrompt',
  'lastPrompt',
  'promptFromTail',
  'resumable',
  'resumableTranscript'
])

// The restore and History paths must pass the provider through. A Codex id is global to
// CODEX_HOME and cannot be checked as a Claude per-project filename.
const mainIndex = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
assert.match(mainIndex, /resumableTranscript\(req\.resumeCwd \?\? req\.cwd, req\.resumeId, req\.agent\)/, 'start validates the selected provider transcript')
assert.match(mainIndex, /const file = req\.resumeId \? resumableTranscript\(req\.resumeCwd \?\? req\.cwd, req\.resumeId, req\.agent\) : null/, 'silent restore validates the selected provider transcript')
assert.match(mainIndex, /const held = spec\.resumeId \? resumableTranscript\(spec\.resumeCwd \?\? spec\.cwd, spec\.resumeId, spec\.agent\) : null/, 'History restore validates the selected provider transcript')
assert.match(mainIndex, /const unavailable = req\.agent !== 'shell' && !named/, 'a saved agent pane with no verified id becomes unavailable')
assert.match(mainIndex, /asleep: unavailable \|\| req\.asleep/, 'unavailable restore is a process-free asleep placeholder')
assert.match(mainIndex, /Saved conversation could not be verified\. It remains asleep/, 'the placeholder explains it was preserved instead of replaced')

// ---------------------------------------------------------------- last prompt

const rec = (o) => JSON.stringify(o)
const user = (content, extra = {}) => rec({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = (text) =>
  rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

// 1. The plain case: the last thing typed, not the last thing said.
assert.equal(
  T.promptFromTail([user('first'), assistant('answering'), user('make the badge green')].join('\n')),
  'make the badge green'
)

// 2. A tool result comes back as a user-role message. It is not a prompt.
assert.equal(
  T.promptFromTail(
    [
      user('run the tests'),
      rec({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
      })
    ].join('\n')
  ),
  'run the tests'
)

// 3. A slash command is what the user typed and tells you nothing about the work.
assert.equal(
  T.promptFromTail(
    [
      user('fix the close path'),
      user('<command-name>/clear</command-name>\n<command-message>clear</command-message>')
    ].join('\n')
  ),
  'fix the close path'
)

// 4. A subagent's turns live in the same file. They were typed by the agent, not by you.
assert.equal(
  T.promptFromTail(
    [user('audit the sweep'), user('search for every caller', { isSidechain: true })].join('\n')
  ),
  'audit the sweep'
)

// 5. Injected context wrapped around a real prompt is stripped, and the prompt survives.
assert.equal(
  T.promptFromTail(user('<system-reminder>be nice</system-reminder>\n  close   everything ')),
  'close everything'
)

// 6. Content blocks, not a bare string - the other shape the CLI writes.
assert.equal(T.promptFromTail(user([{ type: 'text', text: 'ship it' }])), 'ship it')

// 7. Nothing typed at all is undefined, not an empty row in the dialog.
assert.equal(T.promptFromTail([assistant('hello')].join('\n')), undefined)
assert.equal(T.promptFromTail(''), undefined)

// 8. A long prompt is cut to one line's worth and says so.
const long = T.promptFromTail(user('x'.repeat(600)))
assert.ok(long.length < 240 && long.endsWith('…'), `long prompt not truncated: ${long?.length}`)

// -------------------------------------------------- naming the pane's own chat

// Claude Code's folder-per-directory naming, rebuilt here so the test fails if the
// module's idea of it drifts from the CLI's.
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const cwd = mkdtempSync(join(tmpdir(), 'pf-restore-'))
const projects = join(homedir(), '.claude', 'projects', slug(cwd))
mkdirSync(projects, { recursive: true })

/** An interactive session's opening record. A headless `-p` run never writes one. */
const mode = rec({ type: 'mode', mode: 'default' })

function transcript(id, lines, ageMs = 0) {
  return headless(id, [mode, ...lines], ageMs)
}

/** The same file WITHOUT the interactive marker: what `claude -p` leaves behind. */
function headless(id, lines, ageMs = 0) {
  const file = join(projects, `${id}.jsonl`)
  writeFileSync(file, lines.join('\n'), 'utf8')
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000
    utimesSync(file, t, t)
  }
  return file
}

try {
  // A conversation from before this pane existed is not this pane's, however new the
  // folder is - that is the one `--continue` gets wrong.
  transcript('older', [user('yesterdays work')], 10 * 60_000)
  T.noteSession('pane1', cwd, 'claude')
  assert.equal(T.transcriptFor('pane1'), null, 'claimed a transcript written before it started')

  // Once it writes one, that is the pane's, by name.
  transcript('chat-a', [user('pane one prompt'), assistant('pane one reply')])
  assert.equal(T.resumeIdFor('pane1'), 'chat-a')

  // Two panes in one folder must not both resume the same conversation.
  T.noteSession('pane2', cwd, 'claude')
  transcript('chat-b', [user('pane two prompt')])
  assert.equal(T.resumeIdFor('pane2'), 'chat-b')
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one lost its chat to pane two')

  // ...and neither must a pane in a LANE of that folder, whose own project directory is a
  // symlink to this one. Claims are compared as paths, so the same transcript reached
  // through `-assistant` and through `-assistant-a` was two different strings and deduped
  // against nothing: measured on a real desk, three `assistant` panes all reporting one
  // conversation id, which is three panes reopening into one chat.
  const lane = `${cwd}-a`
  mkdirSync(lane, { recursive: true })
  symlinkSync(projects, join(homedir(), '.claude', 'projects', slug(lane)))
  T.noteSession('paneLane', lane, 'claude')
  // It has written nothing of its own yet, and every transcript here is somebody's: the
  // right answer is no id at all. Through the symlink the newest one is `chat-b` spelled
  // a second way, which is what it used to take.
  assert.equal(T.resumeIdFor('paneLane'), undefined, 'a lane pane took a claimed conversation')
  // Then it writes one, and that is its own.
  transcript('chat-lane', [user('lane prompt')])
  assert.equal(T.resumeIdFor('paneLane'), 'chat-lane')
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one lost its chat to a lane pane')
  assert.equal(T.resumeIdFor('pane2'), 'chat-b', 'pane two lost its chat to a lane pane')
  T.forgetSession('paneLane')
  // ...and out of the folder again, so the cases after this one see the two panes and the
  // two chats they were written for.
  rmSync(join(projects, 'chat-lane.jsonl'), { force: true })
  rmSync(join(homedir(), '.claude', 'projects', slug(lane)), { force: true, recursive: true })
  rmSync(lane, { recursive: true, force: true })

  // /clear starts a new transcript inside the same pane, and being re-noted is NOT
  // enough to follow it. sessions.ts re-notes when the command is submitted, which is
  // seconds before the CLI has written anything: measured on a real pane, the old chat's
  // last write was 10:45:49 and the new chat was born 10:45:55. At the re-note the only
  // transcript in the folder is the one being abandoned, it is newer than the slack
  // allows for, and the pane claims it straight back - and then holds it for good.
  //
  // That was not cosmetic. Lane holds are recorded against the CHAT id, so a pane one
  // /clear old owned no lane: its card showed nothing and its lane was drawn under
  // "lanes elsewhere" while the pane sat two inches below it.
  T.noteSession('pane2', cwd, 'claude')
  assert.equal(T.resumeIdFor('pane2'), 'chat-b', 'the re-note should re-take the old chat')
  transcript('chat-c', [user('after the clear')])
  assert.equal(T.resumeIdFor('pane2'), 'chat-c', 'did not follow the pane into its new chat')
  // And the OTHER pane must not drift onto the conversation pane two just left, even
  // though it is newer than its own and nobody is holding it any more.
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one drifted onto an abandoned chat')

  // The same clear, with the two panes asked in the other order. Whichever is asked
  // first, the new chat belongs to the pane whose own transcript went quiet just before
  // it was born - the other one is still writing to its own.
  transcript('chat-d', [user('pane one is still here')])
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one took a chat born after it went quiet')
  assert.equal(T.resumeIdFor('pane2'), 'chat-c', 'pane two left the chat it had just moved into')

  // The dialog reads the prompt out of the conversation it is about to reopen.
  assert.equal(T.lastPrompt(cwd, 'chat-a'), 'pane one prompt')
  assert.equal(T.lastPrompt(cwd, 'chat-c'), 'after the clear')

  // A /clear the app never saw happen. The re-note above is driven by the LETTERS of the
  // command arriving through the pty, and the usual way to run it is to pick it out of the
  // CLI's completion menu - which submits a line the app never saw typed. The pane stayed
  // settled on a conversation that had stopped existing, and went on publishing its id:
  // the lane engine believed that dead chat was alive (it is in the app's own list of
  // hosted chats), so it never gave the lane back, and the pane's NEW chat was handed a
  // worktree and told another chat was working in the repo. It was itself, before the
  // clear. Found on a real desk: `main` held by a chat last seen four hours earlier, the
  // live chat in lane `a`, both the same pane.
  const cwd3 = mkdtempSync(join(tmpdir(), 'pf-cleared-'))
  const projects3 = join(homedir(), '.claude', 'projects', slug(cwd3))
  mkdirSync(projects3, { recursive: true })
  /** How a session that has SessionStart hooks records the way it began. */
  const began = (source) =>
    rec({
      type: 'attachment',
      parentUuid: null,
      attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: `SessionStart:${source}` }
    })
  const chat = (id, lines, ageMs = 0) => {
    const file = join(projects3, `${id}.jsonl`)
    writeFileSync(file, [mode, ...lines].join('\n'), 'utf8')
    if (ageMs) {
      const t = (Date.now() - ageMs) / 1000
      utimesSync(file, t, t)
    }
  }

  T.noteSession('pane6', cwd3, 'claude')
  chat('chat-p', [began('startup'), user('before the clear')], 3000)
  assert.equal(T.resumeIdFor('pane6'), 'chat-p')

  // A second CLI launched in the same folder is never a pane's continuation, however well
  // the clocks line up - this is the drift the sticky rule was there to stop, and it stays
  // stopped by what the file says rather than by refusing to ever move.
  chat('chat-q', [began('startup'), user('someone elses new session')], 2000)
  assert.equal(T.resumeIdFor('pane6'), 'chat-p', 'adopted a session somebody else launched')

  // The clear itself, in the new conversation's own words.
  chat('chat-r', [began('clear'), user('after the menu clear')])
  assert.equal(T.resumeIdFor('pane6'), 'chat-r', 'did not follow a /clear the app never saw')

  // Only the OPENING records say how a conversation began. A chat that prints the marker
  // - anything discussing hooks, this test included - is a chat, not a clear.
  chat('chat-s', [user(`log line: "hookName":"SessionStart:clear" fired`)])
  assert.equal(T.resumeIdFor('pane6'), 'chat-r', 'read a chat about a clear as a clear')

  // A conversation deleted since the desk was written cannot be resumed by name, and
  // must not be passed to the CLI as if it could.
  assert.equal(T.resumable(cwd, 'chat-a'), true)
  assert.equal(T.resumable(cwd, 'gone'), false)
  // On disk but never answered: the CLI says `No conversation found with session ID`
  // to exactly this file, so it is not resumable either (2026-09-04).
  transcript('chat-unanswered', [user('typed but never sent'), user('typed again')])
  assert.equal(T.resumable(cwd, 'chat-unanswered'), false, 'a transcript with no reply is not resumable')
  transcript('chat-answered', [user('hello'), assistant('hi')])
  assert.equal(T.resumable(cwd, 'chat-answered'), true)
  assert.equal(T.resumable(cwd, undefined), false)
  assert.equal(T.lastPrompt(cwd, 'gone'), undefined)
  // A path, not an id: never allowed to escape the project folder.
  assert.equal(T.resumable(cwd, '../../../etc/passwd'), false)

  // Codex rollouts live globally, so metadata must prove cwd, start time and one claim.
  const codexHome = mkdtempSync(join(tmpdir(), 'pf-codex-home-'))
  process.env.CODEX_HOME = codexHome
  const codexDir = join(codexHome, 'sessions', '2026', '09', '05')
  mkdirSync(codexDir, { recursive: true })
  const codexId = '11111111-1111-4111-8111-111111111111'
  const codexRow = (id, folder, timestamp = new Date().toISOString()) =>
    JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: folder, timestamp } })
  const codexUser = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const codexAssistant = () => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } })
  const rollout = (name, id, folder, timestamp, prompt, answered = true) =>
    writeFileSync(join(codexDir, `${name}.jsonl`), [codexRow(id, folder, timestamp), codexUser(prompt), ...(answered ? [codexAssistant()] : [])].join('\n') + '\n', 'utf8')
  T.noteSession('pane3', cwd, 'codex')
  T.noteSubmittedPrompt('pane3', 'pane three owns this Codex prompt')
  rollout('one', codexId, cwd, undefined, 'pane three owns this Codex prompt')
  assert.equal(T.resumeIdFor('pane3'), codexId, 'Codex keeps its metadata-bound session id')
  assert.equal(T.resumable(cwd, codexId, 'codex'), true, 'an exact Codex id with an assistant reply is resumable')
  const codexTwo = '22222222-2222-4222-8222-222222222222'
  T.noteSession('pane-codex-two', cwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-two', 'pane two owns this Codex prompt')
  rollout('two', codexTwo, cwd, undefined, 'pane two owns this Codex prompt')
  assert.equal(T.resumeIdFor('pane-codex-two'), codexTwo, 'a second same-cwd Codex pane does not take the first id')
  // Querying the first pane after only the second has created a rollout must not let the
  // first pane steal that second conversation just because both share a folder and time.
  const firstQueryCwd = mkdtempSync(join(tmpdir(), 'pf-codex-first-query-'))
  const firstQueryId = '77777777-7777-4777-8777-777777777777'
  T.noteSession('pane-codex-first-query-first', firstQueryCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-first-query-first', 'first pane unique Codex prompt')
  T.noteSession('pane-codex-first-query-second', firstQueryCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-first-query-second', 'second pane unique Codex prompt')
  rollout('first-query-second', firstQueryId, firstQueryCwd, undefined, 'second pane unique Codex prompt')
  assert.equal(T.resumeIdFor('pane-codex-first-query-first'), undefined, 'the first queried pane cannot steal the second pane rollout')
  assert.equal(T.resumeIdFor('pane-codex-first-query-second'), firstQueryId, 'the submitted prompt binds the rollout to its pane')
  const ambiguousA = '33333333-3333-4333-8333-333333333333'
  const ambiguousB = '44444444-4444-4444-8444-444444444444'
  const otherCwd = mkdtempSync(join(tmpdir(), 'pf-codex-cwd-'))
  T.noteSession('pane-codex-ambiguous-one', otherCwd, 'codex')
  T.noteSession('pane-codex-ambiguous-two', otherCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-ambiguous-one', 'same Codex prompt in two panes')
  T.noteSubmittedPrompt('pane-codex-ambiguous-two', 'same Codex prompt in two panes')
  rollout('amb-a', ambiguousA, otherCwd, undefined, 'same Codex prompt in two panes')
  rollout('amb-b', ambiguousB, otherCwd, undefined, 'same Codex prompt in two panes')
  assert.equal(T.resumeIdFor('pane-codex-ambiguous-one'), undefined, 'identical Codex prompts with two candidates are refused')
  assert.equal(T.resumeIdFor('pane-codex-ambiguous-two'), undefined, 'a second identical prompt is refused too')
  // Even one rollout is ambiguous when two currently tracked panes submitted the same
  // proof: querying either one first must not turn query order into identity.
  const sharedOneCwd = mkdtempSync(join(tmpdir(), 'pf-codex-shared-one-'))
  const sharedOneId = '88888888-8888-4888-8888-888888888888'
  T.noteSession('pane-codex-shared-one-first', sharedOneCwd, 'codex')
  T.noteSession('pane-codex-shared-one-second', sharedOneCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-shared-one-first', 'identical prompt with one rollout')
  T.noteSubmittedPrompt('pane-codex-shared-one-second', 'identical prompt with one rollout')
  rollout('shared-one', sharedOneId, sharedOneCwd, undefined, 'identical prompt with one rollout')
  assert.equal(T.resumeIdFor('pane-codex-shared-one-first'), undefined, 'first query refuses one rollout shared by identical proofs')
  assert.equal(T.resumeIdFor('pane-codex-shared-one-second'), undefined, 'second query refuses the same shared rollout')
  // Shared early wording does not poison a later pane-specific proof. Each rollout is
  // still bound to the one unique line only its owner submitted.
  const sharedThenUniqueCwd = mkdtempSync(join(tmpdir(), 'pf-codex-shared-then-unique-'))
  const uniqueOneId = '99999999-9999-4999-8999-999999999999'
  const uniqueTwoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  T.noteSession('pane-codex-unique-one', sharedThenUniqueCwd, 'codex')
  T.noteSession('pane-codex-unique-two', sharedThenUniqueCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-unique-one', 'shared opening context')
  T.noteSubmittedPrompt('pane-codex-unique-two', 'shared opening context')
  T.noteSubmittedPrompt('pane-codex-unique-one', 'only pane one later detail')
  T.noteSubmittedPrompt('pane-codex-unique-two', 'only pane two later detail')
  rollout('unique-one', uniqueOneId, sharedThenUniqueCwd, undefined, 'only pane one later detail')
  rollout('unique-two', uniqueTwoId, sharedThenUniqueCwd, undefined, 'only pane two later detail')
  assert.equal(T.resumeIdFor('pane-codex-unique-one'), uniqueOneId, 'later unique proof identifies the first pane')
  assert.equal(T.resumeIdFor('pane-codex-unique-two'), uniqueTwoId, 'later unique proof identifies the second pane')
  const oldId = '55555555-5555-4555-8555-555555555555'
  const oldCwd = mkdtempSync(join(tmpdir(), 'pf-codex-old-'))
  T.noteSession('pane-codex-old', oldCwd, 'codex')
  T.noteSubmittedPrompt('pane-codex-old', 'old Codex prompt')
  rollout('old', oldId, oldCwd, new Date(Date.now() - 10 * 60_000).toISOString(), 'old Codex prompt')
  assert.equal(T.resumeIdFor('pane-codex-old'), undefined, 'a Codex rollout older than the pane is refused')
  T.noteSession('pane-codex-named', cwd, 'codex', codexId)
  assert.equal(T.resumeIdFor('pane-codex-named'), codexId, 'a named Codex resume is accepted only when metadata matches cwd and id')
  const rehomeCwd = mkdtempSync(join(tmpdir(), 'pf-codex-rehome-'))
  T.noteSession('pane-codex-rehomed', cwd, 'codex', codexId)
  assert.equal(T.resumable(cwd, codexId, 'codex'), true, 'the original folder proves the rehomed Codex conversation')
  assert.equal(T.resumable(rehomeCwd, codexId, 'codex'), false, 'the destination folder cannot claim copied metadata as its own')
  assert.equal(T.resumeIdFor('pane-codex-rehomed'), codexId, 'the original metadata binding keeps the exact id for later sleep and snapshot')
  const noReplyId = '66666666-6666-4666-8666-666666666666'
  rollout('unanswered', noReplyId, cwd, undefined, 'Codex without reply', false)
  assert.equal(T.resumable(cwd, noReplyId, 'codex'), false, 'Codex metadata without an assistant reply is not restorable')
  T.noteSession('pane-codex-wrong-cwd', otherCwd, 'codex', codexId)
  assert.equal(T.resumeIdFor('pane-codex-wrong-cwd'), undefined, 'a named Codex id from another cwd is refused')
  for (const id of ['pane3', 'pane-codex-two', 'pane-codex-first-query-first', 'pane-codex-first-query-second', 'pane-codex-ambiguous-one', 'pane-codex-ambiguous-two', 'pane-codex-shared-one-first', 'pane-codex-shared-one-second', 'pane-codex-unique-one', 'pane-codex-unique-two', 'pane-codex-old', 'pane-codex-named', 'pane-codex-rehomed', 'pane-codex-wrong-cwd']) T.forgetSession(id)
  rmSync(codexHome, { recursive: true, force: true })
  rmSync(firstQueryCwd, { recursive: true, force: true })
  rmSync(sharedOneCwd, { recursive: true, force: true })
  rmSync(sharedThenUniqueCwd, { recursive: true, force: true })
  rmSync(rehomeCwd, { recursive: true, force: true })
  rmSync(otherCwd, { recursive: true, force: true })
  rmSync(oldCwd, { recursive: true, force: true })

  // A closed pane releases its claim, so the next pane in that folder can take it.
  T.forgetSession('pane1')
  T.noteSession('pane4', cwd, 'claude')
  transcript('chat-a', [user('pane one prompt')])
  assert.equal(T.resumeIdFor('pane4'), 'chat-a')
} finally {
  rmSync(projects, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

// ------------------------------------------------- a robot's chat is not a pane's

// A headless `claude -p` run files its transcript in the same per-cwd folder as the
// real session and finishes AFTER it, so it is the newest file at exactly the moment a
// pane re-picks - which is what /clear makes it do. Two of them run against real
// repos: the /clear handoff writer, and the dispatcher's agentic runs, which are given
// the repo as their cwd because they have to edit it. Claiming one put the pane's
// resume id on a machine conversation, and reopening the desk brought the pane back up
// inside a Haiku handoff distill.
//
// Its own folder, so the abandoned-chat rules above cannot supply the answer.
const cwd2 = mkdtempSync(join(tmpdir(), 'pf-headless-'))
const projects2 = join(homedir(), '.claude', 'projects', slug(cwd2))
mkdirSync(projects2, { recursive: true })
const write2 = (id, lines) => writeFileSync(join(projects2, `${id}.jsonl`), lines.join('\n'), 'utf8')

try {
  T.noteSession('pane5', cwd2, 'claude')
  write2('handoff', [user('Distill this Claude Code session digest')])
  assert.equal(T.resumeIdFor('pane5'), undefined, 'claimed a headless -p transcript')

  // The pane's own conversation, written after it, is still the answer.
  write2('chat-mine', [mode, user('the real work')])
  assert.equal(T.resumeIdFor('pane5'), 'chat-mine')

  // And once claimed it stays claimed, even though the robot writes again afterwards.
  write2('handoff', [user('Distill this Claude Code session digest'), assistant('done')])
  assert.equal(T.resumeIdFor('pane5'), 'chat-mine', 'drifted onto a headless transcript')
} finally {
  T.forgetSession('pane5')
  rmSync(projects2, { recursive: true, force: true })
  rmSync(cwd2, { recursive: true, force: true })
}

// ------------------------------------------------------- the argv that resumes

const A = load('src/shared/agents.ts', ['buildArgs', 'BUILTIN_AGENTS'])
const spec = (id) => A.BUILTIN_AGENTS.find((a) => a.id === id)
const claude = spec('claude')
// Bypass permissions can only be reached from argv, so Claude Code always leads with the
// flag - every form below carries it, exactly once, in front.
const bypass = (...rest) => ['--dangerously-skip-permissions', ...rest]
assert.deepEqual(A.buildArgs(claude, { resume: true, resumeId: 'chat-a' }), bypass('--resume', 'chat-a'))
// No id (or an agent with no way to take one): the old behaviour, unchanged.
assert.deepEqual(A.buildArgs(claude, { resume: true }), bypass('--continue'))
// Codex has a named resume subcommand, so the exact id is never replaced by --last.
assert.deepEqual(A.buildArgs(spec('codex'), { resume: true, resumeId: 'x' }), [
  'resume',
  'x'
])
// The model still lands after the resume form, whichever one was used.
assert.deepEqual(
  A.buildArgs(claude, { resume: true, resumeId: 'c', model: 'claude-opus-5' }),
  bypass('--resume', 'c', '--model', 'claude-opus-5')
)
assert.deepEqual(A.buildArgs(claude, {}), bypass())
// A fresh pane starts in bypass too, and the flag is never doubled up.
const fresh = A.buildArgs(claude, {})
assert.equal(
  fresh.filter((a) => a === '--dangerously-skip-permissions').length,
  1,
  'the bypass flag must appear exactly once'
)

console.log('restore-context-test: OK')
