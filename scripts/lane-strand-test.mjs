// Regression test: a chat cleared with /clear gets back the lane its previous session held
// (2026-10-04, PaneForge on the Mac).
//
// The pane held lane a with a pushed commit and six uncommitted files. Robert typed /clear.
// SessionEnd stamped the hold ended and started its detached `release`, which finished before
// the pane's next prompt and DELETED the hold: a dirty lane is never marked ready, but it was
// still given up. The pane's new chat then had nothing to carry (claim's pane carry needs the
// ended hold to still exist), and the hook asked for no lane at all: the pane's cwd was
// spelled `paneforge-a` while git reported the repository as `PaneForge`, so the hook's
// case-sensitive compare found no lane folder in the cwd (`--prefer` missing) and called a
// home chat a visitor (`--visitor`). The chat was sent to lane b; lane a sat unheld and
// dirty, every write to it refused, and the completion dispatcher could not take it either.
//
// Real git repos in the temp folder, the real lane.mjs and lane-hook.mjs, no stubs except
// where a test only reads which engine commands the hook runs.
//
//   node scripts/lane-strand-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// The real path: on macOS the temp folder is reached through a link (`/var` ->
// `/private/var`) and git names repositories by the far end, which is a different mismatch
// from the one under test (case).
const root = join(realpathSync(tmpdir()), 'paneforge-lane-strand-test')
rmSync(root, { recursive: true, force: true })
// The hook remembers what it told each session in the system temp folder for 30 minutes
// (`toldFile`), keyed by session id and repo path. Both repeat across runs here, so a rerun
// within the half hour was told nothing and the "the hook tells it" checks failed. Every
// hook and engine run in this test gets a temp folder that dies with the run.
const hookTmp = join(root, 'tmp')
mkdirSync(hookTmp, { recursive: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** The same folder spelled in lower case - how the pane's Claude Code cwd read. */
const lower = (p) => join(dirname(p), basename(p).toLowerCase())

function fixture(name, pool = ['main', 'a', 'b', 'c'], extraEnv = {}) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  // `lanes: true` because the repo has no remote, which the hook otherwise reads as a scratch
  // folder that gets no lanes.
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, pool }, null, 2) + '\n')
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  // On Windows the hook starts its detached release through this file beside it; without it
  // wscript is handed a missing script and the release never runs (PC, 2026-10-09: section
  // G's release never wrote; the app ships it beside the hook, package.json extraResources).
  copyFileSync(join(here, 'run-hidden.vbs'), join(repo, 'scripts', 'run-hidden.vbs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')

  const env = (pane) => ({ ...process.env, PF_PANE: pane, PF_RELEASE: 'version', PANEFORGE_REPO: repo, LANE_REGISTRY: join(root, `${name}.registry.json`), TMPDIR: hookTmp, TMP: hookTmp, TEMP: hookTmp, ...extraEnv })
  /** `pane` is the PF_PANE the app gives every chat it starts; '' is a chat outside it. */
  const lane = (pane, ...args) => {
    try {
      return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env: env(pane) }).trim() }
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lanes: {}, ready: {}, conflicts: {} })
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
  /**
   * A prompt through the real UserPromptSubmit hook: Claude Code's own input, with the
   * transcript under the project folder Claude Code names after the cwd it was given.
   */
  const hook = (event, pane, session, cwd, more = {}) => {
    const transcript = join(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${session}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    if (!existsSync(transcript)) writeFileSync(transcript, '')
    try {
      return execFileSync(process.execPath, [join(repo, 'scripts', 'lane-hook.mjs'), `--event=${event}`], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        input: JSON.stringify({ session_id: session, cwd, transcript_path: transcript, ...more }),
        env: env(pane)
      })
    } catch (e) {
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }
  const prompt = (pane, session, cwd) => hook('prompt', pane, session, cwd, { prompt: 'carry on' })
  /**
   * SessionEnd for `/clear` as the hook runs it - the hold stamped ended in-line, then the
   * release - in the order measured on 2026-10-04: the release finished first, before the
   * pane's next prompt. (That the hook passes `--cleared` for reason "clear" is pinned in
   * section E.)
   */
  const cleared = (pane, session) => {
    lane(pane, 'park', '--session', session, '--ended')
    return lane(pane, 'release', '--session', session, '--cleared')
  }
  // No release attempts in a repo with no remote.
  patchState((s) => (s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }))
  /** A write through the real PreToolUse hook; its stdout is the hook's verdict (empty = allowed). */
  const pretool = (pane, session, file) => {
    try {
      return execFileSync(process.execPath, [join(repo, 'scripts', 'lane-hook.mjs'), '--event=pretool'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
        input: JSON.stringify({ session_id: session, cwd: repo, tool_name: 'Edit', tool_input: { file_path: file } }),
        env: env(pane)
      })
    } catch (e) {
      return `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }
  return { repo, lane, state, patchState, claim, laneOf, hook, prompt, cleared, pretool, statePath }
}

const identity = (dir) => {
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
}
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

/** Lane a held by `session` in `pane`, with a commit of its own and (dirty) an uncommitted file. */
function heldWithWork(f, pane, session, { dirty = true } = {}) {
  const a = f.claim(pane, session, '--cwd', f.repo, '--prefer', 'a')
  identity(a.dir)
  commit(a.dir, 'feature.js', 'export const half = 1\n', 'feat: committed half')
  if (dirty) writeFileSync(join(a.dir, 'wip.js'), 'the other half, uncommitted\n')
  return a
}

// The case checks need a file system that ignores case (macOS, Windows - where this runs).
const probe = fixture('CaseProbe')
const caseBlind = existsSync(lower(probe.repo))
if (!caseBlind) console.log('skip  this file system is case-sensitive: different-case cwd checks below use the real spelling')
const variant = (p) => (caseBlind ? lower(p) : p)

// ------------------------------------------- A. the measured sequence

{
  const f = fixture('Strand')
  const a = heldWithWork(f, 'pane-p', 'before-clear')
  const end = f.cleared('pane-p', 'before-clear')
  ok('A: (setup) SessionEnd ran', end.ok, end.err || end.out)
  const said = f.prompt('pane-p', 'after-clear', variant(a.dir))
  const hold = f.state().lanes.a
  ok('A: the cleared pane\'s next chat holds lane a again (cwd spelled in another case)', f.laneOf('after-clear') === 'a', `${said.trim()}\n${JSON.stringify(f.state().lanes)}`)
  ok('A: as a home chat, not a visitor', hold?.session === 'after-clear' && !hold.visitor, JSON.stringify(hold))
  ok('A: the old session id holds nothing', !f.laneOf('before-clear'), JSON.stringify(f.state().lanes))
  ok('A: its uncommitted file and its commit are untouched', existsSync(join(a.dir, 'wip.js')) && git(a.dir, 'log', '--oneline', '-1').includes('committed half'))
  const write = f.lane('pane-p', 'guard', '--session', 'after-clear', '--path', join(a.dir, 'wip.js'))
  ok('A: and it may write in its own folder', write.ok, write.out || write.err)
}

{
  // The carry is by pane, not by folder: the taskdriver.ai pane (2026-10-03) sat in the main
  // checkout and worked in lane b, and its next chat prompted from the main checkout.
  const f = fixture('Elsewhere')
  heldWithWork(f, 'pane-p', 'before-clear')
  f.cleared('pane-p', 'before-clear')
  const said = f.prompt('pane-p', 'after-clear', f.repo)
  ok('A: a next chat prompting from the main checkout still gets lane a back', f.laneOf('after-clear') === 'a', `${said.trim()}\n${JSON.stringify(f.state().lanes)}`)
}

{
  // Committed and not ready is unfinished too: /clear is not "I am done, ship it".
  const f = fixture('CleanAhead')
  heldWithWork(f, 'pane-p', 'before-clear', { dirty: false })
  f.cleared('pane-p', 'before-clear')
  ok('A: a cleared chat\'s committed, unready work is not marked ready on the way out', !f.state().ready.a, JSON.stringify(f.state().ready))
  f.prompt('pane-p', 'after-clear', variant(join(f.repo + '-a')))
  ok('A: and the pane\'s next chat holds that lane', f.laneOf('after-clear') === 'a', JSON.stringify(f.state().lanes))
}

// ------------------------------------------- B. nobody else takes it

{
  const f = fixture('Others')
  const a = heldWithWork(f, 'pane-p', 'before-clear')
  f.cleared('pane-p', 'before-clear')
  // Another pane opened standing in the lane's folder: the hook asks for lane a by folder.
  f.prompt('pane-q', 'other-pane', variant(a.dir))
  ok('B: a different pane standing in the folder is not handed the cleared pane\'s dirty lane', f.laneOf('other-pane') !== 'a' && f.state().lanes.a?.session === 'before-clear', JSON.stringify(f.state().lanes))
  const loose = f.claim('', 'no-pane', '--cwd', a.dir, '--prefer', 'a')
  ok('B: nor is a chat outside the app that asks for it by name', loose.lane !== 'a' && f.state().lanes.a?.session === 'before-clear', JSON.stringify(loose))
  const auto = f.claim('pane-r', 'third-pane', '--cwd', f.repo)
  ok('B: nor any automatic claim', auto.lane !== 'a', JSON.stringify(auto))
  f.prompt('pane-p', 'after-clear', variant(a.dir))
  ok('B: the cleared pane\'s own next chat still gets it', f.laneOf('after-clear') === 'a', JSON.stringify(f.state().lanes))
}

// ------------------------------------------- C. what is not a /clear is unchanged

{
  // The pane closed (SessionEnd with any other reason) and its hold names no card: the dirty
  // lane is given up exactly as before, and stays out of every automatic choice. (A hold
  // that names its card is kept for it: lane-repane-test.)
  const f = fixture('Closed')
  heldWithWork(f, 'pane-p', 'closing')
  f.lane('pane-p', 'park', '--session', 'closing', '--ended')
  f.lane('pane-p', 'release', '--session', 'closing', '--closed')
  ok('C: a chat that ended without /clear gives its hold up', !f.state().lanes.a, JSON.stringify(f.state().lanes))
  const auto = f.claim('pane-q', 'next', '--cwd', f.repo)
  ok('C: and its dirty lane is no automatic claim\'s', auto.lane !== 'a', JSON.stringify(auto))
}

{
  // The app's sweep found no window hosting the cleared pane: the kept hold goes.
  const f = fixture('Gone')
  heldWithWork(f, 'pane-p', 'before-clear')
  f.cleared('pane-p', 'before-clear')
  ok('C: (setup) the cleared hold is kept for its pane', f.state().lanes.a?.session === 'before-clear' && f.state().lanes.a?.ended, JSON.stringify(f.state().lanes))
  f.lane('pane-p', 'release', '--session', 'before-clear', '--gone')
  ok('C: a cleared pane nobody has open any more lets it go', !f.state().lanes.a, JSON.stringify(f.state().lanes))
}

{
  // Nothing in the lane: /clear gives it back as before, so the app can move an empty pane home.
  const f = fixture('Empty')
  f.claim('pane-p', 'before-clear', '--cwd', f.repo, '--prefer', 'a')
  f.cleared('pane-p', 'before-clear')
  ok('C: a cleared chat\'s EMPTY lane is still given back', !f.state().lanes.a, JSON.stringify(f.state().lanes))
}

{
  // A hold no pane wore (claimed outside the app) is nobody's to keep.
  const f = fixture('NoPane')
  heldWithWork(f, '', 'outside')
  f.cleared('', 'outside')
  ok('C: a cleared hold with no pane is given up as before', !f.state().lanes.a, JSON.stringify(f.state().lanes))
}

// ------------------------------------------- D. another chat's lane through another spelling

{
  // The write guard matched lane folders by exact string, so a path typed in another case
  // (the same folder on macOS and Windows) belonged to no lane and was let through.
  const f = fixture('Guard')
  const a = f.claim('pane-p', 'owner', '--cwd', f.repo, '--prefer', 'a')
  f.claim('pane-q', 'other', '--cwd', f.repo)
  const file = join(variant(a.dir), 'app.js')
  const engine = f.lane('pane-q', 'guard', '--session', 'other', '--path', file)
  ok('D: the engine refuses a write into another chat\'s lane spelled in another case', !engine.ok && /\S/.test(engine.out), `${engine.ok ? 'allowed' : 'refused'}: ${engine.out || engine.err || '(no output)'}`)
  const hook = f.pretool('pane-q', 'other', file)
  ok('D: and so does the PreToolUse hook', /"permissionDecision":\s*"deny"/.test(hook), hook.trim() || '(hook printed nothing: allowed)')
  const own = f.pretool('pane-p', 'owner', file)
  ok('D: the lane\'s own chat may still write there in that spelling', !/"deny"/.test(own), own.trim())
}

{
  // The same heads-up (`overlap`) for a write through a differently spelled path: the lane
  // folder is found by folded prefix and the part below it is cut from the ORIGINAL path.
  const f = fixture('Overlap')
  const a = f.claim('pane-p', 'owner', '--cwd', f.repo, '--prefer', 'a')
  f.claim('pane-q', 'other', '--cwd', f.repo, '--prefer', 'main')
  writeFileSync(join(a.dir, 'app.js'), 'console.log(2)\n')
  git(a.dir, 'commit', '-qam', 'lane a edits app.js')
  const warn = f.lane('pane-q', 'guard', '--session', 'other', '--path', variant(join(f.repo, 'app.js')))
  ok('D: a write through another spelling still gets the other-lane heads-up', warn.ok && /lane a/.test(warn.out), warn.out || warn.err || '(no output)')
}

// ------------------------------------------- F. a lane kept for a recovery nobody can start

{
  // The same pane's first prompt after /clear failed outright: the pool picked lane c, whose
  // recovery item is `blocked` and whose folder is gone, and `preservedCheckout` threw for
  // the whole claim. The pool must pass such a lane over; asked for by name it still refuses.
  // (c listed before a so the pool reaches it first, as it did on the Mac.)
  const f = fixture('Kept', ['main', 'c', 'a'])
  writeFileSync(
    join(f.repo, '.git', 'paneforge-recovery.json'),
    JSON.stringify({ items: { 'c-old': { lane: 'c', status: 'blocked', commit: 'deadbeef'.repeat(5), owner: 'long-gone', at: Date.now() } } }, null, 2) + '\n'
  )
  f.claim('pane-1', 'first', '--cwd', f.repo, '--prefer', 'main')
  const next = f.claim('pane-2', 'second', '--cwd', f.repo)
  ok('F: a new chat is given a working lane, not the recovery\'s broken one', next.lane === 'a', JSON.stringify(next))
  const asked = f.claim('pane-3', 'third', '--cwd', f.repo, '--prefer', 'c')
  ok('F: asking for that lane by name is still refused (no automatic repair)', asked.lane !== 'c' && !existsSync(`${f.repo}-c`) && /preserved recovery checkout/.test(String(asked.error)), JSON.stringify(asked))
}

// ------------------------------------------- G. a chat living in another linked worktree

{
  // 2026-10-09 9:16am, taskdriver.ai on the Mac: the pane's cwd was
  // `taskdriver-client-monitoring`, a linked worktree of the repo on its own branch and none
  // of the lane folders. The hook calls such a chat a visitor (its transcript lives under
  // another project folder) and hands it a letter lane; it left uncommitted edits in lane a.
  // The Stop hook's auto-clear typed /clear, the pane's next chat was sent to lane b, lane a
  // sat unheld and dirty, and the completion dispatcher spent two recovery chats on it.
  // Everything here goes through the real hooks: Stop, SessionEnd (reason "clear", its
  // detached release waited for), then the next chat's first prompt from the same folder.
  const base = join(root, 'Foreign-app')
  mkdirSync(base, { recursive: true })
  const panes = join(base, 'panes.txt')
  const processes = join(base, 'processes.json')
  const dispatched = join(base, 'completion.log')
  writeFileSync(processes, '[]')
  const f = fixture('Foreign', ['main', 'a', 'b', 'c'], { LANE_PANES_FILE: panes, LANE_PROCESSES_FILE: processes, LANE_COMPLETION_LOG: dispatched })
  const foreign = join(root, 'client-monitoring')
  git(f.repo, 'worktree', 'add', '-q', '-b', 'fix/client-monitoring', foreign)
  // The app's word on which chats are alive and which pane sits where (dispatchCompletion).
  const alive = (...chats) => {
    mkdirSync(join(f.repo, '.git', 'paneforge-panes'), { recursive: true })
    writeFileSync(join(f.repo, '.git', 'paneforge-panes', `pf-${process.pid}.json`), JSON.stringify({ at: Date.now(), chats }))
    writeFileSync(panes, `1\tpane-m\tidle\tmain\t${f.repo}\n2\tpane-p\tidle\tclient monitoring\t${foreign}\n`)
  }
  const recoveryOf = (id) => {
    const p = join(f.repo, '.git', 'paneforge-recovery.json')
    const items = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).items ?? {} : {}
    return Object.values(items).filter((r) => r.lane === id)
  }
  const sent = () => (existsSync(dispatched) ? readFileSync(dispatched, 'utf8').trim() : '')
  const dispatchedFor = (id) => sent().split('\n').filter((l) => l.includes(`"key":"lane:${id}:`))

  // Somebody else is in the main copy, as on the desk that morning.
  f.claim('pane-m', 'main-chat', '--cwd', f.repo, '--prefer', 'main')
  f.prompt('pane-p', 'before-clear', foreign)
  const held = f.laneOf('before-clear')
  ok('G: (setup) the chat in the other linked worktree is handed a lane', held === 'a', JSON.stringify(f.state().lanes))
  writeFileSync(join(`${f.repo}-a`, 'wip.js'), 'intent.ts edits, uncommitted\n')
  f.hook('stop', 'pane-p', 'before-clear', foreign)

  // SessionEnd: the hold is stamped ended in-line, then the release runs detached. The
  // release's own write is the last change to the ledger; wait (bounded) for it.
  const before = statSync(f.statePath).mtimeMs
  f.hook('end', 'pane-p', 'before-clear', foreign, { reason: 'clear' })
  const afterPark = statSync(f.statePath).mtimeMs
  // Bounded, and the time it took is printed: Mac 475-508 ms (2026-10-09).
  const parkedAt = Date.now()
  let released = false
  for (const until = parkedAt + 30_000; Date.now() < until; ) {
    if (statSync(f.statePath).mtimeMs !== afterPark) { released = Date.now() - parkedAt; break }
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
  }
  ok('G: (setup) SessionEnd stamped the hold and its detached release ran', afterPark !== before && released !== false, `park wrote: ${afterPark !== before}, release wrote: ${released !== false ? `after ${released} ms` : 'not within 30s'}`)
  if (released !== false) console.log(`      (the detached release wrote after ${released} ms)`)
  ok('G: the dirty lane is kept for the pane through /clear', f.state().lanes.a?.session === 'before-clear' && f.state().lanes.a?.pane === 'pane-p', JSON.stringify(f.state().lanes))

  // The app's 1-minute tick between the clear and the next prompt.
  alive('main-chat')
  f.lane('pane-m', 'retry', '--session', 'main-chat')
  ok('G: the completion dispatcher does not take the kept lane before the next chat speaks', !dispatchedFor('a').length && !recoveryOf('a').length, sent() || JSON.stringify(recoveryOf('a')))

  const said = f.prompt('pane-p', 'after-clear', foreign)
  ok('G: the pane\'s next chat, prompting from the same linked worktree, gets lane a back', f.laneOf('after-clear') === 'a', `${said.trim()}\n${JSON.stringify(f.state().lanes)}`)
  ok('G: and the hook tells it lane a, not a fallback', /-a \(branch lane-a\)/.test(said), said.trim() || `(the hook printed nothing) ${JSON.stringify(f.state().lanes.a)}`)
  ok('G: its uncommitted file is still there', existsSync(join(`${f.repo}-a`, 'wip.js')))
  const write = f.pretool('pane-p', 'after-clear', join(`${f.repo}-a`, 'wip.js'))
  ok('G: and it may write to it', !/"deny"/.test(write), write.trim())

  alive('main-chat', 'after-clear')
  f.lane('pane-m', 'retry', '--session', 'main-chat')
  ok('G: no recovery chat is sent at the lane while that chat is alive', !dispatchedFor('a').length && !recoveryOf('a').length, sent() || JSON.stringify(recoveryOf('a')))

  // Control: the same lane with its hold gone (what the incident left) IS dispatched, so the
  // two checks above are not passing because the dispatcher never runs in this fixture.
  f.patchState((s) => delete s.lanes.a)
  alive('main-chat')
  f.lane('pane-m', 'retry', '--session', 'main-chat')
  ok('G: (control) an unheld dirty lane a is offered to the dispatcher', dispatchedFor('a').length === 1, sent() || '(nothing dispatched)')
}

// ------------------------------------------- E. what the hook asks the engine

{
  // The engine beside this hook copy only logs what it was asked.
  const base = join(root, 'hook-only')
  const scripts = join(base, 'scripts')
  mkdirSync(scripts, { recursive: true })
  copyFileSync(join(here, 'lane-hook.mjs'), join(scripts, 'lane-hook.mjs'))
  // Windows starts the detached release through this, from the hook's own folder.
  copyFileSync(join(here, 'run-hidden.vbs'), join(scripts, 'run-hidden.vbs'))
  const log = join(base, 'calls.log')
  writeFileSync(join(scripts, 'lane.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')\n`)
  const repo = join(base, 'MixedCase')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true }) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  git(repo, 'init', '-q', '-b', 'master')
  identity(repo)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', `${repo}-a`)
  const registry = join(base, 'lane-repos.json')
  const hook = (event, input) => {
    try {
      execFileSync(process.execPath, [join(scripts, 'lane-hook.mjs'), `--event=${event}`], {
        cwd: input.cwd,
        input: JSON.stringify(input),
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, LANE_REGISTRY: registry }
      })
    } catch {
      /* the stub prints nothing, so a prompt's JSON parse fails - the log is what is read */
    }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  /** The release is detached: wait (bounded) for the line that starts with `release`. */
  const releaseLine = (session) => {
    const until = Date.now() + 15_000
    for (;;) {
      const line = calls().find((l) => l.startsWith(`release --session ${session} `))
      if (line || Date.now() > until) return line ?? null
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
    }
  }

  for (const [reason, want] of [['clear', true], ['prompt_input_exit', false], [undefined, false]]) {
    const session = `ending-${reason ?? 'none'}`
    writeFileSync(registry, JSON.stringify({ repos: {}, sessions: { [session]: [repo] } }))
    hook('end', { session_id: session, cwd: repo, ...(reason ? { reason } : {}) })
    const line = releaseLine(session)
    ok(`E: SessionEnd (${reason ?? 'no reason'}) ${want ? 'tells' : 'does not tell'} the release the chat was cleared`, Boolean(line) && /\s--cleared\b/.test(line) === want, line ?? '(no release logged within 15s)')
    // Every other end may be the app ending the CLI to reopen the card in a new pane
    // (lane-repane-test): the engine keeps an unfinished hold that names its card.
    ok(`E: SessionEnd (${reason ?? 'no reason'}) ${want ? 'does not tell' : 'tells'} the release the chat was closed`, Boolean(line) && /\s--closed\b/.test(line) === !want, line ?? '(no release logged within 15s)')
  }

  const lowerA = variant(`${repo}-a`)
  const tp = join(base, 'projects', lowerA.replace(/[^A-Za-z0-9-]/g, '-'), 'p.jsonl')
  mkdirSync(dirname(tp), { recursive: true })
  writeFileSync(tp, '')
  writeFileSync(log, '')
  hook('prompt', { session_id: 'case-chat', cwd: lowerA, transcript_path: tp, prompt: 'hi' })
  const claimLine = calls().find((l) => l.startsWith('claim ')) ?? ''
  ok('E: a prompt from the lane folder spelled in another case asks for that lane', /\s--prefer a(\s|$)/.test(claimLine), claimLine || '(no claim logged)')
  ok('E: and is not called a visitor', Boolean(claimLine) && !/\s--visitor\b/.test(claimLine), claimLine || '(no claim logged)')
}

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
