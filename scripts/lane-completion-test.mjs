// Real Git regressions for verified completion of preserved orphan work: the completion
// clock, parked snapshots, lock contenders, the guard hook, trust and dispatched panes.
// The rest: lane-completion-owner-test.mjs, lane-completion-adopt-test.mjs.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { here, root, check, git, fixture, shadow, finish } from './lane-completion-fixture.mjs'

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
check('every command in the brief names its subcommand first', brief.length === 6 && brief.every((c) => /lane\.mjs$/.test(c[0]) && /^[a-z]+$/.test(c[1]) && c.includes('--repo')), JSON.stringify(brief))
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

// A hold taken by `lane.mjs claim` from the chat's own shell, with no hook claim before it,
// has to be given back when that chat ends. Only the hook wrote the registry SessionEnd reads,
// so such a hold was never stamped ended and the pane's next chat after /clear could not carry
// it: Toolstash lane c sat stranded under a dead chat with its work (2026-10-09).
const cliHold = fixture('cli-registry')
cliHold.run('release', '--session', 'original', '--gone')
renameSync(cliHold.cli, join(cliHold.repo, 'scripts', 'lane-real.mjs'))
writeFileSync(cliHold.cli, "if (process.argv[2] !== 'release') await import('./lane-real.mjs')\n")
copyFileSync(join(here, 'run-hidden.vbs'), join(cliHold.repo, 'scripts', 'run-hidden.vbs'))
cliHold.env.PF_PANE = 'same-pane'
writeFileSync(cliHold.panes, `1\tcli-pane\tworking\ttitle\t${cliHold.dir}\n`)
const cliClaimed = cliHold.run('claim', '--prefer', 'a', '--cwd', cliHold.dir, '--session', 'cli-owner')
writeFileSync(join(cliHold.dir, 'source.txt'), 'dirty cli-claim intent')
const cliRegistry = () => existsSync(cliHold.env.LANE_REGISTRY) ? JSON.parse(readFileSync(cliHold.env.LANE_REGISTRY, 'utf8')) : { repos: {}, sessions: {} }
check('a CLI claim writes the chat into the SessionEnd registry', cliClaimed.code === 0 && JSON.parse(cliClaimed.out).lane === 'a' && (cliRegistry().sessions['cli-owner'] ?? []).includes(realpathSync(cliHold.repo)), `${cliClaimed.err}\n${JSON.stringify(cliRegistry())}`)
spawnSync(process.execPath, [join(cliHold.repo, 'scripts', 'lane-hook.mjs'), '--event=end'], { cwd: cliHold.dir, env: cliHold.env, encoding: 'utf8', input: JSON.stringify({ session_id: 'cli-owner', cwd: cliHold.dir }) })
check('SessionEnd stamps a CLI-claimed hold ended', Number.isFinite(cliHold.state().lanes.a?.ended), JSON.stringify(cliHold.state().lanes.a))
const cliCarried = cliHold.run('claim', '--prefer', 'a', '--cwd', cliHold.dir, '--session', 'next-chat')
check('same pane after clear carries the CLI-claimed dirty work', cliCarried.code === 0 && JSON.parse(cliCarried.out).lane === 'a' && cliHold.state().lanes.a.session === 'next-chat' && readFileSync(join(cliHold.dir, 'source.txt'), 'utf8') === 'dirty cli-claim intent', `${cliCarried.err}\n${cliCarried.out}`)

