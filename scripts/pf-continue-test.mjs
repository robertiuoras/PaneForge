// `pf continue <chat-id> --prompt-file <file>` - GuardDeck's "next prompt" box (Robert,
// 2026-09-26). Runs the real pf-ctl.mjs against a fake phone server, so every path is the
// exact calls the app would receive:
//   - pane open with that conversation: the prompt is told to it, nothing is started
//   - pane asleep: woken, then told
//   - pane closed: reopened from History with resume AND resumeId, then told
//   - reopened into a copy of the folder: the Claude transcript goes with it, pane restarted
//   - conversation file gone (app opens it asleep): that pane is closed, nothing sent, exit 1
//   - unknown id, a chat on the other computer, a bad id, an empty file: exit 1, nothing sent
//   - the prompt goes through the answered `pane:tell` call; pf prints the app's own line and
//     exits 1 when the app says the prompt was not sent
// and `pf tell` / `pf type`, which share that answered call: delivered/queued exit 0,
// failed/missing exit 1, an older app says it gives no receipt, a Codex pane is typed
// through the receipt path, any other agent is typed raw and says nothing confirms it.
//
//   node scripts/pf-continue-test.mjs
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { continueTarget } from './pf-ctl-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-continue-'))
let pass = 0
let failed = 0
const ok = (cond, what, detail) => {
  if (cond) pass++
  else {
    failed++
    console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
  }
}

const CHAT = '6f1c2a4e-0b3d-4c5e-9f70-1a2b3c4d5e6f'
const project = join(work, 'proj')
mkdirSync(project, { recursive: true })
const projectDir = (cwd) => join(work, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
mkdirSync(projectDir(project), { recursive: true })
writeFileSync(join(projectDir(project), `${CHAT}.jsonl`), '{"type":"user"}\n')

// The app, as far as pf can see it: one scenario at a time.
let app = null
let calls = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const msg = body ? JSON.parse(body) : {}
    if (req.url === '/pf/pair') {
      res.writeHead(200, { 'set-cookie': 'pf=1; Path=/' })
      return res.end('{}')
    }
    if (req.url === '/pf/send') {
      for (const c of msg.calls) calls.push([c.channel, c.args, 'send'])
      res.writeHead(200)
      return res.end('{}')
    }
    calls.push([msg.channel, msg.args, 'call'])
    let value
    try {
      value = app(msg.channel, msg.args)
    } catch (e) {
      res.writeHead(200)
      return res.end(JSON.stringify({ error: e.message }))
    }
    res.writeHead(200)
    res.end(JSON.stringify({ value }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const userData = join(work, 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ phone: { port, code: 'x' } }))

const pf = (args) =>
  new Promise((r) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'pf-ctl.mjs'), ...args], {
      env: { ...process.env, PF_USER_DATA: userData, HOME: work, USERPROFILE: work, PF_PANE: '' }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => r({ code, out: out.trim(), err: err.trim() }))
  })

const promptFile = join(work, 'next.txt')
const PROMPT = 'Now add the tests.\nThen commit.'
writeFileSync(promptFile, PROMPT + '\n')
const told = () => calls.filter(([c]) => c === 'pane:tell')
const started = () => calls.filter(([c]) => c === 'sessions:start')
const history = [
  { id: 's9-old', title: 'Older run', cwd: '/elsewhere', agent: 'claude', startedAt: 1, endedAt: 2, resumeId: CHAT },
  { id: 's12-done', title: 'Fix the footer', cwd: project, agent: 'claude', model: 'claude-opus-5-5', startedAt: 10, endedAt: 20, resumeId: CHAT },
  { id: 's13-other', title: 'Other chat', cwd: project, agent: 'claude', startedAt: 30, endedAt: 40, resumeId: 'aaaaaaaa-0000-0000-0000-000000000000' }
]
// What the app answers `pane:tell` with: an outcome plus the line `tellLine` made of it. The
// line is a marker here so a check can see pf printed the APP's words, not its own.
const answer = (kind, id) =>
  kind === 'missing' ? { kind, ref: id, line: `LINE missing ${id}` } : { kind, id, title: 'Fix the footer', reason: 'r', line: `LINE ${kind} ${id}` }
