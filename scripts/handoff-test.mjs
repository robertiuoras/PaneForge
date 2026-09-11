// A pane handed to another machine, end to end, with nothing faked that matters:
// a real repo with a real bare origin, a real loopback link between a real
// RemoteHost and RemoteClient, and a transcript big enough that it MUST travel
// as chunks. The far end's "session manager" is a capture - everything up to
// the pty is the thing under test, and the pty is the one part that cannot move.
//
// The refusal case is load-bearing: a receiver whose checkout holds uncommitted
// work must say so and touch nothing, and the sender must keep its pane.

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-handoff-'))
let failures = 0
let checks = 0

function ok(what, cond, detail = '') {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function bundle() {
  const entry = join(out, 'entry.ts')
  const p = (rel) => JSON.stringify(join(root, rel).replace(/\\/g, '/'))
  writeFileSync(
    entry,
    [
      `export { RemoteHost } from ${p('src/main/remote/host.ts')}`,
      `export { RemoteClient } from ${p('src/main/remote/client.ts')}`,
      `export { newCode } from ${p('src/main/remote/wire.ts')}`,
      `export { sendHandoff, receiveHandoff, writeConversation } from ${p('src/main/handoff.ts')}`,
      `export { handoffReceiverCanQuit, mapCwd, handoffReport, handoffConversationError } from ${p('src/shared/handoff.ts')}`
    ].join('\n'),
    'utf8'
  )
  const file = join(out, 'handoff.mjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    outfile: file
  })
  return file
}

/** Every HostBackend method the handoff path never touches, stubbed inert. */
function inertBackend() {
  return {
    list: () => [],
    buffer: () => '',
    write: () => {},
    resize: () => {},
    returnSize: () => {},
    redraw: () => {},
    setBusy: () => {},
    clearAttention: () => {},
    kill: () => {},
    restart: () => null,
    rename: () => {},
    switchAgent: () => null,
    startSession: () => {
      throw new Error('not under test')
    },
    projects: () => Promise.resolve([]),
    agents: () => Promise.resolve([]),
    onData: () => () => {},
    onTyped: () => () => {},
    onSessions: () => () => {},
    onAttention: () => () => {}
  }
}

const mod = await import(pathToFileURL(bundle()).href)
const { RemoteHost, RemoteClient, newCode, sendHandoff, receiveHandoff, writeConversation, mapCwd, handoffReceiverCanQuit, handoffReport, handoffConversationError } = mod

// ---------------------------------------------------------------- mapCwd
console.log('mapCwd')
ok('mac path onto a windows root', mapCwd('/Users/r/Projects/PaneForge', '/Users/r/Projects', 'C:\\Users\\G\\Desktop\\Projects') === 'C:\\Users\\G\\Desktop\\Projects\\PaneForge')
ok('windows path onto a mac root', mapCwd('C:\\Users\\G\\Desktop\\Projects\\a\\b', 'C:\\Users\\G\\Desktop\\Projects', '/Users/r/Projects') === '/Users/r/Projects/a/b')
ok('the root itself maps to the root', mapCwd('/Users/r/Projects', '/Users/r/Projects', '/x') === '/x')
ok('outside the root refuses', mapCwd('/etc/passwd', '/Users/r/Projects', '/x') === null)
ok('prefix is a path segment, not a string prefix', mapCwd('/Users/r/Projects2/app', '/Users/r/Projects', '/x') === null)

console.log('receiver close gate')
ok('an idle transferred pane keeps the receiver open', !handoffReceiverCanQuit(new Set(['pc-1']), [{ id: 'pc-1', status: 'idle' }]))
ok(
  'another local pane keeps the receiver open after the handoff exits',
  !handoffReceiverCanQuit(new Set(['pc-1']), [
    { id: 'pc-1', status: 'exited' },
    { id: 'other', status: 'working' }
  ])
)
ok('an exited transfer with no local work may close the receiver', handoffReceiverCanQuit(new Set(['pc-1']), [{ id: 'pc-1', status: 'exited' }]))
ok('no transfer never quits the receiver', !handoffReceiverCanQuit(new Set(), []))

console.log('conversation transfer contract')
ok('Claude needs both a resume flag and id', Boolean(handoffConversationError({ agent: 'claude', resumeId: 'c1' })))
ok('Codex uses the same explicit resume contract', handoffConversationError({ agent: 'codex', resume: true, resumeId: 'c1' }, { name: 'c1.jsonl', size: 1 }, 1) === null)
ok('a plain shell has explicit fresh-shell semantics', handoffConversationError({ agent: 'shell' }) === null)

