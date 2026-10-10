// Real Git regressions for verified completion of preserved orphan work: `adopt`, shipped
// items closed on claim, and a chat that starts on main reaching the lane it must take.
// The rest: lane-completion-test.mjs, lane-completion-owner-test.mjs.
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, git, fixture, shadow, finish } from './lane-completion-fixture.mjs'

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

// Defect F (2026-10-08): a shipped item whose lane folder was removed was never closed (the
// status call on a missing folder fails), so it kept the lane preserved forever. A missing
// folder holds no uncommitted work; a folder that exists with hand edits still blocks the close.
for (const [status, folder] of [['blocked', 'gone'], ['pending', 'gone'], ['blocked', 'hand-edits']]) {
  const x = fixture(`folder-${folder}-${status}`)
  writeFileSync(join(x.dir, 'intent.txt'), 'gone'); git(x.dir, 'add', 'intent.txt'); git(x.dir, 'commit', '-qm', 'unfinished intent')
  x.run('release', '--session', 'original', '--gone'); x.run('retry')
  const k = x.state().recovery.active
  x.patch((st) => { Object.assign(st.recovery.items[k], { owner: 'dead-owner', status }); delete st.recovery.active })
  git(x.repo, 'merge', '-q', '--no-edit', x.state().recovery.items[k].commit); git(x.repo, 'push', '-q', 'origin', 'master')
  if (folder === 'gone') rmSync(x.dir, { recursive: true, force: true })
  else writeFileSync(join(x.dir, 'source.txt'), 'hand edit\n')
  const r = spawnSync(process.execPath, [x.cli, 'claim', '--prefer', 'a', '--cwd', x.dir, '--session', 'newcomer'], { cwd: x.repo, env: x.env, encoding: 'utf8', timeout: 90_000 })
  const it = x.state().recovery.items[k]
  if (folder === 'gone') check(`claim closes a ${status} item trunk holds when its lane folder is gone`, it.status === 'reviewed' && it.reason === 'included by trunk ancestry', r.stdout + r.stderr + JSON.stringify(it))
  else check('claim leaves a shipped item open while its existing folder has hand edits', it.status === status && it.owner === 'dead-owner', r.stdout + r.stderr + JSON.stringify(it))
}

// Defect E (2026-10-07, taskdriver-mobile): a chat whose SessionStart claim gave it `main`
// (standing in the lane's folder) could never reach the lane it must adopt or begin on.
const mainFixture = (name, { shadowed = false, dispatched = false, ownerHoldsLane = false, dirty = false, diverge = false, conflict = false, squatted = false, operation = false } = {}) => {
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
    if (shadowed) shadow(st, k)
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
{
  const { x, claim } = mainFixture('main-swap-shadowed', { dispatched: true, shadowed: true })
  const c = claim()
  check('main holder takes the lane although an older blocked item shadows the dispatched one', c.lane === 'a' && x.state().lanes.a?.session === 'successor' && !x.state().lanes.main, c.r.stdout + c.r.stderr)
}
for (const [what, opts] of [['main has a hand edit', { dirty: true }], ['main has an unfinished cherry-pick', { operation: true }], ['the old owner still holds a lane', { ownerHoldsLane: true }], ['the lane does not contain the pinned commit', { diverge: true }], ['the dispatched lane HEAD changed', { dispatched: true, diverge: true }], ['the target lane is conflicted', { conflict: true }], ['another chat is standing in the target lane', { squatted: true }]]) {
  const { x, claim } = mainFixture(`main-stays-${what.replace(/\W+/g, '-')}`, opts)
  const c = claim()
  check(`${what}: the chat stays on main`, c.lane !== 'a' && x.state().lanes.main?.session === 'successor', c.r.stdout + c.r.stderr)
}

finish()