// A registry write that loses its rename (Windows refuses while another process has the file
// open; here the target is a folder, which fails the same way everywhere) must not leave its
// `lane-repos.json.<pid>.tmp` behind: 89 of them had piled up in ~/.claude by 2026-10-09.
{
  const t = fixture('tmp-registry')
  t.run('release', '--session', 'original', '--gone')
  t.env.PF_PANE = 'same-pane'
  writeFileSync(t.panes, `1\ttmp-pane\tworking\ttitle\t${t.dir}\n`)
  const blocked = join(t.repo, '.git', 'registry-blocked')
  mkdirSync(blocked)
  spawnSync(process.execPath, [join(t.repo, 'scripts', 'lane-hook.mjs'), '--event=pretool'], { cwd: t.dir, env: { ...t.env, LANE_REGISTRY: blocked }, encoding: 'utf8', input: JSON.stringify({ session_id: 'tmp-owner', cwd: t.dir, tool_name: 'Write', tool_input: { file_path: join(t.dir, 'source.txt') } }) })
  const left = readdirSync(join(t.repo, '.git')).filter((n) => /^registry-blocked\..*\.tmp$/.test(n))
  check('a registry write that cannot rename leaves no tmp file behind', left.length === 0 && t.state().lanes.a?.session === 'tmp-owner', JSON.stringify({ left, lane: t.state().lanes.a }))
}

// The completion pane is the one pane lane.mjs still opens, so it is where seedTrust is
// pinned (the conflict path raises a card now and opens nothing): the pane's folder gets
// the repo's Claude Code trust entry, so it does not stop on the trust prompt. A stand-in
// pf-ctl beside lane.mjs answers the open; no LANE_COMPLETION_LOG, so the real path runs.
{
  const t = fixture('trust')
  writeFileSync(join(t.repo, 'scripts', 'pf-ctl.mjs'), "console.log('opened pane-t')\n")
  const claudeHome = join(root, 'claude')
  mkdirSync(claudeHome, { recursive: true })
  const claudeJson = join(claudeHome, '.claude.json')
  writeFileSync(claudeJson, JSON.stringify({ projects: { [realpathSync(t.repo)]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], history: ['private'] } } }))
  writeFileSync(join(t.dir, 'source.txt'), 'trust intent\n')
  t.run('release', '--session', 'original', '--gone')
  const env = { ...t.env }
  delete env.PF_CTL_NO_APP
  delete env.LANE_COMPLETION_LOG
  spawnSync(process.execPath, [t.cli, 'retry'], { cwd: t.repo, env, encoding: 'utf8', timeout: 90_000 })
  const trust = JSON.parse(readFileSync(claudeJson, 'utf8')).projects[realpathSync(t.dir)]
  check('completion pane folder inherits the repo trust, not its prompt history', trust?.hasTrustDialogAccepted === true && trust.allowedTools?.[0] === 'Bash(ls:*)' && !('history' in trust), JSON.stringify(trust))
}