// A pane that came from here and is coming back. Its transcript is the SAME conversation
// with more turns on the end, so the copy this disk still holds is a byte prefix of the
// incoming one - the round trip Mac -> PC -> Mac, which refused and lost the far end's
// turns until 2026-09-08.
const convDir = join(out, 'writeconv')
mkdirSync(convDir, { recursive: true })
const older = Buffer.from('{"a":1}\n')
const newer = Buffer.from('{"a":1}\n{"b":2}\n')
const fresh = join(convDir, 'fresh.jsonl')
ok('a conversation that is not here yet is written', writeConversation(fresh, newer) === null && readFileSync(fresh).equals(newer))
ok('the same conversation twice is a no-op', writeConversation(fresh, newer) === null && readFileSync(fresh).equals(newer))
const back = join(convDir, 'back.jsonl')
writeFileSync(back, older)
ok(
  'the same conversation with more turns replaces the older copy',
  writeConversation(back, newer) === null && readFileSync(back).equals(newer)
)
const other = join(convDir, 'other.jsonl')
writeFileSync(other, Buffer.from('{"z":9}\n'))
ok(
  'a genuinely different conversation is still refused, bytes untouched',
  typeof writeConversation(other, newer) === 'string' && readFileSync(other).toString() === '{"z":9}\n'
)
ok(
  'a SHORTER incoming conversation is refused - it is not this one grown',
  typeof writeConversation(back, older) === 'string' && readFileSync(back).equals(newer)
)
ok('no temp file is left behind', readdirSync(convDir).every((f) => !f.includes('.tmp')))

// ---------------------------------------------------------------- the link
const senderRoot = join(out, 'sender')
const receiverRoot = join(out, 'receiver')
const claudeDir = join(out, 'claude-projects')
const historyDir = join(out, 'history')
for (const d of [senderRoot, receiverRoot]) mkdirSync(d, { recursive: true })

// A real repo with a real origin: the git remote is the code's transport.
const repo = join(senderRoot, 'proj')
const origin = join(out, 'origin.git')
mkdirSync(repo)
git(out, 'init', '--bare', origin)
git(senderRoot, 'init', '-b', 'work', repo)
git(repo, 'config', 'user.email', 't@t')
git(repo, 'config', 'user.name', 't')
writeFileSync(join(repo, 'app.js'), 'one\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'feat: start')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', 'origin', 'work')
// ...and uncommitted work on top, which the handoff must carry.
writeFileSync(join(repo, 'app.js'), 'one\ntwo\n')
writeFileSync(join(repo, 'new.txt'), 'born dirty\n')

// A transcript that cannot fit one chunk: reassembly is the thing proved.
const transcript = join(out, 'conv123.jsonl')
const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4000) } }) + '\n'
writeFileSync(transcript, line.repeat(1300)) // ~5.2 MB
const transcriptBytes = readFileSync(transcript)

const started = []
const notedCols = []
const receiver = {
  root: () => receiverRoot,
  place: async (req) => ({ ...req }),
  start: (req) => {
    started.push(req)
    return { id: `pc-${started.length}`, title: req.title ?? 'pane', cwd: req.cwd, agent: req.agent ?? 'claude', status: 'idle', lastOutput: 0, createdAt: 0 }
  },
  historyDir: () => historyDir,
  noteTailCols: (id, cols) => notedCols.push([id, cols]),
  claudeProjectDir: (cwd) => join(claudeDir, cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

const backend = inertBackend()
const received = []
backend.receiveHandoff = (payload, file) => {
  received.push(payload)
  return receiveHandoff(receiver, payload, file)
}

const code = newCode()
const port = await freePort()
const me = (id, name) => () => ({ id, name, platform: process.platform, version: '0.0.0', handoffResume: ['claude', 'codex'] })
const host = new RemoteHost(backend, me('pc', 'PC'), () => code)
host.start(port)
const client = new RemoteClient({ id: 'pc', name: 'PC', address: '127.0.0.1', port, code, auto: false }, me('mac', 'Laptop'))
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`link never came up: ${client.error}`)), 10_000)
  client.on('status', () => {
    if (client.status === 'online') {
      clearTimeout(t)
      resolve()
    }
  })
  client.connect()
})

// ---------------------------------------------------------------- hand one pane over
console.log('handoff')
const killed = []
const sender = {
  root: () => senderRoot,
  list: () => [
    { id: 's1', title: 'proj', cwd: repo, agent: 'claude', status: 'idle', lastOutput: 0, createdAt: 0 },
    { id: 's2', title: 'leave here', cwd: repo, agent: 'claude', status: 'idle', lastOutput: 0, createdAt: 0 }
  ],
  snapshot: () => [
    { cwd: repo, title: 'proj', agent: 'claude', resumeId: 'conv123', scrollbackId: 's1' },
    { cwd: repo, title: 'leave here', agent: 'claude', scrollbackId: 's2' }
  ],
  kill: (id) => killed.push(id),
  tailOf: () => 'SCREEN-TAIL\u001b[32mgreen\u001b[0m\n',
  tailColsOf: () => 157,
  transcriptFileFor: () => transcript,
  canResume: () => true,
  deliver: (dev, payload, file) => client.handoff(payload, file),
  deviceName: () => 'PC'
}

