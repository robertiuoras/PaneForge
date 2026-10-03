// Regression test for five ways finished work was left with no way out (2026-09-28,
// taskdriver.ai).
//
//   A. /clear stranded a pane away from its own lane. Pane s10 held lane a with a finished
//      commit; after /clear its new session id was handed lane c, every write into its own
//      taskdriver.ai-a was refused, and nothing it was allowed to run could put it back.
//      Same day: the SEO pane's pre-clear chat held `main` with an uncommitted package.json
//      edit, and its new chat was sent to lane b - nobody could commit that edit any more.
//      The hold under the old session id is the pane's previous chat; it is carried over -
//      only once that session has ENDED (the SessionEnd hook marks it before its release,
//      which can lose the race with the new chat's first claim).
//   B. `resolve --lane a` answered "lane a is not conflicted" for a lane whose worktree had
//      a merge open with unmerged files, because the ledger had no record of it.
//   C. An uncommitted file in main whose bytes were exactly what a ready lane brings held
//      every merge, though the merge produces those same bytes.
//   F. A lane whose commits main already had under rebased shas could not catch up (main
//      had edited those files since), so every release called it "finished but conflicts".
//   G. `resolve --lane c` on such a lane with a merge open handed it to a resolver, and
//      the next lane command dropped the conflict (nothing ahead), so the guard refused
//      the resolver's commit. Nothing of its own: resolve now puts the lane on main.
//      (D and E, the taskdriver.ai proof gate, are pinned by lane-taskdriver-pc-test.)
//
// Real git repos in the temp folder, real lane.mjs, no stubs.
//
//   node scripts/lane-cleared-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'paneforge-lane-cleared-test-'))

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function fixture(name, { release = 'version', origin = false } = {}) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c'] }, null, 2) + '\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  if (origin) {
    // `ship` refuses to merge onto a branch it cannot then push.
    const bare = join(root, `${name}.git`)
    git(root, 'init', '-q', '--bare', bare)
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', '-q', '-u', 'origin', 'master')
  }

  /** `pane` is the PF_PANE the app gives every chat it starts; '' is a chat outside it. */
  const lane = (pane, ...args) => {
    try {
      return {
        ok: true,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
          cwd: repo,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PF_PANE: pane, PF_RELEASE: release }
        }).trim()
      }
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () =>
    existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lanes: {}, ready: {}, conflicts: {} }
  const patchState = (fn) => {
    const s = state()
    fn(s)
    writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  const claim = (pane, session, ...more) => {
    const r = lane(pane, 'claim', '--session', session, ...more)
    return r.ok ? JSON.parse(r.out) : { error: r.err || r.out }
  }
  const laneOf = (session) => Object.entries(state().lanes).find(([, c]) => c.session === session)?.[0] ?? null
  // No release attempts in a repo with no remote.
  if (!origin) patchState((s) => (s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }))
  return { repo, lane, state, patchState, claim, laneOf }
}

const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}
const identity = (dir) => {
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
}

// ------------------------------------------- A. a cleared pane keeps its lane and its work

{
  const f = fixture('carry-commit')
  const a = f.claim('pane-s10', 'before-clear', '--prefer', 'a')
  identity(a.dir)
  commit(a.dir, 'feature.js', 'export const done = 1\n', 'feat: finished work')
  // /clear: SessionEnd marks the old session ended, its release loses the race with the
  // new session's first claim, and the hold is still there under the old id.
  f.lane('pane-s10', 'park', '--session', 'before-clear', '--ended')
  const after = f.claim('pane-s10', 'after-clear', '--cwd', a.dir, '--prefer', 'a')
  ok('A: the pane\'s new chat is handed the lane its old chat held', after.lane === 'a', JSON.stringify(after))
  ok('A: and the old session id holds nothing', !f.laneOf('before-clear'), JSON.stringify(f.state().lanes))
  ok('A: the hold is a live one (not parked, not marked ended)', !f.state().lanes.a?.parked && !f.state().lanes.a?.ended, JSON.stringify(f.state().lanes.a))
  const write = f.lane('pane-s10', 'guard', '--session', 'after-clear', '--path', join(a.dir, 'feature.js'))
  ok('A: and it may write in its own folder again', write.ok, write.out || write.err)
}

