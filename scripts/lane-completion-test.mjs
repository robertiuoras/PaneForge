// Real Git regressions for verified completion of preserved orphan work.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'pf-completion-'))
let failures = 0
const check = (name, pass, detail = '') => { console.log(`${pass ? 'ok' : 'FAIL'} ${name}`); if (!pass) { failures++; console.log(detail) } }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }))
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'tag', 'v0.0.1')
  const remote = join(root, `${name}-origin.git`)
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'master', '--tags')
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const beatDir = join(repo, '.git', 'paneforge-panes')
  mkdirSync(beatDir)
  const beat = join(beatDir, `pf-${process.pid}.json`)
  writeFileSync(beat, JSON.stringify({ at: Date.now(), chats: [] }))
  const panes = join(repo, '.git', 'panes.txt'); writeFileSync(panes, '')
  const log = join(repo, '.git', 'completion.jsonl')
  const processes = join(repo, '.git', 'processes.json'); writeFileSync(processes, '[]')
  const env = { ...process.env, LANE_PROCESSES_FILE: processes, PF_PANE: '', PF_CTL_NO_APP: '1', LANE_PANES_FILE: panes, LANE_COMPLETION_LOG: log, LANE_REGISTRY: join(repo, '.git', 'registry.json'), CLAUDE_CONFIG_DIR: join(root, 'claude') }
  const cli = join(repo, 'scripts', 'lane.mjs')
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90_000 })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const recoveryPath = join(repo, '.git', 'paneforge-recovery.json')
  const state = () => ({ ...JSON.parse(readFileSync(statePath, 'utf8')), recovery: existsSync(recoveryPath) ? JSON.parse(readFileSync(recoveryPath, 'utf8')) : { items: {} } })
  const patch = (fn) => {
    const s = state(); fn(s)
    const { recovery, ...ledger } = s
    writeFileSync(statePath, JSON.stringify(ledger))
    if (existsSync(recoveryPath)) writeFileSync(recoveryPath, JSON.stringify(recovery))
  }
  const claim = JSON.parse(run('claim', '--prefer', 'a', '--session', 'original').out)
  const dir = claim.dir
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  return { repo, remote, dir, cli, env, state, patch, run, beat, panes, processes, recoveryPath, requests }
}

