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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
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
  'lastPrompt',
  'promptFromTail',
  'resumable'
])

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
  transcript('chat-a', [user('pane one prompt')])
  assert.equal(T.resumeIdFor('pane1'), 'chat-a')

  // Two panes in one folder must not both resume the same conversation.
  T.noteSession('pane2', cwd, 'claude')
  transcript('chat-b', [user('pane two prompt')])
  assert.equal(T.resumeIdFor('pane2'), 'chat-b')
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one lost its chat to pane two')

  // /clear starts a new transcript inside the same pane. The pane follows it only
  // because it said so - sessions.ts re-notes the pane when that command is submitted.
  transcript('chat-c', [user('after the clear')])
  assert.equal(T.resumeIdFor('pane2'), 'chat-b', 'moved conversation without being told')
  T.noteSession('pane2', cwd, 'claude')
  assert.equal(T.resumeIdFor('pane2'), 'chat-c')
  // And the OTHER pane must not drift onto the conversation pane two just left, even
  // though it is newer than its own and nobody is holding it any more.
  assert.equal(T.resumeIdFor('pane1'), 'chat-a', 'pane one drifted onto an abandoned chat')

  // The dialog reads the prompt out of the conversation it is about to reopen.
  assert.equal(T.lastPrompt(cwd, 'chat-a'), 'pane one prompt')
  assert.equal(T.lastPrompt(cwd, 'chat-c'), 'after the clear')

  // A conversation deleted since the desk was written cannot be resumed by name, and
  // must not be passed to the CLI as if it could.
  assert.equal(T.resumable(cwd, 'chat-a'), true)
  assert.equal(T.resumable(cwd, 'gone'), false)
  assert.equal(T.resumable(cwd, undefined), false)
  assert.equal(T.lastPrompt(cwd, 'gone'), undefined)
  // A path, not an id: never allowed to escape the project folder.
  assert.equal(T.resumable(cwd, '../../../etc/passwd'), false)

  // Only agents that keep per-directory transcripts get named conversations.
  T.noteSession('pane3', cwd, 'codex')
  assert.equal(T.resumeIdFor('pane3'), undefined)

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
assert.deepEqual(A.buildArgs(claude, { resume: true, resumeId: 'chat-a' }), ['--resume', 'chat-a'])
// No id (or an agent with no way to take one): the old behaviour, unchanged.
assert.deepEqual(A.buildArgs(claude, { resume: true }), ['--continue'])
assert.deepEqual(A.buildArgs(spec('codex'), { resume: true, resumeId: 'x' }), [
  'resume',
  '--last'
])
// The model still lands after the resume form, whichever one was used.
assert.deepEqual(A.buildArgs(claude, { resume: true, resumeId: 'c', model: 'claude-opus-5' }), [
  '--resume',
  'c',
  '--model',
  'claude-opus-5'
])
assert.deepEqual(A.buildArgs(claude, {}), [])

console.log('restore-context-test: OK')