const items = await sendHandoff(sender, 'pc', { ids: ['s1'], closeReceiverWhenDone: true })
ok('one pane, one report', items.length === 1)
ok('the pane moved', items[0]?.ok === true, items[0]?.error)
ok('the sender pane stays open until the remote Claude resume is confirmed', killed.length === 0)
ok('the successful agent transfer records that its source stayed open', items[0]?.sourceKept === true)
ok('the successful copy says why the original remains', /original pane stays open/.test(items[0]?.notes.join(' ') ?? ''))
ok('a focused handoff leaves every other pane here', !killed.includes('s2'))

// ---------------------------------------------------------------- the resume is proven, or it is not
// The receiver watches the started pane (`shared/resumeCheck.ts`) and answers `resumed`.
// Proven: the sender CLOSES its copy, the way a shell pane's already is - no second row
// wearing the same conversation. Failed: refused, the receiver's dead pane closed, the
// sender's pane kept awake. Unknown (an older receiver, a slow machine): the old
// sleep-and-keep, now stamped `movedTo` so nothing sends it again.
{
  // The checks further down read what the FIRST transfer recorded; these extra transfers
  // must not be counted against them.
  const savedCols = notedCols.splice(0)
  const savedStarted = started.splice(0)
  const receiverKilled = []
  const moved = []
  const sender2 = { ...sender, moved: (id, device) => moved.push([id, device]) }
  receiver.resumed = async () => 'ok'
  const before = received.length
  const proven = await sendHandoff(sender2, 'pc', { ids: ['s1'] })
  ok('a confirmed resume moves the pane', proven[0]?.ok === true, proven[0]?.error)
  ok('a confirmed resume closes the original here - it is running over there', killed.includes('s1'))
  ok('a confirmed resume does not report the source as kept', proven[0]?.sourceKept !== true)
  ok('a confirmed resume says nothing about an original staying open', !/original pane stays open/.test(proven[0]?.notes.join(' ') ?? ''))
  ok('a confirmed resume is not stamped as moved-without-proof', moved.length === 0)
  ok('the confirmation reached the sender in the result', received.length === before + 1)

  receiver.resumed = async () => 'failed'
  receiver.kill = (id) => receiverKilled.push(id)
  killed.length = 0
  const failed = await sendHandoff(sender2, 'pc', { ids: ['s1'] })
  ok('a failed resume is refused', failed[0]?.ok === false)
  ok('a failed resume says the conversation did not resume', /did not resume/.test(failed[0]?.error ?? ''), failed[0]?.error)
  ok('a failed resume closes the dead pane over there', receiverKilled.length === 1)
  ok('a failed resume keeps the original here, awake', killed.length === 0 && moved.length === 0)

  receiver.resumed = async () => 'unknown'
  const unknown = await sendHandoff(sender2, 'pc', { ids: ['s1'] })
  ok('an unconfirmed resume still opens over there', unknown[0]?.ok === true, unknown[0]?.error)
  ok('an unconfirmed resume keeps the original here', killed.length === 0 && unknown[0]?.sourceKept === true)
  ok('an unconfirmed resume stamps the original as moved to that device', moved.length === 1 && moved[0][0] === 's1' && moved[0][1] === 'pc')
  delete receiver.resumed
  delete receiver.kill

  // ...and a pane already stamped is never sent again: the far end would refuse it.
  const stamped = { ...sender2, list: () => sender.list().map((s) => (s.id === 's1' ? { ...s, movedTo: 'pc' } : s)) }
  const sent = received.length
  const again = await sendHandoff(stamped, 'pc', { ids: ['s1'] })
  ok('a conversation already running over there is refused before anything is sent', again[0]?.ok === false && received.length === sent)
  ok('...and the refusal names where it runs and what to do', /already running on PC/.test(again[0]?.error ?? ''), again[0]?.error)
  notedCols.splice(0, notedCols.length, ...savedCols)
  started.splice(0, started.length, ...savedStarted)
}

const clone = join(receiverRoot, 'proj')
ok('the repo was cloned under the receiving root', existsSync(join(clone, '.git')))
// Line endings are the checkout's business, not the handoff's: git on Windows writes
// CRLF through core.autocrlf, so comparing the bytes raw failed here while the work had
// travelled perfectly. What is being asserted is the CONTENT arriving.
const lf = (s) => s.replace(/\r\n/g, '\n')
ok(
  'the dirty work travelled through the remote',
  existsSync(join(clone, 'new.txt')) && lf(readFileSync(join(clone, 'app.js'), 'utf8')) === 'one\ntwo\n'
)
ok('the WIP commit is an auto-sync subject', git(clone, 'log', '--format=%s', '-1') === 'auto-sync: handoff to PC')
ok('the sender repo is clean after the push', git(repo, 'status', '--porcelain') === '')