const f = fixture('dirty')
writeFileSync(join(f.dir, 'source.txt'), 'staged intent\n'); git(f.dir, 'add', 'source.txt')
writeFileSync(join(f.dir, 'source.txt'), 'loose followup\n'); writeFileSync(join(f.dir, 'private.txt'), 'preserve me\n')
const before = { head: git(f.dir, 'rev-parse', 'HEAD'), index: git(f.dir, 'write-tree'), bytes: readFileSync(join(f.dir, 'source.txt'), 'utf8') }
check('gone owner is released without an unchecked ready mark', f.run('release', '--session', 'original', '--gone').code === 0 && !f.state().ready.a)
const together = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [f.cli, 'retry'], { cwd: f.repo, env: f.env, stdio: 'pipe' })
  let error = ''; child.stderr.on('data', (d) => { error += d }); child.on('exit', (code) => resolve({ code, error }))
})
const concurrent = await Promise.all([together(), together()])
check('both concurrent timer invocations return successfully', concurrent.every((r) => r.code === 0), JSON.stringify(concurrent))
f.run('retry')
check('repeated and concurrent clocks reserve exactly one completion pane', f.requests().length === 1, JSON.stringify(f.requests()))
check('dispatch preserves HEAD, staging, loose bytes and private file', before.head === git(f.dir, 'rev-parse', 'HEAD') && before.index === git(f.dir, 'write-tree') && before.bytes === readFileSync(join(f.dir, 'source.txt'), 'utf8') && readFileSync(join(f.dir, 'private.txt'), 'utf8') === 'preserve me\n')
const key = f.state().recovery.active
check('completion brief requires ownership, PC verification and remote inclusion', /heldBy/.test(f.requests()[0]?.prompt ?? '') && /PC checks/.test(f.requests()[0]?.prompt ?? '') && /remote inclusion/.test(f.requests()[0]?.prompt ?? ''))
// The completion pane is given nothing but the brief, so the positive steps below run its
// commands exactly as written: each `node "<lane.mjs>" ...` up to the punctuation that ends
// it, placeholders filled, from a folder outside any repo. 2026-10-01, pane 22: the brief put
// `--repo` first and every command in it answered `Unknown command "--repo"`.
const brief = (() => {
  const prompt = f.requests()[0]?.prompt ?? '', commands = []
  for (let at = prompt.indexOf('node "'); at >= 0; at = prompt.indexOf('node "', at + 1)) {
    const word = /\s*("(?:[^"\\]|\\.)*"|[^\s"]+)/y, argv = []
    word.lastIndex = at + 'node'.length
    for (let m; (m = word.exec(prompt)); ) {
      const last = !m[1].startsWith('"') && /[.;,]$/.test(m[1])
      const token = last ? m[1].slice(0, -1) : m[1]
      argv.push(token.startsWith('"') ? JSON.parse(token) : token)
      if (last) break
    }
    commands.push(argv)
  }
  return commands
})()
const briefed = (sub, disposition, fill = {}) => {
  const argv = brief.find((c) => c.includes(sub) && (!disposition || c.includes(disposition)))
  if (!argv) return { code: null, out: '', err: `no ${sub} ${disposition ?? ''} command in the brief` }
  const fills = { '<actual-native-id>': 'completion-owner', ...fill }
  const r = spawnSync(process.execPath, argv.map((a) => fills[a] ?? a), { cwd: root, env: f.env, encoding: 'utf8', timeout: 90_000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
check('every command in the brief names its subcommand first', brief.length === 5 && brief.every((c) => /lane\.mjs$/.test(c[0]) && /^[a-z]+$/.test(c[1]) && c.includes('--repo')), JSON.stringify(brief))
const got = briefed('claim')
check('actual completion owner receives the exact preserved lane', got.code === 0 && JSON.parse(got.out).lane === 'a', got.out + got.err)
check('claim alone cannot bypass the recovery binding/verification gate', f.run('ready', '--session', 'completion-owner', '--lane', 'a').code !== 0)
check('bind rejects a foreign owner', f.run('recover', '--key', key, '--session', 'intruder', '--disposition', 'begin').code !== 0)
const bound = briefed('recover', 'begin')
check('bind records actual held ownership', bound.code === 0, bound.err)
git(f.dir, 'add', 'source.txt', 'private.txt'); git(f.dir, 'commit', '-qm', 'reviewed fixture intent')
check('ready refuses recovered work before verification', f.run('ready', '--session', 'completion-owner', '--lane', 'a').code !== 0)
check('a ready flag alone is never a completion receipt', f.run('recover', '--key', key, '--session', 'completion-owner', '--disposition', 'complete').code !== 0)
const proof = join(f.repo, '.git', 'proof.json')
writeFileSync(proof, JSON.stringify({ commit: git(f.dir, 'rev-parse', 'HEAD'), checks: [{ command: 'failed check', exitCode: 1 }], review: { reviewer: 'independent', result: 'accepted' } }))
check('a failed check receipt cannot authorize ready', f.run('recover', '--key', key, '--session', 'completion-owner', '--disposition', 'verified', '--receipt', proof).code !== 0)
writeFileSync(proof, JSON.stringify({ commit: git(f.dir, 'rev-parse', 'HEAD'), checks: [{ command: 'fixture byte/index preservation assertions', exitCode: 0 }], review: { reviewer: 'independent fixture assertions', result: 'accepted' } }))
const verified = briefed('recover', 'verified', { '<json-file>': proof })
check('verification pins current owned commit with check/review receipt', verified.code === 0, verified.err)
const ready = briefed('ready', null, { '<owned-slot>': 'a' })
check('normal ready integrates verified work', ready.code === 0, ready.out + ready.err)
const complete = briefed('recover', 'complete')
check('completion requires and records actual remote inclusion', complete.code === 0 && f.state().recovery.items[key].remoteCommit === git(f.remote, 'rev-parse', 'master'), complete.err)

for (const kind of ['quiet-live', 'sleeping', 'unknown', 'empty-index', 'missing', 'foreign', 'clean-ahead', 'pane-subdir', 'process-subdir', 'problem-process', 'unknown-process']) {
  const x = fixture(kind)
  writeFileSync(join(x.dir, 'intent.txt'), kind); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  if (kind !== 'clean-ahead') writeFileSync(join(x.dir, 'intent.txt'), `${kind} followup`)
  x.patch((s) => { s.lanes.a.seen = Date.now() - 13 * 3600_000; if (kind === 'sleeping') s.lanes.a.asleep = Date.now(); if (!['quiet-live', 'sleeping'].includes(kind)) delete s.lanes.a })
  if (kind === 'quiet-live') writeFileSync(x.beat, JSON.stringify({ at: Date.now() - 24 * 3600_000, chats: ['original'] }))
  if (kind === 'unknown') writeFileSync(x.beat, 'invalid JSON')
  if (kind === 'empty-index') git(x.dir, 'read-tree', '--empty')
  if (kind === 'missing') rmSync(x.dir, { recursive: true, force: true })
  if (kind === 'foreign') { rmSync(x.dir, { recursive: true, force: true }); mkdirSync(x.dir); writeFileSync(join(x.dir, 'private.txt'), 'foreign preserved') }
  if (kind === 'pane-subdir') writeFileSync(x.panes, `1\tactive\tworking\ttitle\t${join(x.dir, 'src')}\n`)
  if (kind === 'process-subdir' || kind === 'problem-process') writeFileSync(x.processes, JSON.stringify([join(x.dir, 'src')]))
  if (kind === 'problem-process') git(x.dir, 'read-tree', '--empty')
  if (kind === 'unknown-process') writeFileSync(x.processes, 'invalid JSON')
  const r = x.run('retry')
  check(`${kind}: clock returns without unchecked readiness`, r.code === 0 && !x.state().ready.a, r.err)
  if (['quiet-live', 'sleeping', 'unknown', 'pane-subdir', 'process-subdir', 'problem-process', 'unknown-process'].includes(kind)) check(`${kind}: no takeover or pane dispatch`, x.requests().length === 0 && (!['quiet-live', 'sleeping'].includes(kind) || x.state().lanes.a?.session === 'original'))
  else check(`${kind}: preserved work gets one diagnostic/verification owner`, x.requests().length === 1, JSON.stringify(x.state()))
  if (kind === 'empty-index') check('empty index is flagged and never staged/reset by dispatch', git(x.dir, 'ls-files') === '' && /index is empty/.test(x.requests()[0]?.prompt ?? '') && readFileSync(join(x.dir, 'intent.txt'), 'utf8') === 'empty-index followup')
  if (kind === 'foreign') check('foreign user bytes remain untouched', readFileSync(join(x.dir, 'private.txt'), 'utf8') === 'foreign preserved')
}

const parked = fixture('parked')
writeFileSync(join(parked.dir, 'intent.txt'), 'parked intent'); git(parked.dir, 'add', 'intent.txt'); git(parked.dir, 'commit', '-qm', 'parked intent')
const pinned = git(parked.dir, 'rev-parse', 'HEAD')
git(parked.repo, 'branch', 'intent-wip', pinned)
git(parked.dir, 'reset', '--hard', 'master')
parked.patch((s) => { delete s.lanes.a })
parked.run('retry')
const parkedKey = parked.state().recovery.active
check('parked intent dispatch pins its actual SHA without merging', parked.requests().length === 1 && parked.state().recovery.items[parkedKey].commit === pinned && git(parked.repo, 'rev-parse', 'master') !== pinned)
const disposition = join(parked.repo, '.git', 'review.json')
writeFileSync(disposition, JSON.stringify({ reason: 'ambiguous intent preserved for explicit review', evidence: pinned }))
check('reviewed parked snapshot records a durable disposition', parked.run('recover', '--key', parkedKey, '--session', 'diagnostic-owner', '--disposition', 'reviewed', '--receipt', disposition).code === 0)
parked.run('retry'); parked.run('retry')
check('reviewed snapshot does not reopen every clock tick', parked.requests().length === 1)
parked.patch((s) => { s.parkedWork['refs/heads/intent-wip'] = { ref: 'refs/heads/intent-wip', commit: pinned, lane: 'a' }; delete s.recovery.items[parkedKey] })
git(parked.repo, 'update-ref', 'refs/heads/intent-wip', git(parked.repo, 'rev-parse', 'master'))
parked.run('retry'); parked.run('retry')
check('moved ref stays pinned and blocked without another pane', parked.requests().length === 1 && parked.state().recovery.items[parkedKey].status === 'blocked' && parked.state().recovery.items[parkedKey].commit === pinned)

const failed = fixture('failed-open')
writeFileSync(join(failed.dir, 'intent.txt'), 'preserved'); failed.patch((s) => { delete s.lanes.a })
delete failed.env.LANE_COMPLETION_LOG; delete failed.env.PF_CTL_NO_APP
writeFileSync(join(failed.repo, 'scripts', 'pf-ctl.mjs'), 'process.exit(1)\n')
failed.run('retry'); const failedKey = Object.keys(failed.state().recovery.items)[0]; failed.run('retry')
check('failed pane open records a blocker rather than retrying blindly', failed.state().recovery.items[failedKey]?.status === 'blocked' && !failed.state().recovery.active && readFileSync(join(failed.dir, 'intent.txt'), 'utf8') === 'preserved')

const resumed = fixture('completion-ended')
writeFileSync(join(resumed.dir, 'intent.txt'), 'completion must survive'); resumed.patch((s) => { delete s.lanes.a }); resumed.run('retry')
const resumedKey = resumed.state().recovery.active
const age = () => resumed.patch((s) => { s.recovery.items[resumedKey].at = Date.now() - 46 * 60_000 })
// `pf list` rows are `card number, pane id, state, title, folder` - the pane id is the
// SECOND column. Reading the first (the card number) never found the completion pane, so
// a live one was marked ended 10 min after dispatch (2026-10-02, s63-muq763lt).
age(); writeFileSync(resumed.panes, `1\tlogged\tworking\ttitle\t${resumed.repo}\n`); resumed.run('retry')
check('a relocated live completion pane prevents duplicate dispatch', resumed.requests().length === 1)
check('...and is not marked ended while its pane is open', resumed.state().recovery.items[resumedKey]?.status === 'dispatched' && resumed.state().recovery.active === resumedKey, JSON.stringify(resumed.state().recovery.items[resumedKey]))
writeFileSync(resumed.panes, ''); writeFileSync(resumed.beat, JSON.stringify({ at: Date.now(), chats: ['still-native'] }))
resumed.patch((s) => { s.recovery.items[resumedKey].owner = 'still-native'; s.recovery.items[resumedKey].status = 'owned' }); resumed.run('retry')
check('a quiet native completion owner prevents takeover', resumed.requests().length === 1)
writeFileSync(resumed.beat, JSON.stringify({ at: Date.now(), chats: [] })); resumed.run('retry')
check('known-ended completion owner resumes with the same pinned key', resumed.requests().length === 2 && resumed.state().recovery.active === resumedKey)
age(); resumed.run('retry'); age(); resumed.run('retry'); resumed.run('retry')
check('an unadopted replacement exit is blocked without replaying its task', resumed.requests().length === 2 && resumed.state().recovery.items[resumedKey].status === 'blocked' && !resumed.state().recovery.active && /without an adopted native owner/.test(resumed.state().recovery.items[resumedKey].reason))

const preclock = fixture('preclock-clean-orphan')
writeFileSync(join(preclock.dir, 'intent.txt'), 'orphan before clock'); git(preclock.dir, 'add', 'intent.txt'); git(preclock.dir, 'commit', '-qm', 'unready clean intent')
const preclockHead = git(preclock.dir, 'rev-parse', 'HEAD'), preclockIndex = git(preclock.dir, 'write-tree')
writeFileSync(join(preclock.repo, 'trunk.txt'), 'advanced trunk'); git(preclock.repo, 'add', 'trunk.txt'); git(preclock.repo, 'commit', '-qm', 'later trunk')
preclock.patch((s) => {delete s.lanes.a})
const preclockClaim = preclock.run('claim', '--prefer', 'a', '--cwd', preclock.dir, '--session', 'preclock-owner')
check('a clean orphan claim before the first clock preserves HEAD/index', preclockClaim.code === 0 && git(preclock.dir, 'rev-parse', 'HEAD') === preclockHead && git(preclock.dir, 'write-tree') === preclockIndex, preclockClaim.err)

// A clean recovery snapshot behind trunk must survive both direct and prompt claims.
const behind = fixture('behind-trunk')
writeFileSync(join(behind.dir, 'intent.txt'), 'clean pinned intent'); git(behind.dir, 'add', 'intent.txt'); git(behind.dir, 'commit', '-qm', 'pinned intent')
const behindHead = git(behind.dir, 'rev-parse', 'HEAD'), behindIndex = git(behind.dir, 'write-tree')
writeFileSync(join(behind.repo, 'trunk.txt'), 'later trunk'); git(behind.repo, 'add', 'trunk.txt'); git(behind.repo, 'commit', '-qm', 'trunk advanced'); git(behind.repo, 'push', '-q', 'origin', 'master')
behind.patch((s) => { delete s.lanes.a }); behind.run('retry')
const behindKey = behind.state().recovery.active
const direct = behind.run('claim', '--prefer', 'a', '--cwd', behind.dir, '--session', 'direct-owner')
check('ordinary recovery claim preserves clean behind-trunk HEAD and index', direct.code === 0 && git(behind.dir, 'rev-parse', 'HEAD') === behindHead && git(behind.dir, 'write-tree') === behindIndex, direct.err)
behind.run('release', '--session', 'direct-owner', '--gone')
const promptClaim = spawnSync(process.execPath, [join(behind.repo, 'scripts', 'lane-hook.mjs'), '--event=prompt'], { cwd: behind.dir, env: behind.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'hook-owner', cwd: behind.dir, prompt: 'finish preserved intent' }) })
check('automatic prompt claim preserves the pinned clean snapshot', promptClaim.status === 0 && behind.state().lanes.a?.session === 'hook-owner' && git(behind.dir, 'rev-parse', 'HEAD') === behindHead && git(behind.dir, 'write-tree') === behindIndex, promptClaim.stdout + promptClaim.stderr)
check('the prompt owner can bind the unchanged pinned snapshot', behind.run('recover', '--key', behindKey, '--session', 'hook-owner', '--disposition', 'begin').code === 0)

// Event barriers live only in the fixture copy, never in the production engine.
const eventFile = (path) => new Promise((resolve, reject) => {
  if (existsSync(path)) { resolve(); return }
  const timer = setTimeout(() => { w.close(); reject(new Error(`fixture event timed out: ${path}`)) }, 20_000)
  const w = watch(dirname(path), () => { if (existsSync(path)) { clearTimeout(timer); w.close(); resolve() } })
  if (existsSync(path)) { clearTimeout(timer); w.close(); resolve() }
})
const barrier = (ready, go) => `const fs=require('fs');const w=fs.watch(${JSON.stringify(dirname(go))},()=>{if(fs.existsSync(${JSON.stringify(go)})){w.close();process.exit(0)}});fs.writeFileSync(${JSON.stringify(ready)},'ready');`
const launch = (x, args, extra = {}) => {
  const child = spawn(process.execPath, [x.cli, ...args], { cwd: x.repo, env: { ...x.env, ...extra }, stdio: 'pipe' })
  const done = new Promise((resolve) => { let err=''; child.stderr.on('data', (d) => {err+=d}); child.on('exit', (code) => resolve({code,err})) })
  return { child, done }
}
const writer = fixture('ordinary-writer')
writer.run('claim', '--prefer', 'b', '--session', 'ordinary-owner')
writeFileSync(join(writer.dir, 'intent.txt'), 'preserved writer race'); writer.patch((s) => {delete s.lanes.a})
const writerReady = join(writer.repo, '.git', 'writer-ready'), writerGo = join(writer.repo, '.git', 'writer-go')
let writerSource = readFileSync(writer.cli, 'utf8')
writerSource = writerSource.replace('function write(state) {', `function write(state) {
  if (process.env.LANE_TEST_STALE_WRITER) spawnSync(process.execPath, ['-e', ${JSON.stringify(barrier(writerReady, writerGo))}], {timeout: 20_000, windowsHide:true})`)
writeFileSync(writer.cli, writerSource)
const staleWriter = launch(writer, ['park', '--session', 'ordinary-owner'], {LANE_TEST_STALE_WRITER:'1'})
await eventFile(writerReady)
writer.run('retry'); const reservation = readFileSync(writer.recoveryPath, 'utf8')
writeFileSync(writerGo, 'continue'); const writerResult = await staleWriter.done
writer.run('retry')
check('a real concurrent ordinary stale writer cannot erase the completion reservation', writerResult.code === 0 && writer.requests().length === 1 && readFileSync(writer.recoveryPath, 'utf8') === reservation, writerResult.err)

const stale = fixture('stale-lock-contenders')
writeFileSync(join(stale.dir, 'intent.txt'), 'lock race preserved'); stale.patch((s) => {delete s.lanes.a})
const lock = join(stale.repo, '.git', 'paneforge-recovery.lock')
const deadPID = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], {encoding:'utf8'}).trim())
mkdirSync(lock); writeFileSync(join(lock, 'owner'), `${deadPID}:dead-fixture`)
const observerReady = join(stale.repo, '.git', 'observer-ready'), observerGo = join(stale.repo, '.git', 'observer-go')
const openReady = join(stale.repo, '.git', 'open-ready'), openGo = join(stale.repo, '.git', 'open-go')
let staleSource = readFileSync(stale.cli, 'utf8')
staleSource = staleSource.replace('const dead = `${path}.dead-', `if (process.env.LANE_TEST_STALE_OBSERVER) spawnSync(process.execPath, ['-e', ${JSON.stringify(barrier(observerReady, observerGo))}], {timeout:20_000,windowsHide:true})
        const dead = ` + '`${path}.dead-')