{
  // A prompt pinned to b was sent after its previous app owner disappeared. Startup
  // chose c, and every later prompt kept c even after b became available.
  const f = fixture('routing-empty-dead-owner')
  const b = f.claim('old-pane', 'old-session', '--prefer', 'b')
  writeFileSync(join(f.repo, '.git', 'paneforge-panes.json'), JSON.stringify({
    [`pf-${process.pid}`]: { at: Date.now(), chats: ['new-session'] }
  }))
  const next = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: startup reclaims the requested empty checkout only after its app owner is proven gone', next.lane === 'b', JSON.stringify(next))
}

{
  const f = fixture('routing-live-owner')
  const b = f.claim('old-pane', 'live-session', '--prefer', 'b')
  writeFileSync(join(f.repo, '.git', 'paneforge-panes.json'), JSON.stringify({
    [`pf-${process.pid}`]: { at: Date.now(), chats: ['live-session', 'new-session'] }
  }))
  const next = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: startup never takes the requested checkout from a live app owner', next.lane !== 'b' && f.laneOf('live-session') === 'b', JSON.stringify(next))
  // When that owner actually leaves, a repeated prompt must stop injecting the empty
  // fallback assignment. This does not require changing the native conversation id.
  f.patchState((s) => delete s.lanes.b)
  const back = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: an empty fallback returns to its original requested checkout when it becomes free', back.lane === 'b', JSON.stringify(back))
  ok('A: reconciliation releases the unused fallback hold', Object.keys(f.state().lanes).length === 1, JSON.stringify(f.state().lanes))
}

{
  const f = fixture('routing-unknown-owner')
  const b = f.claim('old-pane', 'old-session', '--prefer', 'b')
  const next = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: missing native inventory never proves the requested owner gone', next.lane !== 'b' && f.laneOf('old-session') === 'b', JSON.stringify(next))
}

{
  const f = fixture('routing-external-owner')
  const b = f.claim('', 'external-session', '--prefer', 'b')
  writeFileSync(join(f.repo, '.git', 'paneforge-panes.json'), JSON.stringify({
    [`pf-${process.pid}`]: { at: Date.now(), chats: ['new-session'] }
  }))
  const next = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: app inventory cannot give up an external terminal owner', next.lane !== 'b' && f.laneOf('external-session') === 'b', JSON.stringify(next))
}

{
  const f = fixture('routing-preserve-work')
  const b = f.claim('old-pane', 'old-session', '--prefer', 'b')
  writeFileSync(join(b.dir, 'unfinished.js'), 'preserve this\n')
  writeFileSync(join(f.repo, '.git', 'paneforge-panes.json'), JSON.stringify({
    [`pf-${process.pid}`]: { at: Date.now(), chats: ['new-session'] }
  }))
  const next = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: a gone owner with unfinished work is preserved', next.lane !== 'b' && f.laneOf('old-session') === 'b', JSON.stringify(next))
  writeFileSync(join(next.dir, 'current.js'), 'preserve this too\n')
  f.patchState((s) => delete s.lanes.b)
  const back = f.claim('new-pane', 'new-session', '--cwd', b.dir, '--prefer', 'b', '--visitor')
  ok('A: reconciliation never abandons work in the current fallback', back.lane === next.lane, JSON.stringify(back))
}