const req = started[0]
ok('the far pane starts in the mapped folder', req?.cwd === clone, req?.cwd)
ok('the far pane resumes THAT conversation', req?.resume === true && req?.resumeId === 'conv123')
ok('the far pane carries its close-when-done instruction', received[0]?.closeReceiverWhenDone === true)
const landed = join(receiver.claudeProjectDir(clone), 'conv123.jsonl')
ok('the transcript landed where the CLI looks', existsSync(landed))
ok('5 MB of chunks reassembled byte-for-byte', existsSync(landed) && readFileSync(landed).equals(transcriptBytes))
ok('the screen tail seeds the far scrollback', Boolean(req?.scrollbackId) && readFileSync(join(historyDir, `${req.scrollbackId}.log`), 'utf8').includes('SCREEN-TAIL'))
// The tail is a frame of ABSOLUTE column moves painted in the sender's pane, and a
// terminal clamps a move past its own last column - so replayed into a narrower pane it
// piles every line onto the right-hand edge and no repaint can repair it, because the
// wreckage is in the scrollback and Fix only redraws the screen. Measured PC -> Mac,
// 2026-08-23: a 157-column frame in this Mac pane, unreadable.
ok('the width the tail was painted at travels', received[0]?.tailCols === 157, String(received[0]?.tailCols))
ok(
  'and is recorded against the id the tail was written under, so colsOf can answer',
  notedCols.length === 1 && notedCols[0][0] === req?.scrollbackId && notedCols[0][1] === 157,
  JSON.stringify(notedCols)
)

// A failed conversation preflight must leave the source exactly alone. These all
// use a dirty repo so an accidental call to pushRepo would create an auto-sync
// commit and make the failure visible here.
console.log('conversation safety refusals')
writeFileSync(join(repo, 'handoff-safety.txt'), 'must remain unpushed\n')
const safetyHead = git(repo, 'rev-parse', 'HEAD')
const safetyStatus = git(repo, 'status', '--porcelain')
let safetyDeliveries = 0
const safetyKilled = []
const safetySender = (agent, resumeId, transcriptFileFor) => ({
  ...sender,
  list: () => [{ id: 'safe', title: `${agent} safety`, cwd: repo, agent, status: 'idle', lastOutput: 0, createdAt: 0 }],
  snapshot: () => [{ cwd: repo, title: `${agent} safety`, agent, resumeId, scrollbackId: 'safe' }],
  kill: (id) => safetyKilled.push(id),
  transcriptFileFor,
  deliver: async () => {
    safetyDeliveries++
    return { ok: true, notes: [] }
  }
})
const missingConversation = await sendHandoff(safetySender('claude', 'missing', () => null), 'pc', { ids: ['safe'] })
ok('missing Claude transcript refuses before delivery', /transcript is missing/.test(missingConversation[0]?.error ?? '') && safetyDeliveries === 0)
ok('missing Claude transcript leaves source repo unpushed and pane alive', git(repo, 'rev-parse', 'HEAD') === safetyHead && safetyKilled.length === 0)
const tooLarge = join(out, 'too-large.jsonl')
writeFileSync(tooLarge, Buffer.alloc(64 * 1024 * 1024 + 1))
const oversizedConversation = await sendHandoff(safetySender('claude', 'too-large', () => tooLarge), 'pc', { ids: ['safe'] })
ok('oversized Claude transcript refuses before delivery', /too large/.test(oversizedConversation[0]?.error ?? '') && safetyDeliveries === 0)
const codexConversation = await sendHandoff(safetySender('codex', 'codex-1', () => transcript), 'pc', { ids: ['safe'] })
ok('malformed Codex transcript refuses before delivery', /malformed|completed assistant reply/.test(codexConversation[0]?.error ?? '') && safetyDeliveries === 0)
let queuedUnsupported = 0
const busyCodex = await sendHandoff(
  {
    ...safetySender('codex', 'codex-1', () => transcript),
    busy: () => true,
    queue: () => queuedUnsupported++
  },
  'pc',
  { ids: ['safe'] }
)
ok('a busy first-turn Codex pane queues without delivery, git mutation, or source close', busyCodex[0]?.pending === true && queuedUnsupported === 1 && safetyDeliveries === 0 && safetyKilled.length === 0)
const noReply = join(out, 'no-reply.jsonl')
writeFileSync(noReply, JSON.stringify({ type: 'user', message: { role: 'user', content: 'unfinished' } }) + '\n')
const incompleteClaude = await sendHandoff(safetySender('claude', 'no-reply', () => noReply), 'pc', { ids: ['safe'] })
ok('Claude transcript without a completed reply refuses before delivery', /no completed assistant reply/.test(incompleteClaude[0]?.error ?? '') && safetyDeliveries === 0)
ok(
  'all conversation refusals leave source repo bytes, index, branch and pane intact',
  git(repo, 'rev-parse', 'HEAD') === safetyHead && git(repo, 'status', '--porcelain') === safetyStatus && safetyKilled.length === 0
)
rmSync(join(repo, 'handoff-safety.txt'))