writeFileSync(stale.cli, staleSource)
delete stale.env.LANE_COMPLETION_LOG; delete stale.env.PF_CTL_NO_APP
writeFileSync(join(stale.repo, 'scripts', 'pf-ctl.mjs'), `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${barrier(openReady, openGo).replace('process.exit(0)', "console.log('opened fixture-pane');process.exit(0)")}`)
const delayed = launch(stale, ['retry'], {LANE_TEST_STALE_OBSERVER:'1'})
await eventFile(observerReady)
const winner = launch(stale, ['retry'])
await eventFile(openReady); const liveToken = readFileSync(join(lock, 'owner'), 'utf8')
writeFileSync(observerGo, 'continue'); const delayedResult = await delayed.done
check('a delayed stale contender cannot remove a newly acquired live lock', delayedResult.code === 0 && readFileSync(join(lock, 'owner'), 'utf8') === liveToken && liveToken.startsWith(`${winner.child.pid}:`), delayedResult.err)
writeFileSync(openGo, 'continue'); const winnerResult = await winner.done
check('two stale-lock contenders produce exactly one durable pane reservation', winnerResult.code === 0 && Object.values(stale.state().recovery.items).filter((r) => r.pane === 'fixture-pane').length === 1, winnerResult.err)

const hook = fixture('guard-registry')
hook.run('release', '--session', 'original', '--gone')
// A detached release that did not execute must leave the real synchronous end marker.
renameSync(hook.cli, join(hook.repo, 'scripts', 'lane-real.mjs'))
writeFileSync(hook.cli, "if (process.argv[2] !== 'release') await import('./lane-real.mjs')\n")
copyFileSync(join(here, 'run-hidden.vbs'), join(hook.repo, 'scripts', 'run-hidden.vbs'))
hook.env.PF_PANE = 'same-pane'
const callHook = (event, session) => spawnSync(process.execPath, [join(hook.repo, 'scripts', 'lane-hook.mjs'), `--event=${event}`], { cwd: hook.dir, env: hook.env, encoding: 'utf8', input: JSON.stringify({ session_id: session, cwd: hook.dir, tool_name: 'Write', tool_input: { file_path: join(hook.dir, 'source.txt') } }) })
// The chat's pane is open in its lane, as it is in real use. Without it the sweep the hook
// starts first removes this empty, unheld folder on a Mac (lsof can see no program in it);
// Windows has no lsof, so the sweep fails closed there and the fixture never noticed.
writeFileSync(hook.panes, `1\tguard-pane\tworking\ttitle\t${hook.dir}\n`)
const guarded = callHook('pretool', 'guard-owner')
check('a guard-only first claim registers its repository', guarded.status === 0 && JSON.parse(readFileSync(hook.env.LANE_REGISTRY, 'utf8')).sessions['guard-owner'].includes(realpathSync(hook.repo)), guarded.stderr)
writeFileSync(join(hook.dir, 'source.txt'), 'dirty guard-only intent')
callHook('end', 'guard-owner')
check('guard-only SessionEnd stamps the actual owner ended synchronously', Number.isFinite(hook.state().lanes.a?.ended))
const carried = hook.run('claim', '--prefer', 'a', '--cwd', hook.dir, '--session', 'next-native-owner')
check('same pane after clear carries guard-only dirty work', carried.code === 0 && JSON.parse(carried.out).lane === 'a' && hook.state().lanes.a.session === 'next-native-owner' && readFileSync(join(hook.dir, 'source.txt'), 'utf8') === 'dirty guard-only intent', carried.err)

console.log(`${failures ? 'FAIL' : 'ok'} completion fixture: ${failures} failures`)
if (!failures) rmSync(root, { recursive: true, force: true })
process.exitCode = failures ? 1 : 0
