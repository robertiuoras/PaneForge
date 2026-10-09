// Regression test: a lane claimed by hand from a chat in ANOTHER repository is given back
// at /clear like any other, so the pane's next chat carries it (2026-10-09, videos on the Mac).
//
// Pane dbe2b599 sat in research-lab. Its chat claimed lane b of the videos repo by typing
// `lane.mjs claim --repo videos --prefer b --cwd videos-b` and wrote there only through
// Bash, leaving it dirty with two commits. /clear: lane-hook's SessionEnd gives back only
// the repos in its registry's `sessions[<chat>]`, and only the hook's own prompt and
// PreToolUse paths ever wrote that list - so it held research-lab and not videos. The videos
// hold was never stamped ended, the pane's next chat ran `claim --prefer b` and was handed
// lane c ("standingIn": "b"), and every write to videos-b was refused.
//
// The engine now records the repo itself whenever a claim (registerSession, 5e62edd8) or an
// adopted conflict (`resolve`) gives a chat something to hand back, so SessionEnd finds it
// whichever way it was taken. This file pins the whole round trip through the real hook:
// claim, SessionEnd, the pane's next claim.
//
// Real git repos in the temp folder, the real lane.mjs and lane-hook.mjs, a throwaway
// registry (LANE_REGISTRY). The hook's engine is a pass-through that only logs each call
// as it finishes, so the test can wait for the detached release instead of racing it.
//
//   node scripts/lane-claim-end-test.mjs

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// The real path: git names a repository by the far end of macOS's `/var` link.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-claim-end-test')
rmSync(root, { recursive: true, force: true })
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
const identity = (dir) => {
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
}
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

const registry = join(root, 'lane-repos.json')
writeFileSync(registry, JSON.stringify({ repos: {}, sessions: {} }))
const readRegistry = () => JSON.parse(readFileSync(registry, 'utf8'))
const fold = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? String(p).toLowerCase() : String(p))
const registered = (session, repo) => (readRegistry().sessions?.[session] ?? []).some((r) => fold(r) === fold(repo))

/** A repository with lanes and no remote (`lanes: true`, or the hook reads it as a scratch folder). */
function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, pool: ['main', 'a', 'b', 'c'] }, null, 2) + '\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  identity(repo)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lanes: {}, ready: {}, conflicts: {} })
  const patchState = (fn) => {
    const s = state()
    fn(s)
    writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  // No release attempts in a repo with no remote.
  patchState((s) => (s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }))
  return { repo, state, patchState }
}

const env = (pane) => ({ ...process.env, PF_PANE: pane, PF_RELEASE: 'version', LANE_REGISTRY: registry })

/** `lane.mjs` typed by hand from `cwd` - the chat's own folder, which need not be the repo. */
const lane = (f, pane, cwd, ...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(f.repo, 'scripts', 'lane.mjs'), ...args, '--repo', f.repo], { cwd, encoding: 'utf8', stdio: 'pipe', env: env(pane) }).trim() }
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}
const claim = (f, pane, cwd, session, ...more) => {
  const r = lane(f, pane, cwd, 'claim', '--session', session, ...more)
  return r.ok ? JSON.parse(r.out) : { error: r.err || r.out }
}

// The chat's own project: a different repository from the one whose lane it takes.
const home = join(root, 'research-lab')
mkdirSync(home, { recursive: true })
writeFileSync(join(home, 'notes.md'), 'notes\n')
git(home, 'init', '-q', '-b', 'master')
identity(home)
git(home, 'add', '-A')
git(home, 'commit', '-qm', 'first')

// ------------------------------------------- A. a hand claim survives /clear in its pane

