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

// Parked work whose chat is gone must read as such in doctor, and a recovery item that lost
// its `active` slot must be revisited (measured 2026-10-04: a settings-rework ref dispatched
// 2026-09-30 to a pane long gone sat `dispatched` forever; doctor said "registered").
const orphan = fixture('orphan')
const wip = (name) => {
  writeFileSync(join(orphan.dir, `${name}.txt`), name); git(orphan.dir, 'add', `${name}.txt`); git(orphan.dir, 'commit', '-qm', name)
  const sha = git(orphan.dir, 'rev-parse', 'HEAD'); git(orphan.repo, 'branch', `${name}-wip`, sha); git(orphan.dir, 'reset', '--hard', 'master'); return sha
}
wip('one'); const twoSha = wip('two')
orphan.patch((s) => { delete s.lanes.a })
orphan.run('park', '--session', 'gone-chat', '--ref', 'one-wip', '--lane', 'a'); orphan.run('park', '--session', 'gone-chat', '--ref', 'two-wip', '--lane', 'b')
const doctorLine = (ref) => orphan.run('doctor').out.split('\n').find((l) => l.includes(`refs/heads/${ref}`)) ?? ''
check('A: doctor says the chat that parked it is gone', ['one-wip', 'two-wip'].every((r) => doctorLine(r).includes('the chat that parked it is gone')), orphan.run('doctor').out)
orphan.run('retry')
const k1 = orphan.state().recovery.active
check('B: retry dispatches exactly one request', orphan.requests().length === 1 && Boolean(k1), JSON.stringify(orphan.state().recovery))
const k2 = `ref:refs/heads/two-wip:${twoSha}`
orphan.patch((s) => { s.recovery.items[k2] = { ref: 'refs/heads/two-wip', commit: twoSha, lane: null, status: 'dispatched', pane: 's9-gone', owner: null, at: 0 } })
const orphanReceipt = join(orphan.repo, '.git', 'orphan-review.json')
writeFileSync(orphanReceipt, JSON.stringify({ reason: 'content already equivalent on trunk' }))
const rec = orphan.run('recover', '--key', k2, '--session', 'auditor', '--disposition', 'reviewed', '--receipt', orphanReceipt)
check('C: reviewing another item leaves the active one active', rec.code === 0 && orphan.state().recovery.active === k1, rec.err + JSON.stringify(orphan.state().recovery))
const dOne = doctorLine('one-wip')
check('C2: doctor says a dispatched item whose pane closed has lost its finishing chat', dOne.includes('its finishing chat logged is gone'), dOne)
const dTwo = doctorLine('two-wip')
check('D: doctor shows the reviewed item as done with its reason', dTwo.includes('done (reviewed)') && dTwo.includes('content already equivalent'), dTwo)
orphan.patch((s) => { delete s.recovery.active; s.recovery.items[k1].at = 0 })
orphan.run('retry')
check('E: an item that lost its slot is revisited and blocked', orphan.state().recovery.items[k1].status === 'blocked' && orphan.requests().length === 1, JSON.stringify(orphan.state().recovery.items[k1]))
check('F: doctor shows the blocked item', doctorLine('one-wip').includes('blocked:'), doctorLine('one-wip'))

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