let tellKind = 'queued'
const scenario = (panes, extra = {}) => {
  calls = []
  tellKind = 'queued'
  const desk = [...panes]
  app = (channel, args) => {
    if (extra[channel]) return extra[channel](args, desk)
    if (channel === 'sessions:list') return desk
    if (channel === 'history:list') return history
    if (channel === 'pane:tell') return answer(tellKind, args[0])
    throw new Error(`unknown channel ${channel}`)
  }
  return desk
}

// ---- open pane: told between its turns, nothing started ---------------------------------
{
  scenario([
    { id: 's1-a', title: 'Other', status: 'idle', resumeId: 'bbbbbbbb-0000-0000-0000-000000000000' },
    { id: 's2-b', title: 'Fix the footer', status: 'working', resumeId: CHAT }
  ])
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 0, 'open pane: exit 0', r.err)
  ok(r.out === JSON.stringify({ paneId: 's2-b', number: 2, reopened: false, outcome: 'queued', line: 'LINE queued s2-b' }), 'open pane: JSON names the pane, its card number and what happened to the prompt', r.out)
  ok(told().every(([, , via]) => via === 'call'), 'open pane: told through the answered call, not the silent send', JSON.stringify(told()))
  ok(started().length === 0, 'open pane: no second pane is started')
  ok(told().length === 1 && told()[0][1][0] === 's2-b' && told()[0][1][1] === PROMPT, 'open pane: the whole prompt is told to that pane', JSON.stringify(told()))
}

// Duplicate native owners must not receive an arbitrary continuation.
{
  scenario([
    { id: 's70-original', status: 'working', resumeId: CHAT },
    { id: 's78-duplicate', status: 'idle', resumeId: CHAT }
  ])
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 1 && /multiple running panes/.test(r.err), 'duplicate native owners: refused', r.err)
  ok(told().length === 0 && started().length === 0, 'duplicate native owners: no prompt or third process')
}

// ---- asleep pane: woken, then told -------------------------------------------------------
{
  scenario([{ id: 's3-c', title: 'Fix the footer', status: 'exited', asleep: 123, resumeId: CHAT }], {
    'sessions:wake': ([id]) => ({ id, status: 'starting', resumeId: CHAT })
  })
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 0, 'asleep pane: exit 0', r.err)
  const order = calls.map(([c]) => c).filter((c) => c === 'sessions:wake' || c === 'pane:tell')
  ok(order.join(',') === 'sessions:wake,pane:tell', 'asleep pane: woken before it is told', order.join(','))
  ok(JSON.parse(r.out || '{}').reopened === false, 'asleep pane: not reported as reopened')

  // ...unless waking could not resume it: the pane is in a NEW chat, and the prompt was not
  // written for that one.
  scenario([{ id: 's3-c', title: 'Fix the footer', status: 'exited', asleep: 123, resumeId: CHAT }], {
    'sessions:wake': ([id]) => ({ id, status: 'starting' })
  })
  const f = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(f.code === 1 && /new chat/.test(f.err) && told().length === 0, 'asleep pane that wakes into a new chat: refused, nothing told', f.err)
}

// ---- closed pane: reopened from History with its conversation, then told ------------------
{
  scenario([{ id: 's1-a', title: 'Other', status: 'idle' }], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's20-new', title: req.title, cwd: req.cwd, status: 'starting', agent: req.agent, resumeId: req.resumeId }
      desk.push(s)
      return { ...s, startAction: 'open' }
    }
  })
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 0, 'closed pane: exit 0', r.err)
  ok(r.out === JSON.stringify({ paneId: 's20-new', number: 2, reopened: true, outcome: 'queued', line: 'LINE queued s20-new' }), 'closed pane: JSON says reopened, with the new card number', r.out)
  const req = started()[0]?.[1]?.[0] ?? {}
  ok(req.resume === true && req.resumeId === CHAT, 'closed pane: started with BOTH resume and resumeId', JSON.stringify(req))
  ok(req.cwd === project && req.agent === 'claude' && req.model === 'claude-opus-5-5' && req.where === 'local', 'closed pane: the NEWEST History row for that chat, on this computer', JSON.stringify(req))
  ok(req.prompt === undefined, 'closed pane: the prompt is not also put on the start (no double delivery)')
  ok(told().length === 1 && told()[0][1][0] === 's20-new' && told()[0][1][1] === PROMPT, 'closed pane: prompt told to the reopened pane')
  ok(!calls.some(([c]) => c === 'sessions:restart'), 'closed pane: no restart when it landed in its own folder')
}