// ---------------------------------------------------------------- Codex transcript transport
// This is intentionally a synthetic rollout under a temporary CODEX_HOME. It proves the
// wire/import contract without reading, writing, or needing a real user's Codex sessions.
console.log('Codex transport')
const savedCodexHome = process.env.CODEX_HOME
const codexHome = join(out, 'codex-home')
process.env.CODEX_HOME = codexHome
const codexId = '018f0000-0000-7000-8000-000000000001'
const codexTime = '2026-09-05T16:47:16.000Z'
const codexSource = join(out, 'codex-source.jsonl')
const codexRows = [
  { type: 'session_meta', payload: { id: codexId, timestamp: codexTime, cwd: repo } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'complete' }] } }
]
writeFileSync(codexSource, codexRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const codexKilled = []
const codexSender = {
  ...sender,
  list: () => [{ id: 'codex-wire', title: 'Codex wire', cwd: repo, agent: 'codex', status: 'idle', lastOutput: 0, createdAt: 0 }],
  snapshot: () => [{ cwd: repo, title: 'Codex wire', agent: 'codex', model: 'gpt-test-model', resumeId: codexId, scrollbackId: 'codex-wire' }],
  kill: (id) => codexKilled.push(id),
  transcriptFileFor: () => codexSource,
  deliver: (dev, payload, file) => client.handoff(payload, file)
}
const beforeCodexStart = started.length
const codexMoved = await sendHandoff(codexSender, 'pc', { ids: ['codex-wire'] })
const codexReq = started.at(-1)
const codexTarget = join(codexHome, 'sessions', '2026', '09', '05', `rollout-2026-09-05T16-47-16-${codexId}.jsonl`)
const importedRows = existsSync(codexTarget) ? readFileSync(codexTarget, 'utf8').trim().split('\n').map(JSON.parse) : []
ok('Codex crosses the encrypted handoff link and starts by exact id', codexMoved[0]?.ok && started.length === beforeCodexStart + 1 && codexReq?.resumeId === codexId)
ok('Codex handoff preserves the selected model and retains the source pane', codexReq?.model === 'gpt-test-model' && codexMoved[0]?.sourceKept === true && codexKilled.length === 0)
ok('Codex import remaps only session metadata cwd to the receiver workspace', importedRows[0]?.payload?.cwd === clone && importedRows[1]?.payload?.content?.[0]?.text === 'complete')

let transportStarts = 0
let transportPlaces = 0
const transportReceiver = { ...receiver, place: async (r) => { transportPlaces++; return r }, start: () => { transportStarts++; throw new Error('must not start') } }
const codexPayload = (id, file, sourceRetained = true) => ({
  spec: { cwd: clone, agent: 'codex', model: 'gpt-test-model', resume: true, resumeId: id },
  senderRoot: receiverRoot,
  transcript: { name: `${id}.jsonl`, size: file.length },
  ...(sourceRetained ? { sourceRetained: true } : {})
})
const malformedCodex = Buffer.from('{bad json\n')
const wrongIdCodex = Buffer.from(codexRows.map((r, n) => JSON.stringify(n ? r : { ...r, payload: { ...r.payload, id: '018f0000-0000-7000-8000-000000000002' } })).join('\n') + '\n')
const conflictingSessionId = Buffer.from(codexRows.map((r, n) => JSON.stringify(n ? r : { ...r, payload: { ...r.payload, session_id: '018f0000-0000-7000-8000-000000000002' } })).join('\n') + '\n')
const duplicateMeta = Buffer.from([...codexRows, codexRows[0]].map(JSON.stringify).join('\n') + '\n')
const noAssistantCodex = Buffer.from(JSON.stringify(codexRows[0]) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } }) + '\n')
for (const [label, id, file] of [['corrupt Codex JSONL', codexId, malformedCodex], ['wrong Codex metadata id', codexId, wrongIdCodex], ['Codex transcript without assistant reply', codexId, noAssistantCodex]]) {
  const result = await receiveHandoff(transportReceiver, codexPayload(id, file), file)
  ok(`${label} refuses before repo or lane placement`, !result.ok && transportStarts === 0 && transportPlaces === 0)
}
for (const [label, file] of [['conflicting Codex session_id', conflictingSessionId], ['duplicate Codex metadata', duplicateMeta]]) {
  const result = await receiveHandoff(transportReceiver, codexPayload(codexId, file), file)
  ok(`${label} refuses before repo or lane placement`, !result.ok && transportStarts === 0 && transportPlaces === 0)
}
const noRetention = await receiveHandoff(transportReceiver, codexPayload(codexId, Buffer.from(readFileSync(codexSource)), false), Buffer.from(readFileSync(codexSource)))
ok('receiver refuses an old sender without source-retention proof before mutation', !noRetention.ok && transportStarts === 0)
const changedCodex = Buffer.from(codexRows.map((r, n) => JSON.stringify(n ? { ...r, payload: { ...r.payload, content: [{ type: 'output_text', text: 'different' }] } } : r)).join('\n') + '\n')
const codexConflict = await receiveHandoff(transportReceiver, codexPayload(codexId, changedCodex), changedCodex)
ok('a conflicting Codex destination refuses without overwrite', !codexConflict.ok && readFileSync(codexTarget, 'utf8').includes('complete') && transportStarts === 0)
const blockedCodexHome = join(out, 'codex-home-file')
writeFileSync(blockedCodexHome, 'not a directory')
const publishId = '018f0000-0000-7000-8000-000000000003'
const publishRows = codexRows.map((row, n) => n ? row : { ...row, payload: { ...row.payload, id: publishId } })
const publishBody = Buffer.from(publishRows.map(JSON.stringify).join('\n') + '\n')
process.env.CODEX_HOME = blockedCodexHome
const failedPublish = await receiveHandoff(transportReceiver, codexPayload(publishId, publishBody), publishBody)
ok('failed Codex publish leaves no destination or temporary transcript poison', !failedPublish.ok && !existsSync(join(blockedCodexHome, 'sessions')) && transportStarts === 0)
process.env.CODEX_HOME = codexHome
const claudeConflictFile = join(claudeDir, clone.replace(/[^A-Za-z0-9]/g, '-'), 'claude-conflict.jsonl')
mkdirSync(dirname(claudeConflictFile), { recursive: true }); writeFileSync(claudeConflictFile, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'old' } }) + '\n')
const claudeConflictBody = Buffer.from(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'new' } }) + '\n')
const claudeConflict = await receiveHandoff(transportReceiver, { spec: { cwd: clone, agent: 'claude', resume: true, resumeId: 'claude-conflict' }, senderRoot: receiverRoot, sourceRetained: true, transcript: { name: 'claude-conflict.jsonl', size: claudeConflictBody.length } }, claudeConflictBody)
ok('a conflicting Claude destination refuses without overwrite', !claudeConflict.ok && readFileSync(claudeConflictFile, 'utf8').includes('old') && transportStarts === 0)
const deliveriesBeforeLegacy = safetyDeliveries
const legacyCodex = await sendHandoff({ ...safetySender('codex', codexId, () => codexSource), canResume: () => false }, 'pc', { ids: ['safe'] })
ok('legacy peer with no resume advertisement refuses before git, queue, delivery, or source close', !legacyCodex[0]?.ok && /does not support safe Codex resume/.test(legacyCodex[0]?.error ?? '') && safetyDeliveries === deliveriesBeforeLegacy && safetyKilled.length === 0)
if (savedCodexHome === undefined) delete process.env.CODEX_HOME
else process.env.CODEX_HOME = savedCodexHome