// An owner that ends mid-recovery (status `owned`) after its pinned work reached trunk must
// not lock the lane for every later chat. research-lab lane b, 2026-10-03: the owner of
// lane:b:dc8c599 ended 2026-10-02 at `owned`, dc8c599 was already in origin/main, and every
// later `ready` on lane b threw. Unshipped pinned work keeps blocking, so does the caller's
// own item, and so does work pinned for its uncommitted changes (ancestry cannot prove those).
for (const kind of ['shipped', 'unshipped', 'shipped-chat-ends', 'uncommitted-on-trunk']) {
  const o = fixture(`ended-owner-${kind}`)
  if (kind === 'uncommitted-on-trunk') writeFileSync(join(o.dir, 'intent.txt'), 'uncommitted recovered intent')
  else { writeFileSync(join(o.dir, 'intent.txt'), 'recovered intent'); git(o.dir, 'add', 'intent.txt'); git(o.dir, 'commit', '-qm', 'recovered intent') }
  const pin = git(o.dir, 'rev-parse', 'HEAD')
  o.patch((s) => { delete s.lanes.a }); o.run('retry')
  const k = o.state().recovery.active
  // A pane open in the lane, as in real use: otherwise the sweep `release` starts removes
  // the folder once its work is in trunk (see the guard-only hook case below).
  writeFileSync(o.panes, `lane-pane\ttitle\tclaude\tworking\t${o.dir}\n`)
  o.run('claim', '--prefer', 'a', '--cwd', o.dir, '--session', 'ended-owner')
  const began = o.run('recover', '--key', k, '--session', 'ended-owner', '--disposition', 'begin')
  o.run('release', '--session', 'ended-owner', '--gone')
  if (kind.startsWith('shipped')) { git(o.repo, 'merge', '-q', '--ff-only', pin); git(o.repo, 'push', '-q', 'origin', 'master') }
  const next = o.run('claim', '--prefer', 'a', '--cwd', o.dir, '--session', 'next-chat')
  // The new chat commits in the lane; in the last case that includes the preserved changes.
  writeFileSync(join(o.dir, 'next.txt'), 'next chat work'); git(o.dir, 'add', '-A'); git(o.dir, 'commit', '-qm', 'next chat work')
  const item = () => o.state().recovery.items[k]
  // Claiming the lane already closes an item trunk holds (defect D); put it back to `owned`
  // so the ready-time and release-time closures below are still exercised.
  if (kind.startsWith('shipped')) {
    check(`${kind}: claim itself closes the item trunk already holds`, item()?.status === 'reviewed' && item()?.reason === 'included by trunk ancestry', JSON.stringify(item()))
    o.patch((s) => { s.recovery.items[k].status = 'owned'; delete s.recovery.items[k].reason; s.recovery.active = k })
  }
  check(`${kind}: an ended owner's owned item and the lane held by a new chat`, began.code === 0 && item()?.status === 'owned' && item()?.owner === 'ended-owner' && next.code === 0 && o.state().lanes.a?.session === 'next-chat', began.err + next.err)
  if (kind === 'shipped-chat-ends') {
    // A chat ending with clean committed work gets the same finish it gets in any lane.
    const end = o.run('release', '--session', 'next-chat')
    check(`${kind}: its committed work is marked done on the way out`, end.code === 0 && /marked done on the way out/.test(end.out) && item().status === 'reviewed', end.out + end.err + JSON.stringify(item()))
    continue
  }
  if (kind === 'shipped') {
    o.patch((s) => { s.recovery.items[k].owner = 'next-chat' })
    check(`${kind}: the caller's own unverified item still refuses ready`, o.run('ready', '--session', 'next-chat').code !== 0 && item().status === 'owned')
    o.patch((s) => { s.recovery.items[k].owner = 'ended-owner' })
  }
  const r = o.run('ready', '--session', 'next-chat')
  if (kind === 'shipped') check(`${kind}: a new chat's ready succeeds and the item reads reviewed`, r.code === 0 && item().status === 'reviewed' && item().reason === 'included by trunk ancestry' && o.state().recovery.active !== k, r.out + r.err + JSON.stringify(item()))
  else check(`${kind}: a new chat's ready still refuses and the item stays owned`, r.code !== 0 && /recovered work requires a current verification receipt/.test(r.err) && item().status === 'owned' && (kind !== 'uncommitted-on-trunk' || item().dirty === true), r.out + r.err + JSON.stringify(item()))
}