// ---- a chat that closed ITSELF (claude-config autoclose.mjs, review `autoclose_*`) --------
// Its GuardDeck notice names the pane it was in and the conversation; the pane is gone and
// History holds the row `closeAfterResult` left. GuardDeck runs `pf continue <resumeId>`
// straight off the notice, and the same conversation comes back.
{
  const AUTO = '7a2d3b5f-1c4e-4d6f-8a81-2b3c4d5e6f70'
  writeFileSync(join(projectDir(project), `${AUTO}.jsonl`), '{"type":"user"}\n')
  const notice = { id: 'paneforge-review-autoclose_s14-auto_1790000000', actor: 'paneforge', result: { id: 'autoclose_s14-auto_1790000000', kind: 'result', sessionId: 's14-auto', resumeId: AUTO, cwd: project, agent: 'claude', machine: 'mac', paneNumber: 4, app: 'paneforge' } }
  history.push({ id: 's14-auto', title: 'Autoclosed chat', cwd: project, agent: 'claude', model: 'claude-opus-5-5', startedAt: 50, endedAt: 60, resumeId: AUTO })
  scenario([{ id: 's1-a', title: 'Other', status: 'idle' }], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's23-back', title: req.title, cwd: req.cwd, status: 'starting', agent: req.agent, resumeId: req.resumeId }
      desk.push(s)
      return s
    }
  })
  const r = await pf(['continue', notice.result.resumeId, '--prompt-file', promptFile, '--json'])
  ok(r.code === 0, 'autoclosed chat: exit 0', r.err)
  ok(r.out === JSON.stringify({ paneId: 's23-back', number: 2, reopened: true, outcome: 'queued', line: 'LINE queued s23-back' }), 'autoclosed chat: reopened, with its new card number', r.out)
  const req = started()[0]?.[1]?.[0] ?? {}
  ok(req.resume === true && req.resumeId === AUTO && req.cwd === project && req.title === 'Autoclosed chat', 'autoclosed chat: its own conversation, in its own folder', JSON.stringify(req))
  ok(told().length === 1 && told()[0][1][0] === 's23-back' && told()[0][1][1] === PROMPT, 'autoclosed chat: the prompt reaches it')
  history.pop()
}

// ---- closed pane reopened in a copy of the folder: transcript follows, pane restarted ------
{
  const copy = join(work, 'proj-a')
  mkdirSync(copy, { recursive: true })
  scenario([], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's21-copy', title: req.title, cwd: copy, status: 'starting', agent: req.agent, resumeId: req.resumeId }
      desk.push(s)
      return s
    },
    'sessions:restart': ([id]) => ({ id })
  })
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile])
  ok(r.code === 0, 'copy: exit 0', r.err)
  ok(existsSync(join(projectDir(copy), `${CHAT}.jsonl`)), 'copy: the conversation file is placed where that pane reads it')
  const order = calls.map(([c]) => c).filter((c) => c === 'sessions:restart' || c === 'pane:tell')
  ok(order.join(',') === 'sessions:restart,pane:tell', 'copy: restarted before it is told', order.join(','))
  ok(r.out === 'LINE queued s21-copy (card 1, reopened from History first)', "copy: plain output is the app's line, naming the card", r.out)
}

// ---- conversation file gone: the app opens it asleep; that pane goes, nothing is sent -------
{
  scenario([], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's22-lost', title: req.title, cwd: req.cwd, status: 'exited', asleep: 1, laneNote: 'Saved conversation could not be verified.' }
      desk.push(s)
      return s
    },
    'sessions:kill': ([id], desk) => desk.splice(desk.findIndex((x) => x.id === id), 1) && null
  })
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 1, 'lost file: exit 1', `exit ${r.code}`)
  ok(/no longer on this computer/.test(r.err) && /nothing was sent/.test(r.err), 'lost file: one plain line says so', r.err)
  ok(calls.some(([c, a]) => c === 'sessions:kill' && a[0] === 's22-lost'), 'lost file: the empty pane it made is closed')
  ok(told().length === 0 && r.out === '', 'lost file: nothing told, nothing on stdout')
}