// 2026-10-07 (taskdriver.ai): a completion pane opened at lane b's folder was handed fallback
// lane c because b's old hold had not been reaped yet; once b was free the pane's own claim
// still came back as c, so `begin` could never match the ledger. A pane takes back the
// checkout its own recovery item was dispatched to; nobody else's pane does.
// Also: a release must not merge trunk into a lane that holds a preserved item (the pinned
// commit moved, `begin` refused, the dispatcher re-dispatched under a new key ten times).
const dispatchedFixture = (name, mutate = () => {}) => {
  const x = fixture(name)
  writeFileSync(join(x.dir, 'intent.txt'), name); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  x.patch((s) => {
    s.recovery.items[k].pane = 'pane-X'
    s.lanes.b = { session: 'rescuer', cwd: x.dir, pane: 'pane-X', seen: Date.now(), at: Date.now() }
    mutate(s, k)
  })
  return { x, k, head: git(x.dir, 'rev-parse', 'HEAD'), index: git(x.dir, 'write-tree') }
}
const claimAs = (x, pane) => {
  const r = spawnSync(process.execPath, [x.cli, 'claim', '--prefer', 'a', '--cwd', x.dir, '--session', 'rescuer'], { cwd: x.repo, env: { ...x.env, PF_PANE: pane }, encoding: 'utf8', timeout: 90_000 })
  let lane = null; try { lane = JSON.parse(r.stdout).lane } catch {}
  return { r, lane }
}
{
  const { x, k, head, index } = dispatchedFixture('swap')
  const c = claimAs(x, 'pane-X')
  check('own recovery pane takes its requested lane back', c.lane === 'a' && x.state().lanes.a?.session === 'rescuer' && !x.state().lanes.b, c.r.stdout + c.r.stderr)
  check('taking the lane back leaves HEAD and index alone', git(x.dir, 'rev-parse', 'HEAD') === head && git(x.dir, 'write-tree') === index)
  const b = x.run('recover', '--key', k, '--session', 'rescuer', '--disposition', 'begin')
  check('begin succeeds after the swap', b.code === 0, b.out + b.err)
}
// 2026-10-09 (paneforge-next lane e): an older blocked item with another owner sat before the
// dispatched one and shadowed it, so the pane was left on its fallback lane.
{
  const { x } = dispatchedFixture('swap-shadowed', shadow)
  const c = claimAs(x, 'pane-X')
  check('an older blocked item does not shadow the dispatched one', c.lane === 'a' && x.state().lanes.a?.session === 'rescuer' && !x.state().lanes.b, c.r.stdout + c.r.stderr)
}
{
  const { x } = dispatchedFixture('swap-shadowed-other-pane', shadow)
  const c = claimAs(x, 'pane-Y')
  check('shadowed item still refuses another pane', c.lane !== 'a' && x.state().lanes.b?.session === 'rescuer', c.r.stdout + c.r.stderr)
}
{
  const { x, k } = dispatchedFixture('swap-other-pane')
  const c = claimAs(x, 'pane-Y')
  check('another pane does not take the recovery lane', c.lane !== 'a' && x.state().lanes.b?.session === 'rescuer', c.r.stdout + c.r.stderr)
  check('begin still refuses from another pane', x.run('recover', '--key', k, '--session', 'rescuer', '--disposition', 'begin').code !== 0)
}
{
  const { x } = dispatchedFixture('swap-owned', (s, k) => { s.recovery.items[k].owner = 'someone-else'; s.recovery.items[k].status = 'owned' })
  const c = claimAs(x, 'pane-X')
  check('an item someone already owns is not taken back', c.lane !== 'a' && x.state().lanes.b?.session === 'rescuer', c.r.stdout + c.r.stderr)
}
{
  const x = fixture('release-catchup')
  writeFileSync(join(x.dir, 'intent.txt'), 'preserved'); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  const head = git(x.dir, 'rev-parse', 'HEAD')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  const bClaim = JSON.parse(x.run('claim', '--prefer', 'b', '--session', 'shipper').out)
  writeFileSync(join(bClaim.dir, 'shipped.txt'), 'ship'); git(bClaim.dir, 'add', 'shipped.txt'); git(bClaim.dir, 'commit', '-qm', 'ship it')
  const r = x.run('ready', '--session', 'shipper', '--lane', 'b')
  check('release of another lane succeeds', r.code === 0, r.out + r.err)
  check('a lane with a preserved item keeps its exact HEAD through a release', Boolean(k) && git(x.dir, 'rev-parse', 'HEAD') === head, git(x.dir, 'log', '--oneline', '-3'))
}
{
  const x = fixture('release-catchup-plain')
  // lane a keeps a folder on disk (committed, trunk-included work, so nothing is preserved)
  writeFileSync(join(x.dir, 'old.txt'), 'old'); git(x.dir, 'add', 'old.txt'); git(x.dir, 'commit', '-qm', 'old work')
  git(x.repo, 'merge', '-q', '--no-edit', 'lane-a'); git(x.repo, 'push', '-q', 'origin', 'master')
  x.run('release', '--session', 'original', '--gone')
  const bClaim = JSON.parse(x.run('claim', '--prefer', 'b', '--session', 'shipper').out)
  writeFileSync(join(bClaim.dir, 'shipped.txt'), 'ship'); git(bClaim.dir, 'add', 'shipped.txt'); git(bClaim.dir, 'commit', '-qm', 'ship it')
  const r = x.run('ready', '--session', 'shipper', '--lane', 'b')
  check('an ordinary unheld lane still catches up on a release', r.code === 0 && (!existsSync(x.dir) || git(x.dir, 'rev-parse', 'HEAD') === git(x.repo, 'rev-parse', 'master')), r.out + r.err)
}

finish()