// A /clear in the recovery owner's pane: claim carries the ended hold to the pane's new chat
// and must carry the owner's unfinished recovery item with it. assistant lane a, 2026-10-04:
// owner 42113999 committed on lane a (16c8332 -> c1c4c30), the pane cleared, lanes.a went to
// 21c80996, the item stayed on 42113999 - `recover` refused the new chat ("another recovery
// owner holds this key"), `begin` refused the moved HEAD, `ready` refused the foreign item,
// and the old session no longer held the lane. A live owner, or one in another pane, keeps
// its item; so does another chat's item, the owner's item on another lane, and one trunk
// already holds. A held recovery lock leaves the item as it was and the next claim retries.
// SessionEnd's detached release running before the next claim keeps the owner's hold.
for (const kind of ['carried', 'release-first', 'release-shipped', 'locked', 'live-owner', 'other-pane']) {
  const o = fixture(`cleared-owner-${kind}`)
  writeFileSync(join(o.dir, 'intent.txt'), 'recovered intent'); git(o.dir, 'add', 'intent.txt'); git(o.dir, 'commit', '-qm', 'recovered intent')
  o.patch((s) => { delete s.lanes.a }); o.run('retry')
  const k = o.state().recovery.active
  writeFileSync(o.panes, `lane-pane\ttitle\tclaude\tworking\t${o.dir}\n`)
  o.env.PF_PANE = 'owner-pane'
  o.run('claim', '--prefer', 'a', '--cwd', o.dir, '--session', 'cleared-owner')
  const began = o.run('recover', '--key', k, '--session', 'cleared-owner', '--disposition', 'begin')
  writeFileSync(join(o.dir, 'intent.txt'), 'owner kept working'); git(o.dir, 'commit', '-qam', 'owner kept working')
  if (kind !== 'live-owner') o.run('park', '--session', 'cleared-owner', '--ended')
  if (kind === 'release-first') {
    const released = o.run('release', '--session', 'cleared-owner')
    check(`${kind}: the ended owner's hold stays for its pane`, released.code === 0 && o.state().lanes.a?.session === 'cleared-owner' && Number.isFinite(o.state().lanes.a?.ended), released.out + released.err)
  }
  if (kind === 'release-shipped') {
    const shipped = git(o.repo, 'rev-parse', 'master')
    o.patch((s) => { s.recovery.items[k].commit = shipped })
    const released = o.run('release', '--session', 'cleared-owner')
    check(`${kind}: an item trunk already holds keeps no hold for the next chat`, began.code === 0 && released.code === 0 && o.state().lanes.a?.session !== 'cleared-owner', released.out + released.err + JSON.stringify(o.state().lanes.a))
    continue
  }
  const head = git(o.dir, 'rev-parse', 'HEAD'), base = git(o.repo, 'rev-parse', 'master')
  const others = { 'lane:a:bystander': { lane: 'a', commit: head, status: 'owned', owner: 'bystander' }, 'lane:b:owner': { lane: 'b', commit: head, status: 'owned', owner: 'cleared-owner' }, 'lane:a:shipped': { lane: 'a', commit: base, status: 'owned', owner: 'cleared-owner' } }
  if (kind === 'carried') o.patch((s) => { Object.assign(s.recovery.items, others) })
  if (kind === 'other-pane') o.env.PF_PANE = 'next-pane'
  const lock = join(o.repo, '.git', 'paneforge-recovery.lock')
  if (kind === 'locked') { mkdirSync(lock); writeFileSync(join(lock, 'owner'), `${process.pid}:live-fixture`) }
  const next = o.run('claim', '--prefer', 'a', '--cwd', o.dir, '--session', 'next-chat')
  const item = () => o.state().recovery.items[k]
  const setup = began.code === 0 && next.code === 0
  if (kind === 'live-owner' || kind === 'other-pane') {
    check(`${kind}: the item stays with its owner`, setup && item()?.owner === 'cleared-owner' && item()?.status === 'owned' && o.state().lanes.a?.session === 'cleared-owner', began.err + next.err + JSON.stringify(item()))
    continue
  }
  if (kind === 'locked') {
    check(`${kind}: a held recovery lock still lets the claim carry the lane, item untouched`, setup && o.state().lanes.a?.session === 'next-chat' && item()?.owner === 'cleared-owner', began.err + next.err + JSON.stringify(item()))
    rmSync(lock, { recursive: true, force: true })
    const again = o.run('claim', '--prefer', 'a', '--cwd', o.dir, '--session', 'next-chat')
    check(`${kind}: the next claim carries the item`, again.code === 0 && item()?.owner === 'next-chat', again.err + JSON.stringify(item()))
  } else check(`${kind}: the pane's new chat owns the item, status and pane kept`, setup && o.state().lanes.a?.session === 'next-chat' && item()?.owner === 'next-chat' && item()?.status === 'owned' && item()?.pane === 'logged', began.err + next.err + JSON.stringify(item()))
  if (kind === 'carried') check(`${kind}: another chat's item, another lane's and a shipped one stay with their owners`, Object.entries(others).every(([key, r]) => o.state().recovery.items[key]?.owner === r.owner), JSON.stringify(o.state().recovery.items))
  const receipt = join(o.repo, '.git', 'proof.json')
  writeFileSync(receipt, JSON.stringify({ commit: git(o.dir, 'rev-parse', 'HEAD'), checks: [{ command: 'fixture assertions', exitCode: 0 }], review: { reviewer: 'independent fixture', result: 'accepted' } }))
  const verified = o.run('recover', '--key', k, '--session', 'next-chat', '--disposition', 'verified', '--receipt', receipt)
  check(`${kind}: the new chat records verification`, verified.code === 0 && item()?.status === 'verified', verified.err)
  const ready = o.run('ready', '--session', 'next-chat')
  check(`${kind}: the new chat's ready ships the recovered work`, ready.code === 0, ready.out + ready.err)
}

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