{
  const f = fixture('routing-checkout-visit')
  const a = f.claim('pane', 'session', '--prefer', 'a')
  f.claim('pane', 'session', '--cwd', a.dir, '--prefer', 'a')
  f.claim('other-pane', 'other-session', '--prefer', 'b')
  f.patchState((s) => delete s.lanes.b)
  const next = f.claim('pane', 'session', '--cwd', join(f.repo + '-b', 'subfolder'), '--prefer', 'b')
  ok('A: visiting another free checkout does not move an existing hold', next.lane === a.lane, JSON.stringify(next))
}

{
  const f = fixture('routing-unrecorded-cwd')
  const a = f.claim('pane', 'session', '--prefer', 'a')
  const b = f.claim('other-pane', 'other-session', '--prefer', 'b')
  f.patchState((s) => delete s.lanes.b)
  // A hand claim records no cwd. Resolving that missing value as the process cwd
  // would incorrectly turn a subsequent visit into evidence of the original home.
  const next = JSON.parse(execFileSync(process.execPath, [join(f.repo, 'scripts', 'lane.mjs'),
    'claim', '--session', 'session', '--cwd', b.dir, '--prefer', 'b'], {
    cwd: b.dir, encoding: 'utf8', env: { ...process.env, PF_PANE: 'pane' }
  }))
  ok('A: an unrecorded home is not inferred from the current process cwd', next.lane === a.lane, JSON.stringify(next))
}

{
  const f = fixture('carry-dirty-main')
  const m = f.claim('pane-seo', 'seo-before', '--cwd', f.repo, '--prefer', 'main')
  ok('A: the SEO chat starts on main', m.lane === 'main', JSON.stringify(m))
  writeFileSync(join(f.repo, 'package.json'), JSON.stringify({ name: 'seo', version: '0.0.1', seo: true }, null, 2) + '\n')
  f.lane('pane-seo', 'park', '--session', 'seo-before', '--ended')
  const after = f.claim('pane-seo', 'seo-after', '--cwd', f.repo, '--prefer', 'main')
  ok('A: a cleared chat with an uncommitted edit on main is handed main back', after.lane === 'main', JSON.stringify(after))
  ok('A: so the edit has a chat that may commit it', f.state().lanes.main?.session === 'seo-after', JSON.stringify(f.state().lanes))
}

{
  // Already stranded: the new chat was given an empty lane before this fix existed.
  const f = fixture('move-to-work')
  const a = f.claim('pane-s10', 'before-clear', '--prefer', 'a')
  identity(a.dir)
  commit(a.dir, 'feature.js', 'export const done = 1\n', 'feat: finished work')
  f.lane('pane-s10', 'park', '--session', 'before-clear', '--ended')
  const c = f.claim('', 'after-clear', '--prefer', 'c')
  f.patchState((s) => (s.lanes.c.pane = 'pane-s10'))
  ok('A: (setup) the new chat sits on an empty lane c', c.lane === 'c', JSON.stringify(c))
  const next = f.claim('pane-s10', 'after-clear', '--cwd', c.dir)
  ok('A: its next prompt moves it to the lane with the work', next.lane === 'a', JSON.stringify(next))
  ok('A: and lets the empty lane go', !f.state().lanes.c, JSON.stringify(f.state().lanes))
}

{
  // A chat that runs `claude -p` inside the repo passes PF_PANE down to it. The parent is
  // mid-turn; the child is not the pane's next chat and must not take the parent's lane.
  const f = fixture('nested-child')
  const b = f.claim('pane-p', 'parent', '--prefer', 'b')
  const child = f.claim('pane-p', 'child-run', '--cwd', f.repo)
  ok('A: a nested run in the same pane does not take a mid-turn chat\'s lane', f.laneOf('parent') === 'b' && child.lane !== 'b', JSON.stringify({ child, lanes: f.state().lanes }))
  void b
}

