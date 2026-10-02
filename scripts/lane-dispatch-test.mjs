// A conflict nobody is going to settle raises ONE card for a person, and never a chat.
//
// `retry` used to open a resolver pane per such conflict ("Settle lane X"): 11 in the week
// of 21 Sep, 4 more in the next five days, plus take-over nudges typed into unrelated
// chats. Now it raises one card per conflict episode (clashCards). Pinned here, with real
// git repos and the real lane.mjs:
//
//   - a fresh conflict (its chat is still working): nothing
//   - a real conflict whose chat went quiet: exactly one card across many ticks, zero pane
//     requests, naming the file and the resolve command
//   - still conflicted hours later: still one card; a new episode (another `since`): one more
//   - a conflict a resolver adopted: nothing
//   - no notifier on the machine: nothing recorded, so a later tick still raises it
//   - a fixture repo in the temp folder never reaches the real notifier
//   - PF_CTL_NO_APP=1 (no app to ask) still raises the card
//   - a conflict autoResolve settles on the retry: no card, and the conflict is gone
//
// `LANE_DISPATCH_LOG` stands in for GuardDeck's notifier. `ship` is never reached: a fresh
// `lastShip` is seeded.
//
//   node scripts/lane-dispatch-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'paneforge-dispatch-test-'))
process.on('exit', (code) => {
  if (!code) rmSync(root, { recursive: true, force: true })
})

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'src', 'page.ts'), 'export function page() {\n  return "base"\n}\n')
writeFileSync(join(repo, 'src', 'mod.ts'), "import { a } from './a'\n\nexport const x = a\n")
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const dispatchLog = join(root, 'dispatch.jsonl')
const lane = (args, extraEnv = {}) => {
  const env = { ...process.env, LANE_DISPATCH_LOG: dispatchLog, ...extraEnv }
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env }).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const requests = () => (existsSync(dispatchLog) ? readFileSync(dispatchLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}
const quiet = (id) => patchState((s) => { s.lanes[id].seen = Date.now() - 46 * 60 * 1000 })
const retryTimes = (n, env) => { for (let i = 0; i < n; i++) lane(['retry'], env) }

lane(['claim', '--session', 'sess-main'])
patchState((s) => { s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] } })

// ---------------------------------------------------- a real conflict, its chat still working

const work = JSON.parse(lane(['claim', '--session', 'sess-a']).out)
commit(work.dir, 'src/page.ts', 'export function page() {\n  return "after 2h, daily summary"\n}\n', 'lane: page after 2h')
commit(repo, 'src/page.ts', 'export function page() {\n  return "alerts in plain words"\n}\n', 'master: plain words')
const refused = lane(['ready', '--session', 'sess-a'])
ok('the lane that rewrote the same lines is refused', refused.code !== 0 && /page\.ts/.test(refused.err), refused.err)
ok('and its conflict is recorded', Boolean(state().conflicts[work.lane]))

retryTimes(2)
ok('a fresh conflict, its chat still working: no card', requests().length === 0, JSON.stringify(requests()))

// ---------------------------------------------------- ...that chat goes quiet

const panes = () => requests().filter((x) => !x.card || 'prompt' in x)
quiet(work.lane)
retryTimes(4)
const reqs = requests()
ok('a quiet real conflict raises exactly one card across four ticks', reqs.length === 1 && reqs[0].card === true, JSON.stringify(reqs))
ok('and asks for zero panes', panes().length === 0, JSON.stringify(panes()))
const r = reqs[0] ?? {}
ok('the title says what happened in plain words', r.title === 'Two chats changed the same lines in demo', r.title)
ok('the title has no git words in it', !/lane|worktree|branch|merge|conflict/i.test(r.title ?? ''), r.title)
ok('the card names the copy a person sees', /copy \d/.test(r.detail ?? ''), r.detail)
ok('naming the file both sides changed', /src\/page\.ts/.test(r.detail ?? ''), r.detail)
ok('with the exact resolve command for that lane', new RegExp(`resolve --repo "[^"]*demo" --session .* --lane ${work.lane}`).test(r.detail ?? ''), r.detail)
ok('and the ready step that finishes it', new RegExp(`ready --lane ${work.lane}`).test(r.detail ?? ''), r.detail)
const card = state().conflicts[work.lane]?.card
ok('the state records the card for this episode', card?.since === state().conflicts[work.lane]?.since && typeof card.at === 'number', JSON.stringify(card))

// ---------------------------------------------------- still there hours later

patchState((s) => {
  s.conflicts[work.lane].card.at = Date.now() - 5 * 60 * 60 * 1000
  s.conflicts[work.lane].retryAt = 0
})
retryTimes(3)
ok('still conflicted hours later: still one card', requests().length === 1, JSON.stringify(requests()))

// A new episode: the conflict cleared and came back, so its `since` is another one.
patchState((s) => { s.conflicts[work.lane].since = Date.now() - 60 * 60 * 1000 })
retryTimes(3)
ok('a new conflict episode raises one more card, not more', requests().length === 2 && panes().length === 0, JSON.stringify(requests()))

// ---------------------------------------------------- a resolver already holds it

patchState((s) => {
  s.conflicts[work.lane].since = Date.now() - 30 * 60 * 1000
  s.conflicts[work.lane].resolver = 'sess-fixer'
  s.conflicts[work.lane].resolverAt = Date.now()
})
retryTimes(2)
ok('a conflict a chat already adopted raises no card', requests().length === 2, JSON.stringify(requests().map((x) => x.lane)))