// Defect C (2026-10-07, taskdriver-mobile): the owner's pane closed, Robert resumed in another
// pane, and no supported command moved the item to the successor. `adopt` does, under proof.
const adoptFixture = (name, { commits = 0, mutate = () => {} } = {}) => {
  const x = fixture(name)
  writeFileSync(join(x.dir, 'intent.txt'), name); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  const pinned = git(x.dir, 'rev-parse', 'HEAD')
  for (let i = 0; i < commits; i++) { writeFileSync(join(x.dir, `more${i}.txt`), 'x'); git(x.dir, 'add', '-A'); git(x.dir, 'commit', '-qm', `successor ${i}`) }
  x.patch((st) => {
    Object.assign(st.recovery.items[k], { owner: 'dead-owner', status: 'owned' })
    st.lanes.a = { session: 'successor', cwd: x.dir, seen: Date.now(), at: Date.now() }
    mutate(st, k)
  })
  const adopt = (session = 'successor') => x.run('recover', '--key', k, '--session', session, '--disposition', 'adopt')
  return { x, k, pinned, adopt, item: () => x.state().recovery.items[k] }
}
for (const commits of [0, 1]) {
  const { x, k, adopt, item } = adoptFixture(`adopt-ok-${commits}`, { commits })
  const r = adopt()
  check(`adopt moves a dead owner's item to the lane holder (HEAD +${commits})`, r.code === 0 && item().owner === 'successor' && item().status === 'owned' && item().adoptedFrom?.[0] === 'dead-owner', r.out + r.err)
  if (commits === 0) {
    const receipt = join(x.repo, '.git', 'adopt-proof.json')
    writeFileSync(receipt, JSON.stringify({ commit: git(x.dir, 'rev-parse', 'HEAD'), checks: [{ command: 'fixture assertions', exitCode: 0 }], review: { reviewer: 'independent fixture', result: 'accepted' } }))
    const v = x.run('recover', '--key', k, '--session', 'successor', '--disposition', 'verified', '--receipt', receipt)
    check('the adopter can record verification', v.code === 0 && item().status === 'verified', v.out + v.err)
  }
}
{
  const { adopt, item } = adoptFixture('adopt-not-lane-holder')
  const r = adopt('bystander')
  check('adopt refuses a caller that does not hold the lane', r.code !== 0 && item().owner === 'dead-owner', r.out + r.err)
}
{
  const { adopt, item } = adoptFixture('adopt-owner-holds-lane', { mutate: (st) => { st.lanes.b = { session: 'dead-owner', cwd: join(st.lanes.a.cwd, '..', 'nowhere'), seen: Date.now(), at: Date.now() } } })
  const r = adopt()
  check('adopt refuses while the old owner still holds a lane', r.code !== 0 && item().owner === 'dead-owner', r.out + r.err)
}
{
  const { x, adopt, item } = adoptFixture('adopt-not-descendant')
  git(x.dir, 'checkout', '-q', '--detach', 'master'); git(x.dir, 'reset', '-q', '--hard', 'v0.0.1')
  const r = adopt()
  check('adopt refuses a HEAD that does not descend from the pinned commit', r.code !== 0 && item().owner === 'dead-owner', r.out + r.err)
}
{
  const { adopt, item } = adoptFixture('adopt-blocked', { mutate: (st, k) => { st.recovery.items[k].status = 'blocked' } })
  const r = adopt()
  check('adopt refuses a blocked item', r.code !== 0 && item().owner === 'dead-owner' && item().status === 'blocked', r.out + r.err)
}