{
  // The same child started in the background: the parent's TURN ends (Stop parks it) while
  // the child runs on. A turn being over is not the chat being over.
  const f = fixture('background-child')
  const b = f.claim('pane-p', 'parent', '--prefer', 'b')
  writeFileSync(join(b.dir, 'wip.js'), 'half an edit\n')
  f.lane('pane-p', 'park', '--session', 'parent')
  const child = f.claim('pane-p', 'bg-child', '--cwd', f.repo)
  ok('A: a background run does not take a parked (still open) chat\'s lane', f.laneOf('parent') === 'b' && child.lane !== 'b', JSON.stringify({ child, lanes: f.state().lanes }))
}

{
  // A sleeping pane's agent is stopped on purpose and SessionEnd fires; the pane comes back
  // as the same session, so the hold must stay asleep, not be ended or released.
  const f = fixture('sleep-end')
  f.claim('pane-z', 'sleeper', '--prefer', 'a')
  f.lane('pane-z', 'sleep', '--session', 'sleeper')
  f.lane('pane-z', 'park', '--session', 'sleeper', '--ended')
  f.lane('pane-z', 'release', '--session', 'sleeper')
  const held = f.state().lanes.a
  ok('A: a sleeping chat\'s SessionEnd keeps its lane asleep, not ended', held?.session === 'sleeper' && held.asleep && !held.ended, JSON.stringify(held))
}

