// A new session that does not open must say so, wherever it was asked for.
//
// 2026-10-01: `pf open <folder> --on <PC>` was refused five times in eight minutes with
// "e38080cc645760c5 does not have this project" for research-lab, clients and claude-memory,
// all on the PC's disk. The PC had taken 10-15 s to send its project list against a 15 s
// limit, the failed ask became an empty list, and the empty list became "does not have".
// None of it reached the app's window. And a client row in the New session dialog that went
// to the chat already open for that client closed the dialog and said nothing at all.
//
// This pins: the refusal tells "did not answer" from "does not have" and names the device
// by its name; a recent list answers yes without the wait; every failure has a log line and
// (when the window did not ask) a toast; `pf open` exits 1 with the reason.
//
//   node scripts/open-failed-test.mjs

import { buildSync } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-open-failed-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'offloadfirst.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/offloadFirst.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const require = createRequire(import.meta.url)
const { placeNewPane, knownToHave, openFailure, openFailedLine, reusedLine, PROJECTS_FRESH_MS } = require(out)

let checks = 0
let failed = 0
const ok = (cond, what) => {
  checks++
  if (!cond) {
    failed++
    console.error(`  FAIL ${what}`)
  }
}

const at = (over) => ({
  shareable: true,
  prompt: 'run the research sweep',
  cwd: '/Users/robert/Projects/research-lab',
  peerAlive: false,
  mode: 'auto',
  ...over
})

// --- the 2026-10-01 refusal: the list did not arrive, so "does not have" is not known --------
{
  const p = placeNewPane(at({
    device: 'e38080cc645760c5', deviceName: 'DESKTOP-CMSUCM1', deviceOnline: true,
    deviceHasProject: false, deviceUnanswered: 'DESKTOP-CMSUCM1 did not answer'
  }))
  ok(typeof p.refused === 'string', 'an unanswered list still refuses (never guesses the device has it)')
  ok(!/does not have this project/.test(p.refused), `an unanswered list is not "does not have": ${p.refused}`)
  ok(/did not say which projects it has/.test(p.refused), 'says the device did not answer')
  ok(p.refused.includes('DESKTOP-CMSUCM1') && !p.refused.includes('e38080cc645760c5'), 'names the device by its name, not its id')
  ok(/try again/i.test(p.refused) && /this machine/.test(p.refused), 'says what to do')
}
// --- a list that arrived and lacks it: the old sentence, with the name ---------------------
{
  const p = placeNewPane(at({ device: 'e38080cc645760c5', deviceName: 'DESKTOP-CMSUCM1', deviceOnline: true, deviceHasProject: false }))
  ok(p.refused === 'DESKTOP-CMSUCM1 does not have this project', `measured absence keeps its sentence: ${p.refused}`)
}
// --- an older list that names it is still good enough to try (the far end refuses in words) --
{
  const p = placeNewPane(at({ device: 'e38080cc645760c5', deviceName: 'DESKTOP-CMSUCM1', deviceOnline: true, deviceHasProject: true, deviceUnanswered: 'timed out' }))
  ok(p.where === 'remote' && !p.refused, 'a remembered list that has the project goes ahead')
}
// --- the id still works when no name is known -----------------------------------------------
{
  const p = placeNewPane(at({ device: 'The PC', deviceOnline: false }))
  ok(p.refused === 'The PC is not online', 'offline refusal unchanged')
}

// --- knownToHave: answers YES only, only while fresh, case-folded ---------------------------
{
  const now = 1_000_000_000
  const known = { list: [{ name: 'Research-Lab', path: 'C:\\P\\research-lab' }], at: now - 60_000 }
  ok(knownToHave(known, 'research-lab', now) === true, 'a fresh list that names it answers yes')
  ok(knownToHave(known, 'clients', now) === false, 'a fresh list that lacks it asks again')
  ok(knownToHave({ ...known, at: now - PROJECTS_FRESH_MS - 1 }, 'research-lab', now) === false, 'a stale list asks again')
  ok(knownToHave(undefined, 'research-lab', now) === false, 'no list asks')
  ok(knownToHave(known, '', now) === false, 'no project name asks')
}