// Each invocation is a fresh CLI process, as after an app restart. A resolver that is
// still editing must renew its lease before the retry clock can abort its open merge.
const adopted = lane(['resolve', '--session', 'sess-fixer', '--lane', work.lane])
ok('the resolver resumes the real merge', adopted.code === 0 && Boolean(git(work.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')), adopted.err)
const draft = 'export function page() {\n  return "resolver draft preserving both behaviours"\n}\n'
writeFileSync(join(work.dir, 'src/page.ts'), draft)
patchState((s) => { s.conflicts[work.lane].resolverAt = Date.now() - 46 * 60 * 1000 })
const staleLease = state().conflicts[work.lane].resolverAt
const stranger = lane(['guard', '--session', 'sess-stranger', '--path', join(work.dir, 'src/page.ts')])
ok('an unrelated writer cannot renew or steal the resolver lease', stranger.code !== 0 && state().conflicts[work.lane].resolverAt === staleLease, stranger.err)
const guarded = lane(['guard', '--session', 'sess-fixer', '--path', join(work.dir, 'src/page.ts')])
ok('authorized resolver edits renew the recovery lease', guarded.code === 0 && Date.now() - state().conflicts[work.lane].resolverAt < 60_000, guarded.err)
patchState((s) => { s.conflicts[work.lane].retryAt = 0 })
retryTimes(2)
ok('retry preserves the active resolver merge and draft', existsSync(git(work.dir, 'rev-parse', '--git-path', 'MERGE_HEAD')) && readFileSync(join(work.dir, 'src/page.ts'), 'utf8') === draft && requests().length === 2)
patchState((s) => {
  s.lanes[work.lane].session = 'sess-fixer'
  s.conflicts[work.lane].resolverAt = Date.now() - 46 * 60 * 1000
})
lane(['guard', '--session', 'sess-fixer', '--path', join(work.dir, 'src/page.ts')])
ok('a resolver that also holds the lane renews both leases', Date.now() - state().conflicts[work.lane].resolverAt < 60_000 && Date.now() - state().lanes[work.lane].seen < 60_000)
patchState((s) => { s.lanes[work.lane].session = 'sess-a' })
quiet(work.lane)

// ---------------------------------------------------- nowhere to deliver it

patchState((s) => {
  s.conflicts[work.lane].resolver = null
  s.conflicts[work.lane].resolverAt = null
})
// A HOME with no GuardDeck notifier in it, so nothing on this machine is called either.
const bareHome = join(root, 'bare-home')
mkdirSync(bareHome)
retryTimes(2, { LANE_DISPATCH_LOG: undefined, HOME: bareHome, USERPROFILE: bareHome })
ok('with no notifier on the machine nothing is delivered', requests().length === 2)
ok('and nothing is recorded, so a later tick still raises it', state().conflicts[work.lane]?.card?.since !== state().conflicts[work.lane]?.since, JSON.stringify(state().conflicts[work.lane]?.card))
// A notifier IS installed here, but the repo is a fixture in the temp folder: a test must
// never put a real card on GuardDeck (2026-10-02, two leaked).
const fakeHome = join(root, 'fake-home')
const notifyDir = join(fakeHome, 'Projects', 'claude-memory', 'claude-config')
mkdirSync(notifyDir, { recursive: true })
const notified = join(root, 'notified.txt')
writeFileSync(join(notifyDir, 'notify.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(notified)}, 'card\\n')\n`)
retryTimes(2, { LANE_DISPATCH_LOG: undefined, HOME: fakeHome, USERPROFILE: fakeHome })
ok('a repo in the temp folder never reaches the real notifier', !existsSync(notified) && requests().length === 2, existsSync(notified) ? readFileSync(notified, 'utf8') : '')
retryTimes(2, { PF_CTL_NO_APP: '1' })
ok('with no app to ask (PF_CTL_NO_APP) the card is still raised, once', requests().length === 3 && panes().length === 0, JSON.stringify(requests()))
ok('the old `dispatch` field in a state file is tolerated', (() => {
  patchState((s) => { s.conflicts[work.lane].dispatch = { at: Date.now(), pane: 'p1', tries: 1 } })
  return lane(['retry']).code === 0 && requests().length === 3
})())

// ---------------------------------------------------- a conflict autoResolve settles

const mech = JSON.parse(lane(['claim', '--session', 'sess-b']).out)
ok('a second chat gets its own lane', mech.lane !== work.lane && mech.lane !== 'main', mech.lane)
commit(mech.dir, 'src/mod.ts', "import { a } from './a'\nimport { b } from './b'\n\nexport const x = a\n", 'lane: import b')
commit(repo, 'src/mod.ts', "import { a } from './a'\nimport { c } from './c'\n\nexport const x = a\n", 'master: import c')
// Recorded the way a release that met it would, with its chat gone quiet - so the next
// tick is the first thing to try it again.
patchState((s) => {
  s.conflicts[mech.lane] = { at: Date.now(), since: Date.now() - 3 * 60 * 60 * 1000, dir: mech.dir, detail: 'src/mod.ts', resolver: null, resolverAt: null, dispatch: null, master: '', retryAt: 0 }
  s.lanes[mech.lane].seen = Date.now() - 46 * 60 * 1000
})
const before = requests().length
retryTimes(3)
ok('an import collision autoResolve settles raises no card', requests().slice(before).filter((x) => x.lane === mech.lane).length === 0, JSON.stringify(requests().map((x) => x.lane)))
ok('and the conflict is gone', !state().conflicts[mech.lane], JSON.stringify(state().conflicts[mech.lane]))
ok('with both imports kept', /import \{ b \}/.test(readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8')) && /import \{ c \}/.test(readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8')), readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8'))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