{
  // The hook itself: SessionEnd marks the holds ended IN-LINE, before the release it
  // starts in the background. The engine beside the hook copy only logs what it was asked.
  const dir = join(root, 'hook-end', 'scripts')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(here, 'lane-hook.mjs'), join(dir, 'lane-hook.mjs'))
  const log = join(root, 'hook-end', 'calls.log')
  writeFileSync(join(dir, 'lane.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')\n`)
  const repo = join(root, 'hook-end', 'repo')
  mkdirSync(repo, { recursive: true })
  const registry = join(root, 'hook-end', 'lane-repos.json')
  writeFileSync(registry, JSON.stringify({ repos: {}, sessions: { 'ending-chat': [repo] } }))
  execFileSync(process.execPath, [join(dir, 'lane-hook.mjs'), '--event=end'], {
    input: JSON.stringify({ session_id: 'ending-chat', cwd: repo }),
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, LANE_REGISTRY: registry }
  })
  const first = existsSync(log) ? readFileSync(log, 'utf8').split('\n')[0] : ''
  ok('A: SessionEnd marks the chat ended before its release starts', /^park --session ending-chat --ended\b/.test(first), first || '(no engine call logged)')
}

// ------------------------------------------- B. resolve adopts a merge nobody recorded

{
  const f = fixture('unrecorded-merge')
  const a = f.claim('', 'writer', '--prefer', 'a')
  identity(a.dir)
  commit(a.dir, 'app.js', 'console.log("lane")\n', 'feat: lane side')
  commit(f.repo, 'app.js', 'console.log("master")\n', 'feat: master side')
  // The lane's chat is gone and a merge is left open in its folder, with nothing recorded.
  f.patchState((s) => delete s.lanes.a)
  try {
    git(a.dir, 'merge', '--no-edit', 'master')
  } catch {
    /* the conflict is the point */
  }
  ok('B: (setup) the worktree has a merge open', existsSync(join(git(a.dir, 'rev-parse', '--git-dir'), 'MERGE_HEAD')))
  ok('B: (setup) and the ledger has no conflict for it', !f.state().conflicts.a, JSON.stringify(f.state().conflicts))
  const r = f.lane('', 'resolve', '--session', 'fixer', '--lane', 'a')
  ok('B: resolve takes the open merge over instead of "not conflicted"', r.ok && /merge open/.test(r.out) && /app\.js/.test(r.out), r.out || r.err)
  ok('B: the conflict is recorded with this chat as resolver', f.state().conflicts.a?.resolver === 'fixer', JSON.stringify(f.state().conflicts))
  const write = f.lane('', 'guard', '--session', 'fixer', '--path', join(a.dir, 'app.js'))
  ok('B: and the guard lets the resolver write there', write.ok, write.out || write.err)
  // A lane with no merge open is still not conflicted.
  const b = f.claim('', 'other', '--prefer', 'b')
  f.patchState((s) => delete s.lanes.b)
  const none = f.lane('', 'resolve', '--session', 'fixer', '--lane', 'b')
  ok('B: a lane with no merge open is still "not conflicted"', !none.ok && /not conflicted/.test(none.err), none.err || none.out)
  void b
}

// ------------------------------------------- C. identical dirt in main does not hold a merge

function readyLane(f, file, text) {
  f.claim('', 'sess-main', '--prefer', 'main')
  const work = f.claim('', 'sess-b', '--prefer', 'b')
  identity(work.dir)
  commit(work.dir, file, text, `feat: ${file}`)
  return work
}
const landed = (f, file) => git(f.repo, 'log', '--oneline', 'master').includes(`feat: ${file}`)

{
  const f = fixture('same-bytes', { release: 'merge', origin: true })
  const text = JSON.stringify({ name: 'same-bytes', version: '0.0.1', deps: { x: 1 } }, null, 2) + '\n'
  readyLane(f, 'package.json', text)
  // The same edit, uncommitted in main - byte for byte what the lane brings.
  writeFileSync(join(f.repo, 'package.json'), text)
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('C: identical uncommitted bytes in main do not hold the merge', landed(f, 'package.json'), done.out || done.err)
  ok('C: and main ends clean with the lane\'s bytes', git(f.repo, 'status', '--porcelain') === '' && readFileSync(join(f.repo, 'package.json'), 'utf8') === text, git(f.repo, 'status', '--porcelain'))
}

{
  const f = fixture('same-new-file', { release: 'merge', origin: true })
  readyLane(f, 'added.js', 'export const added = 1\n')
  writeFileSync(join(f.repo, 'added.js'), 'export const added = 1\n')
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('C: an identical untracked copy of a file the lane adds does not hold it either', landed(f, 'added.js'), done.out || done.err)
}

{
  const f = fixture('different-bytes', { release: 'merge', origin: true })
  readyLane(f, 'app.js', 'console.log("lane")\n')
  writeFileSync(join(f.repo, 'app.js'), 'console.log("somebody else")\n')
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('C: different bytes still hold the merge', !landed(f, 'app.js') && /uncommitted edits to app\.js/.test(done.out), done.out || done.err)
  ok('C: and the edit is left exactly where it was', readFileSync(join(f.repo, 'app.js'), 'utf8') === 'console.log("somebody else")\n')
}

// ------------------------------------------- F. a lane whose work main already has is not "conflicted"

{
  // taskdriver.ai 2026-09-28 8:45am: lanes c and d each held one commit that main already
  // had under a rebased sha (`git cherry` '-'), and main had edited that file since. Every
  // release merged main into them to catch them up, hit add/add, and printed "Lane c is
  // finished but conflicts with main ... retried every 10m" for a lane with nothing to ship.
  const f = fixture('already-on-main', { release: 'merge', origin: true })
  const c = f.claim('', 'sess-c', '--prefer', 'c')
  identity(c.dir)
  commit(c.dir, 'seo.md', 'groundwork\n', 'seo: groundwork')
  const sha = git(c.dir, 'rev-parse', 'HEAD')
  f.patchState((s) => {
    delete s.lanes.c
    delete s.ready.c
  })
  // Rebased onto a newer main, so main holds the same change under another sha.
  commit(f.repo, 'later.js', 'export const later = 1\n', 'feat: later on main')
  git(f.repo, 'cherry-pick', sha)
  commit(f.repo, 'seo.md', 'groundwork\nmore since\n', 'seo: more')
  const marks = git(f.repo, 'cherry', 'master', 'lane-c')
  ok('F: (setup) lane c\'s commit is on main under another sha', marks === `- ${sha}`, marks)
  readyLane(f, 'other.js', 'export const other = 1\n')
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('F: the release goes out', landed(f, 'other.js'), done.out || done.err)
  ok('F: and does not call lane c conflicted', !/Lane c .*conflicts/.test(done.out) && !f.state().conflicts.c, done.out)
  let caughtUp = true
  try {
    git(c.dir, 'merge-base', '--is-ancestor', 'master', 'HEAD')
  } catch {
    caughtUp = false
  }
  ok('F: lane c is brought up to main instead', caughtUp && readFileSync(join(c.dir, 'seo.md'), 'utf8') === 'groundwork\nmore since\n', git(c.dir, 'log', '--oneline', '-3'))
  ok('F: with its folder clean', git(c.dir, 'status', '--porcelain') === '', git(c.dir, 'status', '--porcelain'))
}

{
  // The rule is "nothing of its own", not "behind": a lane with one commit main lacks and
  // a real disagreement is still a conflict, and keeps its commit.
  const f = fixture('own-work-conflict', { release: 'merge', origin: true })
  const c = f.claim('', 'sess-c', '--prefer', 'c')
  identity(c.dir)
  commit(c.dir, 'app.js', 'console.log("lane c")\n', 'feat: lane c')
  const tip = git(c.dir, 'rev-parse', 'HEAD')
  f.patchState((s) => {
    delete s.lanes.c
    delete s.ready.c
  })
  commit(f.repo, 'app.js', 'console.log("main")\n', 'feat: main')
  readyLane(f, 'other.js', 'export const other = 1\n')
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('F: a lane with its own clashing commit is still reported conflicted', /Lane c .*conflicts/.test(done.out), done.out || done.err)
  ok('F: and keeps that commit', git(c.dir, 'rev-parse', 'HEAD') === tip, git(c.dir, 'log', '--oneline', '-3'))
}

/** Lane c: one commit main already has under another sha, then (withMerge) a merge commit
 * whose side commit main also has but which adds evil.txt of its own - cherry skips merges,
 * so aheadOf reads 0 while the lane still holds something main lacks. Main then edits the
 * lane's file, so merging main into the lane conflicts. */
function staleLane(f, { withMerge = false } = {}) {
  const c = f.claim('', 'sess-c', '--prefer', 'c')
  identity(c.dir)
  commit(c.dir, 'seo.md', 'groundwork\n', 'seo: groundwork')
  const picks = [git(c.dir, 'rev-parse', 'HEAD')]
  if (withMerge) {
    git(c.dir, 'checkout', '-q', '-b', 'side')
    commit(c.dir, 'side.js', 'export const side = 1\n', 'feat: side')
    picks.push(git(c.dir, 'rev-parse', 'HEAD'))
    git(c.dir, 'checkout', '-q', 'lane-c')
    git(c.dir, 'merge', '--no-ff', '--no-commit', 'side')
    writeFileSync(join(c.dir, 'evil.txt'), 'only in the merge\n')
    git(c.dir, 'add', '-A')
    git(c.dir, 'commit', '-qm', 'merge side, with a fix of its own')
  }
  f.patchState((s) => delete s.lanes.c)
  commit(f.repo, 'later.js', 'export const later = 1\n', 'feat: later on main')
  for (const sha of picks) git(f.repo, 'cherry-pick', sha)
  commit(f.repo, 'seo.md', 'groundwork\nmore since\n', 'seo: more')
  return c
}
const mergeOpen = (dir) => existsSync(join(git(dir, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))
const openMerge = (dir) => {
  try {
    git(dir, 'merge', '--no-edit', 'master')
  } catch {
    /* the conflict is the point */
  }
}

{
  // A merge commit is work of its own: F must not throw it away.
  const f = fixture('merge-of-its-own', { release: 'merge', origin: true })
  const c = staleLane(f, { withMerge: true })
  const tip = git(c.dir, 'rev-parse', 'HEAD')
  ok('F: (setup) aheadOf would read 0 for a lane whose own work is a merge', git(f.repo, 'cherry', 'master', 'lane-c').split('\n').every((l) => l.startsWith('-')), git(f.repo, 'cherry', 'master', 'lane-c'))
  readyLane(f, 'other.js', 'export const other = 1\n')
  const done = f.lane('', 'ready', '--session', 'sess-b')
  ok('F: a lane with a merge commit of its own is not reset to main', git(c.dir, 'rev-parse', 'HEAD') === tip && existsSync(join(c.dir, 'evil.txt')), `${done.out}\n${git(c.dir, 'log', '--oneline', '-3')}`)
}

{
  // Card 2, 8:40am: lane c's commit already on main, a merge left open in its folder.
  // `resolve --lane c` handed the merge to a chat holding lane a; the next lane command
  // dropped the record (nothing ahead) and the guard refused the commit that finishes it.
  // With nothing of its own there is nothing to resolve: resolve puts the lane on main.
  const f = fixture('open-merge-nothing-own')
  const c = staleLane(f)
  f.claim('', 'fixer', '--prefer', 'a')
  openMerge(c.dir)
  ok('G: (setup) a merge is open in lane c', mergeOpen(c.dir))
  const r = f.lane('', 'resolve', '--session', 'fixer', '--lane', 'c')
  ok('G: resolve on a lane with nothing of its own says so', r.ok && /nothing master does not already have/.test(r.out), r.out || r.err)
  let atMain = true
  try {
    git(c.dir, 'merge-base', '--is-ancestor', 'master', 'HEAD')
  } catch {
    atMain = false
  }
  ok('G: and puts it on main, merge closed, folder clean', atMain && !mergeOpen(c.dir) && git(c.dir, 'status', '--porcelain') === '' && git(c.dir, 'rev-parse', 'HEAD') === git(f.repo, 'rev-parse', 'master'), git(c.dir, 'log', '--oneline', '-3'))
  ok('G: with no conflict left on it', !f.state().conflicts.c, JSON.stringify(f.state().conflicts))
}

{
  // The same open merge on a lane whose own work is a merge commit (aheadOf 0, but not
  // nothing): the resolver must keep the lane through later lane commands and finish it.
  const f = fixture('open-merge-own-merge')
  const c = staleLane(f, { withMerge: true })
  f.claim('', 'fixer', '--prefer', 'a')
  openMerge(c.dir)
  const r = f.lane('', 'resolve', '--session', 'fixer', '--lane', 'c')
  ok('G: (setup) resolve hands the open merge over', r.ok && f.state().conflicts.c?.resolver === 'fixer', r.out || r.err)
  const laneC = () => {
    const st = f.lane('', 'status', '--session', 'fixer')
    return st.ok ? JSON.parse(st.out).lanes?.find((l) => l.lane === 'c') : null
  }
  const seen = laneC()
  ok('G: a later lane command still calls lane c conflicted while its merge is open', seen?.conflicted === true, JSON.stringify(seen))
  ok('G: and leaves the resolver\'s merge open', mergeOpen(c.dir), git(c.dir, 'status', '--porcelain'))
  const write = f.lane('', 'guard', '--session', 'fixer', '--path', join(c.dir, 'seo.md'))
  ok('G: so the resolver (holding lane a) may still write there', write.ok, write.out || write.err)
  writeFileSync(join(c.dir, 'seo.md'), 'groundwork\nmore since\n')
  git(c.dir, 'add', '-A')
  git(c.dir, 'commit', '-q', '--no-edit')
  const done = f.lane('', 'ready', '--session', 'fixer', '--lane', 'c')
  const after = laneC()
  ok('G: and finish it with ready --lane c, its own fix kept', done.ok && after?.conflicted === false && existsSync(join(c.dir, 'evil.txt')), `${done.out || done.err}\n${JSON.stringify(after)}`)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
if (!failed) rmSync(root, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
