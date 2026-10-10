// Real Git regressions for verified completion of preserved orphan work: doctor, the
// completion pane's clock, rebased lanes, and an owner that ends or clears mid-recovery.
// The rest: lane-completion-test.mjs, lane-completion-adopt-test.mjs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, git, fixture, finish } from './lane-completion-fixture.mjs'

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

// A release that rebases master onto origin rewrites a merged lane's commit under a new sha:
// the lane tip is no longer an ancestor, but `git cherry` shows every commit '-'. That lane
// holds nothing of its own and must not get a recovery chat (PaneForge lane a 2026-10-09:
// 5f440ebc dispatched though master held it as b036d578). A merge commit can carry its own
// content, so a lane with one is still preserved.
for (const merge of [false, true]) {
  const x = fixture(merge ? 'rebased-with-merge' : 'rebased-equivalent')
  writeFileSync(join(x.dir, 'intent.txt'), 'landed intent\n'); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'landed intent')
  const landed = git(x.dir, 'rev-parse', 'HEAD')
  writeFileSync(join(x.repo, 'trunk.txt'), 'later trunk\n'); git(x.repo, 'add', 'trunk.txt'); git(x.repo, 'commit', '-qm', 'trunk advanced')
  git(x.repo, 'cherry-pick', landed); git(x.repo, 'push', '-q', 'origin', 'master')
  if (merge) git(x.dir, 'merge', '-q', '--no-edit', 'master')
  x.patch((s) => { delete s.lanes.a }); x.run('retry')
  const items = Object.values(x.state().recovery.items ?? {})
  if (merge) check('a lane whose equivalent work sits beside a merge commit is still preserved', x.requests().length === 1 && items.length === 1, JSON.stringify(x.state().recovery))
  else check('a lane whose every commit master holds under another sha gets no recovery chat', x.requests().length === 0 && items.length === 0, JSON.stringify(x.state().recovery))
}

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

finish()