{
  const f = fixture('videos')
  // lane-hook beside an engine that runs the real one and logs each call as it ENDS.
  const hookDir = join(root, 'hook', 'scripts')
  mkdirSync(hookDir, { recursive: true })
  copyFileSync(join(here, 'lane-hook.mjs'), join(hookDir, 'lane-hook.mjs'))
  // Windows starts the detached release through this, from the hook's own folder.
  copyFileSync(join(here, 'run-hidden.vbs'), join(hookDir, 'run-hidden.vbs'))
  const log = join(root, 'hook', 'calls.log')
  writeFileSync(log, '')
  writeFileSync(
    join(hookDir, 'lane.mjs'),
    [
      `import { spawnSync } from 'node:child_process'`,
      `import { appendFileSync } from 'node:fs'`,
      `const args = process.argv.slice(2)`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(join(f.repo, 'scripts', 'lane.mjs'))}, ...args], { stdio: 'inherit' })`,
      `appendFileSync(${JSON.stringify(log)}, args.join(' ') + ' => ' + r.status + '\\n')`,
      `process.exit(r.status ?? 1)`
    ].join('\n') + '\n'
  )
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  const sessionEnd = (pane, session, cwd) => {
    try {
      execFileSync(process.execPath, [join(hookDir, 'lane-hook.mjs'), '--event=end'], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionEnd', reason: 'clear' }),
        env: env(pane)
      })
    } catch {
      /* SessionEnd prints nothing; what it did is read from the ledger */
    }
    // Its release is detached. Wait (bounded) for it to finish, so the next claim is not
    // racing it - but only when SessionEnd started one at all.
    if (!calls().some((l) => l.startsWith(`park --session ${session} --ended`))) return
    const until = Date.now() + 30_000
    while (!calls().some((l) => l.startsWith(`release --session ${session} `)) && Date.now() < until) {
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)'])
    }
  }

  const pane = 'pane-dbe2b599'
  const old = '77889115-c981-4cbb-bac9-100a121fd3d0'
  const next = 'bf17790e-6b9f-42ac-8c7b-bed83d3e8314'
  const b = claim(f, pane, home, old, '--prefer', 'b', '--cwd', `${f.repo}-b`)
  ok('A: a claim typed from another repo\'s chat gets the lane it asked for', b.lane === 'b', JSON.stringify(b))
  // Written through Bash only: no PreToolUse write ever passed the guard.
  identity(b.dir)
  commit(b.dir, 'film.js', 'export const take = 1\n', 'feat: first take')
  writeFileSync(join(b.dir, 'draft.js'), 'export const take = 2\n')
  ok('A: the hand claim is on the list SessionEnd gives back', registered(old, f.repo), JSON.stringify(readRegistry().sessions))

  sessionEnd(pane, old, home)
  const kept = f.state().lanes.b
  ok('A: /clear stamps that hold ended and keeps it for the pane (unfinished work)', kept?.session === old && Boolean(kept?.ended), JSON.stringify(f.state().lanes))
  ok('A: and SessionEnd drops the old chat from its list', !readRegistry().sessions?.[old], JSON.stringify(readRegistry().sessions))

  const after = claim(f, pane, home, next, '--prefer', 'b')
  ok('A: the pane\'s next chat asking for b is handed b, not a stand-in lane', after.lane === 'b' && !after.standingIn, JSON.stringify(after))
  ok('A: with the old chat\'s commit and uncommitted file still there', existsSync(join(b.dir, 'film.js')) && existsSync(join(b.dir, 'draft.js')))
  const write = lane(f, pane, home, 'guard', '--session', next, '--path', join(b.dir, 'draft.js'))
  ok('A: and may write in that folder', write.ok, write.out || write.err)
  ok('A: the carried hold is on the new chat\'s list too, for ITS /clear', registered(next, f.repo), JSON.stringify(readRegistry().sessions))

  // A claim that gets nothing records nothing: every lane is taken.
  const g = fixture('full')
  for (const [i, id] of ['main', 'a', 'b', 'c'].entries()) claim(g, `pane-${i}`, home, `holder-${id}`, '--prefer', id)
  const none = claim(g, 'pane-x', home, 'latecomer')
  ok('A: (setup) every lane of the full repo is held', Boolean(none.error), JSON.stringify(none))
  ok('A: a claim that got no lane is not put on the list', !registered('latecomer', g.repo), JSON.stringify(readRegistry().sessions))
}

// ------------------------------------------- B. an adopted conflict is given back the same way

{
  const f = fixture('merge-left-open')
  const a = claim(f, '', home, 'writer', '--prefer', 'a')
  identity(a.dir)
  commit(a.dir, 'app.js', 'console.log("lane")\n', 'feat: lane side')
  commit(f.repo, 'app.js', 'console.log("master")\n', 'feat: master side')
  // The lane's chat is gone and a merge is left open in its folder.
  f.patchState((s) => delete s.lanes.a)
  try {
    git(a.dir, 'merge', '--no-edit', 'master')
  } catch {
    /* the conflict is the point */
  }
  const r = lane(f, '', home, 'resolve', '--session', 'fixer', '--lane', 'a')
  ok('B: (setup) resolve hands the open merge to this chat', r.ok && f.state().conflicts.a?.resolver === 'fixer', r.out || r.err)
  ok('B: the resolver is on the list SessionEnd gives back', registered('fixer', f.repo), JSON.stringify(readRegistry().sessions))
}

// ------------------------------------------- C. a test's temp repo stays out of the real registry

{
  // Every other lane suite claims in temp-folder repos with no LANE_REGISTRY: those claims
  // must not land in the registry every prompt on the machine reads (here, a stand-in home).
  const f = fixture('no-registry-set')
  const fakeHome = join(root, 'home')
  mkdirSync(join(fakeHome, '.claude'), { recursive: true })
  const real = join(fakeHome, '.claude', 'lane-repos.json')
  writeFileSync(real, JSON.stringify({ repos: {}, sessions: {} }))
  const bare = { ...process.env, PF_PANE: '', PF_RELEASE: 'version', HOME: fakeHome, USERPROFILE: fakeHome }
  delete bare.LANE_REGISTRY
  const out = execFileSync(process.execPath, [join(f.repo, 'scripts', 'lane.mjs'), 'claim', '--session', 'suite-chat', '--prefer', 'a', '--repo', f.repo], { cwd: home, encoding: 'utf8', stdio: 'pipe', env: bare })
  ok('C: (setup) the claim worked', JSON.parse(out).lane === 'a', out)
  ok('C: and wrote nothing into the home registry', !JSON.parse(readFileSync(real, 'utf8')).sessions['suite-chat'], readFileSync(real, 'utf8'))
}

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
