// `pf continue <chat-id> --prompt-file <file>` - GuardDeck's "next prompt" box (Robert,
// 2026-09-26). Runs the real pf-ctl.mjs against a fake phone server, so every path is the
// exact calls the app would receive:
//   - pane open with that conversation: the prompt is told to it, nothing is started
//   - pane asleep: woken, then told
//   - pane closed: reopened from History with resume AND resumeId, then told
//   - reopened into a copy of the folder: the Claude transcript goes with it, pane restarted
//   - conversation file gone (app opens it asleep): that pane is closed, nothing sent, exit 1
//   - unknown id, a chat on the other computer, a bad id, an empty file: exit 1, nothing sent
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
      for (const c of msg.calls) calls.push([c.channel, c.args])
      res.writeHead(200)
      return res.end('{}')
    }
    calls.push([msg.channel, msg.args])
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
const scenario = (panes, extra = {}) => {
  calls = []
  const desk = [...panes]
  app = (channel, args) => {
    if (extra[channel]) return extra[channel](args, desk)
    if (channel === 'sessions:list') return desk
    if (channel === 'history:list') return history
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
  ok(r.out === JSON.stringify({ paneId: 's2-b', number: 2, reopened: false }), 'open pane: JSON names the pane and its card number', r.out)
  ok(started().length === 0, 'open pane: no second pane is started')
  ok(told().length === 1 && told()[0][1][0] === 's2-b' && told()[0][1][1] === PROMPT, 'open pane: the whole prompt is told to that pane', JSON.stringify(told()))
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
  ok(r.out === JSON.stringify({ paneId: 's20-new', number: 2, reopened: true }), 'closed pane: JSON says reopened, with the new card number', r.out)
  const req = started()[0]?.[1]?.[0] ?? {}
  ok(req.resume === true && req.resumeId === CHAT, 'closed pane: started with BOTH resume and resumeId', JSON.stringify(req))
  ok(req.cwd === project && req.agent === 'claude' && req.model === 'claude-opus-5-5' && req.where === 'local', 'closed pane: the NEWEST History row for that chat, on this computer', JSON.stringify(req))
  ok(req.prompt === undefined, 'closed pane: the prompt is not also put on the start (no double delivery)')
  ok(told().length === 1 && told()[0][1][0] === 's20-new' && told()[0][1][1] === PROMPT, 'closed pane: prompt told to the reopened pane')
  ok(!calls.some(([c]) => c === 'sessions:restart'), 'closed pane: no restart when it landed in its own folder')
}

// ---- closed pane reopened in a copy of the folder: transcript follows, pane restarted ------
{
  const copy = join(work, 'proj-a')
  mkdirSync(copy, { recursive: true })
  scenario([], {
    'sessions:start': ([req], desk) => {
      const s = { id: 's21-copy', title: req.title, cwd: copy, status: 'starting', agent: req.agent }
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
  ok(/^sent to pane 1 \(s21-copy\) - reopened from History$/.test(r.out), 'copy: plain output names the card', r.out)
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

// ---- the rule on its own: a live pane beats History, History picks the newest row ---------
{
  const t = continueTarget(CHAT, [{ id: 's1', status: 'idle', resumeId: CHAT }], history)
  ok(t.action === 'tell' && t.pane.id === 's1', 'rule: a live pane beats History')
  const h = continueTarget(CHAT, [], history)
  ok(h.action === 'reopen' && h.entry.id === 's12-done', 'rule: newest History row for that chat', h.entry?.id)
  const shell = continueTarget('dddddddd-0000-0000-0000-000000000000', [], [{ id: 'sh', cwd: project, agent: 'shell', resumeId: 'dddddddd-0000-0000-0000-000000000000', startedAt: 1 }])
  ok(Boolean(shell.error), 'rule: a shell pane is never a conversation to continue')
}

server.close()
rmSync(work, { recursive: true, force: true })
console.log(`pf continue: ${pass} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