// ---- a start with a different or missing conversation is kept and never told -----------------
for (const returnedResumeId of ['bbbbbbbb-0000-0000-0000-000000000000', undefined]) {
  scenario([], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's24-wrong', title: req.title, cwd: req.cwd, status: 'starting', agent: req.agent, resumeId: returnedResumeId }
      desk.push(s)
      return s
    }
  })
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 1 && /different conversation/.test(r.err) && /pane was kept/.test(r.err), 'wrong resumed chat: refused with the pane preserved', r.err)
  ok(told().length === 0, 'wrong resumed chat: the GuardDeck prompt is never sent to it')
  ok(!calls.some(([c]) => c === 'sessions:kill'), 'wrong resumed chat: the unexpected pane is kept for inspection')
}

// ---- refusals: nothing started, nothing told ------------------------------------------------
{
  scenario([{ id: 's1-a', title: 'Other', status: 'idle' }])
  const r = await pf(['continue', 'cccccccc-0000-0000-0000-000000000000', '--prompt-file', promptFile, '--json'])
  ok(r.code === 1 && /no chat .* on this computer/.test(r.err), 'unknown id: exit 1 with a plain reason', `${r.code} ${r.err}`)
  ok(started().length === 0 && told().length === 0, 'unknown id: never falls back to the newest chat')

  scenario([{ id: '@pc/s4', title: 'Fix the footer', status: 'idle', resumeId: CHAT }])
  const m = await pf(['continue', CHAT, '--prompt-file', promptFile])
  ok(m.code === 1 && /another computer/.test(m.err) && told().length === 0 && started().length === 0, 'chat open on the other computer: refused, not reopened here', m.err)

  scenario([{ id: 's5-e', title: 'Fix the footer', status: 'exited', resumeId: CHAT }])
  const d = await pf(['continue', CHAT, '--prompt-file', promptFile])
  ok(d.code === 1 && /Restart/.test(d.err) && told().length === 0 && started().length === 0, 'pane whose agent stopped: refused, no second pane', d.err)

  calls = []
  const empty = join(work, 'empty.txt')
  writeFileSync(empty, '  \n')
  const e = await pf(['continue', CHAT, '--prompt-file', empty])
  ok(e.code === 1 && /empty/.test(e.err) && calls.length === 0, 'empty prompt file: refused before the app is asked', e.err)
  const b = await pf(['continue', '3', '--prompt-file', promptFile])
  ok(b.code === 1 && /not a chat id/.test(b.err) && calls.length === 0, 'a pane number is not a chat id', b.err)
  const n = await pf(['continue', CHAT])
  ok(n.code === 1 && /--prompt-file/.test(n.err) && calls.length === 0, 'no prompt file: refused', n.err)
  const x = await pf(['continue', CHAT, '--prompt-file', join(work, 'missing.txt')])
  ok(x.code === 1 && /could not read/.test(x.err) && calls.length === 0, 'missing prompt file: refused', x.err)
}

// ---- the app says the prompt was NOT sent: exit 1 with its line, no "sent" --------------------
{
  scenario([{ id: 's2-b', title: 'Fix the footer', status: 'working', resumeId: CHAT }])
  tellKind = 'failed'
  const r = await pf(['continue', CHAT, '--prompt-file', promptFile, '--json'])
  ok(r.code === 1 && /LINE failed s2-b/.test(r.err) && r.out === '', 'continue, prompt refused by the pane: exit 1 with the app line, nothing on stdout', `${r.code} ${r.out} ${r.err}`)
}