let malformedStarts = 0
const malformedRoot = join(out, 'malformed-receiver')
const malformed = await receiveHandoff(
  {
    ...receiver,
    root: () => malformedRoot,
    place: async (r) => r,
    start: () => {
      malformedStarts++
      throw new Error('must not start')
    }
  },
  {
    spec: { cwd: repo, agent: 'claude', resume: true, resumeId: 'missing' },
    senderRoot,
    transcript: { name: 'missing.jsonl', size: 1 }
  },
  null
)
ok('receiver refuses a missing conversation before creating a folder or pane', !malformed.ok && malformedStarts === 0 && !existsSync(malformedRoot))
const shellHandoff = await receiveHandoff(
  receiver,
  { spec: { cwd: clone, agent: 'shell' }, senderRoot: receiverRoot },
  null
)
ok('plain shell handoff explicitly starts a fresh shell', shellHandoff.ok && shellHandoff.session?.agent === 'shell')

// ---------------------------------------------------------------- move it NOW
// A mid-turn pane moved on purpose: the turn is stopped first (the CLI's own Escape, via
// the interrupt dep), the ordinary handoff runs once the pane reads idle, and the far end
// is asked to carry on. Robert, 2026-09-08: "i know that session 4 can be run on pc
// probably its just ai domain name checking so i want to move it ... mid turn".
console.log('move now')
{
  let busyNow = true
  let interrupted = 0
  const deliveriesBefore = received.length
  const nowSender = {
    ...sender,
    list: () => [{ id: 's1', title: 'proj', cwd: repo, agent: 'claude', status: 'working', lastOutput: 0, createdAt: 0 }],
    busy: () => busyNow,
    queue: () => { throw new Error('a NOW move must never queue') },
    interrupt: async () => { interrupted++; busyNow = false; return true },
    selfDevice: () => 'mac',
    deviceName: (d) => (d === 'mac' ? 'Laptop' : 'PC')
  }
  const moved = await sendHandoff(nowSender, 'pc', { ids: ['s1'], now: true })
  ok('a busy pane moved with now is interrupted once, then moves', interrupted === 1 && moved[0]?.ok === true && !moved[0]?.pending, moved[0]?.error)
  const payload = received.at(-1)
  ok('the payload asks the far end to carry on, naming where it came from', received.length === deliveriesBefore + 1 && /carry on/i.test(payload?.continueWith ?? '') && /Laptop/.test(payload?.continueWith ?? ''), payload?.continueWith)
  const far = started.at(-1)
  ok('the far pane resumes the conversation AND is handed that prompt', far?.resume === true && far?.resumeId === 'conv123' && far?.prompt === payload?.continueWith, JSON.stringify({ resume: far?.resume, prompt: far?.prompt }))
  ok('the report says the turn was interrupted and it was asked to carry on', (moved[0]?.notes ?? []).some((n) => /carry on/.test(n)), JSON.stringify(moved[0]?.notes))

  // A turn that will not stop is a refusal by name, and nothing was delivered.
  busyNow = true
  const stuck = await sendHandoff({ ...nowSender, interrupt: async () => false }, 'pc', { ids: ['s1'], now: true })
  ok('a turn that does not stop refuses by name, delivers nothing', stuck[0]?.ok === false && /did not stop within \d+s/.test(stuck[0]?.error ?? '') && received.length === deliveriesBefore + 1, stuck[0]?.error)
  const cannot = await sendHandoff({ ...nowSender, interrupt: undefined }, 'pc', { ids: ['s1'], now: true })
  ok('a build with no interrupt refuses rather than queueing or killing', cannot[0]?.ok === false && /cannot interrupt/.test(cannot[0]?.error ?? '') && received.length === deliveriesBefore + 1, cannot[0]?.error)

  // An idle pane moved with now is simply moved: nothing to interrupt, no carry-on prompt.
  busyNow = false
  interrupted = 0
  const idle = await sendHandoff(nowSender, 'pc', { ids: ['s1'], now: true })
  ok('an idle pane moved with now is not interrupted and not asked to carry on', idle[0]?.ok === true && interrupted === 0 && received.at(-1)?.continueWith === undefined && started.at(-1)?.prompt === undefined, idle[0]?.error)
}