// Defect D (2026-10-07, taskdriver.ai): a blocked item with a dead owner whose pinned commit
// trunk already holds was only ever closed for a lane the caller HELD, so claim could never
// reach the lane to close it.
for (const shipped of [true, false]) {
  const x = fixture(`blocked-${shipped ? 'in' : 'not-in'}-trunk`)
  writeFileSync(join(x.dir, 'intent.txt'), 'blocked'); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  x.patch((st) => { Object.assign(st.recovery.items[k], { owner: 'dead-owner', status: 'blocked' }); delete st.recovery.active })
  if (shipped) { git(x.repo, 'merge', '-q', '--no-edit', x.state().recovery.items[k].commit); git(x.repo, 'push', '-q', 'origin', 'master') }
  const r = spawnSync(process.execPath, [x.cli, 'claim', '--prefer', 'a', '--cwd', x.dir, '--session', 'newcomer'], { cwd: x.repo, env: x.env, encoding: 'utf8', timeout: 90_000 })
  let lane = null; try { lane = JSON.parse(r.stdout).lane } catch {}
  const it = x.state().recovery.items[k]
  if (shipped) check('claim closes a blocked item trunk already holds and gets the lane', lane === 'a' && it.status === 'reviewed' && it.reason === 'included by trunk ancestry', r.stdout + r.stderr + JSON.stringify(it))
  else check('claim leaves a blocked item trunk does not hold untouched', it.status === 'blocked' && it.owner === 'dead-owner', r.stdout + r.stderr + JSON.stringify(it))
}