// ---- pf tell: the app's answer is what is printed ------------------------------------------
{
  const desk = [
    { id: 's2-b', title: 'Fix the footer', status: 'working', agent: 'claude' },
    { id: '@HOSTID/s42-mus4a344', title: 'Blender film', status: 'working', agent: 'codex', remote: { id: 'HOSTID', name: 'Desk PC' } }
  ]
  for (const [kind, code] of [['delivered', 0], ['queued', 0], ['failed', 1], ['missing', 1]]) {
    scenario(desk)
    tellKind = kind
    const r = await pf(['tell', 's2-b', 'check', 'the', 'build'])
    const said = code === 0 ? r.out : r.err
    ok(r.code === code, `tell ${kind}: exit ${code}`, `exit ${r.code} ${r.err}`)
    ok(said.includes(`LINE ${kind} s2-b`), `tell ${kind}: prints the app's own line`, `${r.out} | ${r.err}`)
    ok(kind === 'delivered' || !/\btold\b/.test(r.out + r.err), `tell ${kind}: never says "told"`, r.out + r.err)
    ok(told().length === 1 && told()[0][2] === 'call' && told()[0][1][1] === 'check the build', `tell ${kind}: one answered call with the whole line`, JSON.stringify(told()))
  }
  // A pane on the other computer is handed to the app under its full id; the app routes it.
  scenario(desk)
  const far = await pf(['tell', '@HOSTID/s42-mus4a344', 'still there?'])
  ok(far.code === 0 && far.out === 'LINE queued @HOSTID/s42-mus4a344', 'tell to another computer: the full id goes to the app and its line is printed', `${far.code} ${far.out} ${far.err}`)
  ok(told()[0]?.[1]?.[0] === '@HOSTID/s42-mus4a344', 'tell to another computer: the device stays on the id', JSON.stringify(told()))
  // An app from before the answer: the line still goes, and pf says nothing confirms it.
  scenario(desk, { 'pane:tell': () => { throw new Error('unknown channel pane:tell') } })
  const old = await pf(['tell', 's2-b', 'check the build'])
  ok(old.code === 0 && /no receipt/.test(old.out) && !/\btold\b/.test(old.out), 'tell, older app: handed over and says no receipt exists', `${old.code} ${old.out} ${old.err}`)
  ok(told().filter(([, , via]) => via === 'send').length === 1, 'tell, older app: the old fire-and-forget send carries it', JSON.stringify(told()))
}

// ---- pf type: Codex goes through the receipt path, others are typed raw --------------------
{
  const desk = [
    { id: 's2-b', title: 'Fix the footer', status: 'idle', agent: 'claude' },
    { id: 's4-x', title: 'Codex work', status: 'working', agent: 'codex' },
    { id: '@HOSTID/s42-mus4a344', title: 'Blender film', status: 'working', agent: 'codex', remote: { id: 'HOSTID', name: 'Desk PC' } }
  ]
  const writes = () => calls.filter(([c]) => c === 'pty:write')
  const long = 'x'.repeat(1463)
  for (const id of ['s4-x', '@HOSTID/s42-mus4a344']) {
    scenario(desk)
    tellKind = 'delivered'
    const r = await pf(['type', id, long])
    ok(r.code === 0 && r.out === `LINE delivered ${id}`, `type into a Codex pane (${id}): the receipt line is printed`, `${r.code} ${r.out} ${r.err}`)
    ok(told().length === 1 && told()[0][1][0] === id && told()[0][1][1] === long && writes().length === 0, `type into a Codex pane (${id}): sent through tell, never raw text plus Return`, JSON.stringify(calls.map(([c, a]) => [c, a[0]])))
  }
  scenario(desk)
  tellKind = 'failed'
  const bad = await pf(['type', 's4-x', 'hello'])
  ok(bad.code === 1 && /LINE failed s4-x/.test(bad.err), 'type into a Codex pane that refuses: exit 1 with the reason', `${bad.code} ${bad.err}`)
  scenario(desk)
  const raw = await pf(['type', 's2-b', 'hello there'])
  ok(raw.code === 0 && writes().map(([, a]) => a[1]).join('|') === 'hello there|\r', 'type into a Claude pane: text, then Return as its own write', JSON.stringify(writes()))
  ok(told().length === 0, 'type into a Claude pane: not routed through tell', JSON.stringify(told()))
  ok(/s2-b \(Fix the footer\)/.test(raw.out) && /no receipt/.test(raw.out) && !/\btold\b/.test(raw.out), 'type into a Claude pane: names the pane and says nothing confirms it', raw.out)
}