// ---------------------------------------------------------------- refusals
console.log('refusals')
writeFileSync(join(clone, 'local-edit.txt'), 'work someone did on the PC\n')
const again = await sendHandoff(sender, 'pc', { ids: ['s1'] })
ok('a dirty receiver checkout refuses by name', again[0]?.ok === false && /uncommitted/.test(again[0]?.error ?? ''), again[0]?.error)
ok('the refused pane was NOT closed', killed.length === 0)
ok('the receiver kept its local edit', readFileSync(join(clone, 'local-edit.txt'), 'utf8').includes('someone'))
rmSync(join(clone, 'local-edit.txt'))

// ------------------------------------------ the network is not asked for what both have
// Measured 2026-08-23 between this Mac and the PC over the real origin: the sender's push
// is 944 ms and the receiver's fetch 1042 ms, of a transfer whose every other step is tens
// of milliseconds - and on two desks that autosync, neither of them moves a single object.
// The proof is that the handoff still works with origin pointed at nothing: if either end
// touched the remote it could not.
{
  const nowhere = join(out, 'no-such-origin.git')
  git(repo, 'remote', 'set-url', 'origin', nowhere)
  git(clone, 'remote', 'set-url', 'origin', nowhere)
  const insync = await sendHandoff(sender, 'pc', { ids: ['s1'] })
  ok('an in-sync handoff never touches the remote', insync[0]?.ok === true, insync[0]?.error)
  ok(
    'the sender hands over the commit it is standing on',
    received.at(-1)?.repo?.sha === git(repo, 'rev-parse', 'HEAD'),
    received.at(-1)?.repo?.sha
  )
  // The control. Without it the two skips above would pass while the handoff had simply
  // stopped carrying code at all.
  writeFileSync(join(repo, 'app.js'), 'one\ntwo\nthree\n')
  const broken = await sendHandoff(sender, 'pc', { ids: ['s1'] })
  ok('...but real work still has to reach it', broken[0]?.ok === false && /Push failed/.test(broken[0]?.error ?? ''), broken[0]?.error)
  git(repo, 'remote', 'set-url', 'origin', origin)
  git(clone, 'remote', 'set-url', 'origin', origin)
  git(repo, 'checkout', '--', 'app.js')
  git(repo, 'reset', '--hard', 'HEAD')
}