// --- every failure: a log line always, a toast unless the window asked ----------------------
{
  const f = openFailure({ cwd: '/Users/robert/Projects/research-lab', device: 'e38080cc645760c5' }, new Error('Error: DESKTOP-CMSUCM1 does not have this project'), false)
  ok(f.why === 'DESKTOP-CMSUCM1 does not have this project', `why strips the Error: prefix: ${f.why}`)
  ok(f.log.event === 'failed' && f.log.project === 'research-lab' && f.log.why === f.why && f.log.via === 'api', 'log line names event, project, reason, caller')
  ok(f.toast === 'No new session opened for research-lab: DESKTOP-CMSUCM1 does not have this project.', `toast for pf/agent/phone: ${f.toast}`)
  const w = openFailure({ cwd: '/x/clients' }, new Error('all lanes busy'), true)
  ok(w.toast === undefined && w.log.via === 'window', 'the window shows its own toast from the row, so none twice')
  const blank = openFailure({ cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\clients' }, undefined, false)
  ok(blank.why === 'it would not open' && blank.toast.includes('for clients'), 'no message still says something, Windows path names the project')
  const plain = openFailure({ cwd: '/x/y' }, { message: 'a plain object from the link' }, false)
  ok(plain.why === 'a plain object from the link', 'an error that is not an Error instance keeps its words')
  ok(openFailedLine('', 'gate said no.') === 'No new session opened: gate said no.', 'no double full stop, no empty "for"')
}

// --- the silent press: a client row that went to the open chat ------------------------------
{
  ok(reusedLine('PIA Team | clients').startsWith('PIA Team | clients already has a chat open'), 'reuse names the client')
  ok(/instead of a second one/.test(reusedLine('x')), 'reuse says why no new one opened')
}

// --- wiring: the code paths that used to be silent now go through the above ------------------
{
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  ok(!/projectsOn\(p\.id\)\.catch\(\(\) => \[\]/.test(main), 'placement no longer turns a failed ask into an empty list')
  ok(/projectsFor\(p\.id, project\)/.test(main), 'placement asks through the remembered-list helper')
  ok(/deviceUnanswered,\s*\n/.test(main) && /deviceName,\s*\n/.test(main), 'placement passes the unanswered reason and the name')
  const startHandler = main.slice(main.indexOf("ipcMain.handle('sessions:start',"), main.indexOf("ipcMain.handle('sessions:startMany',"))
  ok(/reportOpenFailed\(req, e,/.test(startHandler), 'sessions:start reports its failure')
  const manyHandler = main.slice(main.indexOf("ipcMain.handle('sessions:startMany',"), main.indexOf("ipcMain.handle('sessions:restart',"))
  ok(/reportOpenFailed\(r, e, fromWindow\)/.test(manyHandler), 'sessions:startMany reports each failed row')
  const reporter = main.slice(main.indexOf('function reportOpenFailed'), main.indexOf('async function startOrSend'))
  ok(/logOffload\(failure\.log\)/.test(reporter) && /send\('handoff:moved', failure\.toast\)/.test(reporter), 'the reporter logs and toasts')
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok(/startAction === 'send'/.test(app) && /flash\(reusedLine\(/.test(app), 'the dialog says when a client press went to the open chat')
  const client = readFileSync(join(root, 'src/main/remote/client.ts'), 'utf8')
  ok(/ask<Project\[\]>\(\{ t: 'projects' \}, 30_000\)/.test(client), 'the project list gets 30 s, past the measured 15.6 s')
}

// --- pf open: the refusal is printed and the exit code is 1 ---------------------------------
async function fakeApp(answer) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/pf/pair') {
        res.writeHead(200, { 'set-cookie': 'pf=ok; Path=/' })
        return res.end('{}')
      }
      const { channel, args } = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer(channel, args)))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'pf-open-failed-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ phone: { port: server.address().port, code: 'x' } }))
  return { dir, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) }
}
function pf(dir, ...args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, 'scripts/pf-ctl.mjs'), ...args], { env: { ...process.env, PF_USER_DATA: dir, PF_PANE: '' } })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('close', (code) => done({ code, text: text.trim() }))
  })
}
{
  const why = 'DESKTOP-CMSUCM1 did not say which projects it has (DESKTOP-CMSUCM1 did not answer), so nothing was opened there. Try again in a minute, or open it on this machine'
  const app = await fakeApp((channel) => (channel === 'sessions:start' ? { error: why } : { value: null }))
  try {
    const r = await pf(app.dir, 'open', '/Users/robert/Projects/research-lab', '--on', 'e38080cc645760c5')
    ok(r.code === 1, `pf open exits 1 on a refusal (got ${r.code})`)
    ok(r.text.includes(why), `pf open prints the reason: ${r.text}`)
    ok(!/^opened /m.test(r.text), 'pf open does not claim a pane opened')
  } finally {
    app.close()
  }
}
{
  const plan = join(work, 'plan.json')
  writeFileSync(plan, JSON.stringify([{ cwd: '/Users/robert/Projects/clients', on: 'e38080cc645760c5' }]))
  const app = await fakeApp((channel) =>
    channel === 'sessions:startMany' ? { value: [{ cwd: '/Users/robert/Projects/clients', why: 'DESKTOP-CMSUCM1 does not have this project' }] } : { value: null })
  try {
    const r = await pf(app.dir, 'open-many', plan)
    ok(r.code === 1, `pf open-many exits 1 when a row did not open (got ${r.code})`)
    ok(/does not have this project/.test(r.text), 'pf open-many prints the row reason')
  } finally {
    app.close()
  }
}

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`open-failed: ${failed} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`open-failed: ${checks} checks passed`)