// ---- pf tell / pf type to a chat `pf list` shows from the other computer, not mirrored here --
// `pf list` prints `@HOSTID/s6-x` in column 2 for a chat that runs over there and is not
// mirrored on this desk, and `pf help tell` says to use that id. It was looked up only in
// this desk's own list, so the id pf itself printed answered "no pane named".
{
  const desk = [{ id: 's2-b', title: 'Fix the footer', status: 'idle', agent: 'claude' }]
  const state = () => ({
    peers: [{
      id: 'HOSTID', name: 'Desk PC', status: 'online', panes: [
        { id: 's6-x', title: 'Render queue', status: 'working', agent: 'codex', number: 6, machine: 'pc', watched: false },
        { id: 's7-y', title: 'Notes', status: 'idle', agent: 'claude', number: 7, machine: 'pc', watched: false }
      ]
    }]
  })
  const writes = () => calls.filter(([c]) => c === 'pty:write')
  scenario(desk, { 'remote:state': state })
  const t = await pf(['tell', '@HOSTID/s6-x', 'keep', 'going'])
  ok(t.code === 0 && t.out === 'LINE queued @HOSTID/s6-x', 'tell to a listed chat on another computer: its @ id from pf list is found and told', `${t.code} ${t.out} ${t.err}`)
  ok(told().length === 1 && told()[0][1][0] === '@HOSTID/s6-x' && told()[0][1][1] === 'keep going' && told()[0][2] === 'call',
    'tell to a listed chat: one answered call under the full @ id', JSON.stringify(told()))
  scenario(desk, { 'remote:state': state })
  tellKind = 'delivered'
  const ty = await pf(['type', '@HOSTID/s6-x', 'x'.repeat(1463)])
  ok(ty.code === 0 && ty.out === 'LINE delivered @HOSTID/s6-x' && told().length === 1 && told()[0][1][0] === '@HOSTID/s6-x' && writes().length === 0,
    'type into a listed Codex chat on another computer: sent through tell, never raw text plus Return', `${ty.code} ${ty.out} ${ty.err} ${JSON.stringify(calls.map(([c, a]) => [c, a[0]]))}`)
  scenario(desk, { 'remote:state': state })
  const tc = await pf(['type', '@HOSTID/s7-y', 'hello there'])
  ok(tc.code === 0 && writes().map(([, a]) => `${a[0]}:${a[1]}`).join('|') === '@HOSTID/s7-y:hello there|@HOSTID/s7-y:\r' && told().length === 0,
    'type into a listed Claude chat on another computer: typed the same way as a mirrored one', `${tc.code} ${tc.out} ${tc.err} ${JSON.stringify(writes())}`)
  scenario(desk, { 'remote:state': state })
  const none = await pf(['tell', '@HOSTID/s99-gone', 'hello'])
  ok(none.code === 1 && /no pane named "@HOSTID\/s99-gone"/.test(none.err) && told().length === 0,
    'tell to an @ id nobody lists: still no pane, nothing sent', `${none.code} ${none.err}`)
}

// ---- the rule on its own: a live pane beats History, History picks the newest row ---------
{
  const t = continueTarget(CHAT, [{ id: 's1', status: 'idle', resumeId: CHAT }], history)
  ok(t.action === 'tell' && t.pane.id === 's1', 'rule: a live pane beats History')
  const h = continueTarget(CHAT, [], history)
  ok(h.action === 'reopen' && h.entry.id === 's12-done', 'rule: newest History row for that chat', h.entry?.id)
  const shell = continueTarget('dddddddd-0000-0000-0000-000000000000', [], [{ id: 'sh', cwd: project, agent: 'shell', resumeId: 'dddddddd-0000-0000-0000-000000000000', startedAt: 1 }])
  ok(Boolean(shell.error), 'rule: a shell pane is never a conversation to continue')
}

// A pane still in its FIRST turn has no `resumeId` yet but lists the conversation it is on.
{
  const first = continueTarget(CHAT, [{ id: 's9', status: 'working', conversationId: CHAT }], [])
  ok(first.action === 'tell' && first.pane.id === 's9', 'rule: a first-turn pane (conversationId, no resumeId) is told', JSON.stringify(first))
  const other = continueTarget(CHAT, [{ id: 's9', status: 'idle', resumeId: 'eeeeeeee-0000-0000-0000-000000000000', conversationId: CHAT }], [])
  ok(Boolean(other.error), 'rule: a pane whose resumeId names another chat is not matched by conversationId', JSON.stringify(other))
}

server.close()
rmSync(work, { recursive: true, force: true })
console.log(`pf continue: ${pass} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