// -------------------------------------------- a lane worktree handed to the other desk
// The question this answers: a letter lane is local scratch on BOTH desks, and both call
// it `lane-a`, so what happens when one is handed over. The contract is that the receiver
// never destroys local work - so the far desk's own lane, which has commits origin has
// never seen, must refuse by name rather than be fast-forwarded over. A lane the far desk
// does NOT have is a different question and still lands.
{
  const lane = (branch, dir) => {
    git(repo, 'worktree', 'add', '-b', branch, dir)
    writeFileSync(join(dir, `${branch}-work.txt`), 'mac lane work\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-m', `feat: ${branch} on the mac`)
    return {
      ...sender,
      list: () => [{ id: 'l1', title: branch, cwd: dir, agent: 'shell', status: 'idle', lastOutput: 0, createdAt: 0 }],
      snapshot: () => [{ cwd: dir, title: branch, agent: 'shell', scrollbackId: 'l1' }]
    }
  }

  // The far desk is already using a lane of the same name, with work of its own.
  const farLane = join(receiverRoot, 'proj-a')
  git(clone, 'worktree', 'add', '-b', 'lane-a', farLane)
  writeFileSync(join(farLane, 'pc-lane.txt'), 'work someone did on the PC lane\n')
  git(farLane, 'add', '-A')
  git(farLane, 'commit', '-m', 'feat: pc lane work')

  const clash = await sendHandoff(lane('lane-a', join(senderRoot, 'proj-a')), 'pc', { ids: ['l1'] })
  ok(
    'a lane handed to a desk already holding its own lane of that name refuses by name',
    clash[0]?.ok === false && /unpushed commit/.test(clash[0]?.error ?? ''),
    clash[0]?.error
  )
  ok('...and the other desk keeps its own lane commit', existsSync(join(farLane, 'pc-lane.txt')))
  ok('...and stays on its own lane branch', git(farLane, 'rev-parse', '--abbrev-ref', 'HEAD') === 'lane-a')

  // The control: a lane that desk has never had is not a collision, and still arrives.
  const fresh = await sendHandoff(lane('lane-b', join(senderRoot, 'proj-b')), 'pc', { ids: ['l1'] })
  ok('a lane the far desk does not have still lands', fresh[0]?.ok === true, fresh[0]?.error)
  ok('a successful shell handoff still closes its original pane', killed.includes('l1'))
  ok(
    '...in a folder of its own, never over the trunk checkout',
    existsSync(join(receiverRoot, 'proj-b', 'lane-b-work.txt')) &&
      !existsSync(join(clone, 'lane-b-work.txt'))
  )
}

const outside = await sendHandoff(
  { ...sender, list: () => [{ id: 's9', title: 'sys', cwd: '/etc', agent: 'claude', status: 'idle', lastOutput: 0, createdAt: 0 }], snapshot: () => [{ cwd: '/etc', agent: 'claude', scrollbackId: 's9' }] },
  'pc'
)
ok('a folder outside the projects root fails its own pane', outside[0]?.ok === false)

// What the person is TOLD, which until now had no test at all and was a chain of
// `bad.length === 0` branches - so one refusal silenced both the pane that moved and the
// pane still waiting for its turn to end.
console.log('what it says afterwards')
{
  const item = (id, state, error) => ({
    id,
    title: id,
    ok: state === 'ok',
    pending: state === 'queued' || undefined,
    error,
    notes: []
  })
  const mixed = handoffReport(
    [item('A', 'ok'), item('B', 'queued'), item('C', 'bad', 'Repo has no origin remote')],
    'DESKTOP-CMSUCM1'
  )
  ok('a mixed handoff names the pane that moved', /Moved 1 pane/.test(mixed), mixed)
  ok('...and the one still working', /1 still working/.test(mixed), mixed)
  ok('...and the one that refused, by name and reason', /C: Repo has no origin remote/.test(mixed), mixed)

  const oneQueued = handoffReport([item('A', 'queued')], 'PC', 'PaneForge')
  ok('one queued pane is never called moved', !/^Moved/.test(oneQueued) && /mid-turn/.test(oneQueued), oneQueued)
  const oneMoved = handoffReport([item('A', 'ok')], 'PC', 'PaneForge')
  ok('one moved pane says where it went', /Moved PaneForge to PC/.test(oneMoved), oneMoved)
  const oneOpened = handoffReport([{ ...item('A', 'ok'), sourceKept: true }], 'PC', 'PaneForge')
  ok('a preserved-source agent handoff says opened, not moved', /Opened PaneForge on PC/.test(oneOpened) && !/Moved PaneForge/.test(oneOpened), oneOpened)
  const nothing = handoffReport([], 'PC')
  ok('nothing to move says so rather than claiming a move', /already closed/.test(nothing), nothing)
  const failed = handoffReport([item('A', 'bad', 'Push failed')], 'PC', 'PaneForge')
  ok('a lone failure never claims a move', !/Moved/.test(failed) && /A: Push failed/.test(failed), failed)
}

client.disconnect()
host.stop()
rmSync(out, { recursive: true, force: true })

console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