// Defect E (2026-10-07, taskdriver-mobile): a chat whose SessionStart claim gave it `main`
// (standing in the lane's folder) could never reach the lane it must adopt or begin on.
const mainFixture = (name, { dispatched = false, ownerHoldsLane = false, dirty = false, diverge = false, conflict = false, squatted = false, operation = false } = {}) => {
  const x = fixture(name)
  writeFileSync(join(x.dir, 'intent.txt'), name); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  if (diverge) { git(x.dir, 'checkout', '-q', '--detach', 'v0.0.1') }
  writeFileSync(join(x.repo, 'ahead.txt'), 'main work'); git(x.repo, 'add', 'ahead.txt'); git(x.repo, 'commit', '-qm', 'main ahead')
  if (conflict) {
    writeFileSync(join(x.dir, 'source.txt'), 'preserved lane edit\n'); git(x.dir, 'add', 'source.txt'); git(x.dir, 'commit', '-qm', 'lane edit')
    writeFileSync(join(x.repo, 'source.txt'), 'main edit\n'); git(x.repo, 'add', 'source.txt'); git(x.repo, 'commit', '-qm', 'main edit')
  }
  if (dirty) writeFileSync(join(x.repo, 'source.txt'), 'hand edit\n')
  if (operation) writeFileSync(join(git(x.repo, 'rev-parse', '--absolute-git-dir'), 'CHERRY_PICK_HEAD'), git(x.repo, 'rev-parse', 'HEAD') + '\n')
  x.patch((st) => {
    const it = st.recovery.items[k]
    if (dispatched) Object.assign(it, { status: 'dispatched', pane: 'pane-X' })
    else Object.assign(it, { owner: 'dead-owner', status: 'owned' })
    st.lanes.main = { session: 'successor', cwd: x.repo, seen: Date.now(), at: Date.now() }
    if (ownerHoldsLane) st.lanes.b = { session: 'dead-owner', cwd: join(x.repo, 'nowhere'), seen: Date.now(), at: Date.now() }
    if (conflict) st.conflicts.a = { detail: 'source.txt' }
    if (squatted) st.lanes.b = { session: 'other-chat', cwd: x.dir, seen: Date.now(), at: Date.now() }
  })
  const claim = () => {
    const r = spawnSync(process.execPath, [x.cli, 'claim', '--prefer', 'a', '--cwd', x.dir, '--session', 'successor'], { cwd: x.repo, env: { ...x.env, PF_PANE: dispatched ? 'pane-X' : '' }, encoding: 'utf8', timeout: 90_000 })
    let lane = null; try { lane = JSON.parse(r.stdout).lane } catch {}
    return { r, lane }
  }
  return { x, k, claim, mainHead: git(x.repo, 'rev-parse', 'HEAD') }
}
for (const dispatched of [false, true]) {
  const { x, k, claim, mainHead } = mainFixture(`main-swap-${dispatched ? 'dispatched' : 'adopt'}`, { dispatched })
  const c = claim(); const st = x.state()
  check(`main holder takes the lane (${dispatched ? 'dispatched to its pane' : 'adoptable'}) and leaves main untouched`, c.lane === 'a' && st.lanes.a?.session === 'successor' && !st.lanes.main && !st.ready.main && git(x.repo, 'rev-parse', 'HEAD') === mainHead, c.r.stdout + c.r.stderr + JSON.stringify(st.lanes) + JSON.stringify(st.ready))
  const next = x.run('recover', '--key', k, '--session', 'successor', '--disposition', dispatched ? 'begin' : 'adopt')
  check(`${dispatched ? 'begin' : 'adopt'} succeeds after leaving main`, next.code === 0, next.out + next.err)
}
for (const [what, opts] of [['main has a hand edit', { dirty: true }], ['main has an unfinished cherry-pick', { operation: true }], ['the old owner still holds a lane', { ownerHoldsLane: true }], ['the lane does not contain the pinned commit', { diverge: true }], ['the dispatched lane HEAD changed', { dispatched: true, diverge: true }], ['the target lane is conflicted', { conflict: true }], ['another chat is standing in the target lane', { squatted: true }]]) {
  const { x, claim } = mainFixture(`main-stays-${what.replace(/\W+/g, '-')}`, opts)
  const c = claim()
  check(`${what}: the chat stays on main`, c.lane !== 'a' && x.state().lanes.main?.session === 'successor', c.r.stdout + c.r.stderr)
}

console.log(`${failures ? 'FAIL' : 'ok'} completion fixture: ${failures} failures`)
if (!failures) rmSync(root, { recursive: true, force: true })
process.exitCode = failures ? 1 : 0
