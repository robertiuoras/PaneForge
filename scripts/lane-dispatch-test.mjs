// A conflict nobody is going to settle opens a chat of its own.
//
// Robert pasted "lane a is conflicted ... take it over" about twenty times between
// 2026-08-18 and 2026-09-24: retry, rerere and autoResolve settle the mechanical conflicts,
// but a real disagreement only ever reached a chat through the prompt hook, i.e. when
// somebody next typed. `retry` now opens ONE resolver pane per such conflict
// (dispatchResolvers). Pinned here, with real git repos and the real lane.mjs:
//
//   - a real conflict whose chat went quiet: exactly one pane request across many ticks,
//     briefed with the exact resolve / ready commands for that lane
//   - a fresh conflict (its chat is still working): no request
//   - a conflict autoResolve settles on the retry: no request, and the conflict is gone
//   - a pane that did not settle it gets another after DISPATCH_AGAIN_MS, three at most
//   - no PaneForge to ask (no pf-ctl beside lane.mjs): nothing requested, nothing recorded
//   - the lane folder gets the repo's Claude Code trust entry, so the pane does not stop
//     on the trust prompt
//
// `LANE_DISPATCH_LOG` stands in for the app; CLAUDE_CONFIG_DIR keeps the trust write in
// the temp folder. `ship` is never reached: a fresh `lastShip` is seeded.
//
//   node scripts/lane-dispatch-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

// Claude Code's config, trusted for the repo only.
const claudeHome = join(root, 'claude-home')
mkdirSync(claudeHome)
const claudeJson = join(claudeHome, '.claude.json')
writeFileSync(claudeJson, JSON.stringify({ projects: { [realpathSync(repo)]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'], history: ['private'] } } }))

const dispatchLog = join(root, 'dispatch.jsonl')
const lane = (args, extraEnv = {}) => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, LANE_DISPATCH_LOG: dispatchLog, ...extraEnv }
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
ok('a fresh conflict, its chat still working: no chat opened', requests().length === 0, JSON.stringify(requests()))

// ---------------------------------------------------- ...that chat goes quiet

quiet(work.lane)
retryTimes(4)
const reqs = requests()
ok('a quiet real conflict opens exactly one chat across four ticks', reqs.length === 1, JSON.stringify(reqs))
const r = reqs[0] ?? {}
ok('in that lane\'s folder', r.dir === work.dir, r.dir)
ok('briefed with the exact resolve command for that lane', new RegExp(`resolve --repo "[^"]*demo" --session .* --lane ${work.lane}`).test(r.prompt ?? ''), r.prompt)
ok('and the ready command that finishes it', new RegExp(`ready --repo .* --lane ${work.lane}`).test(r.prompt ?? ''), r.prompt)
ok('naming the file that disagrees', /src\/page\.ts/.test(r.prompt ?? ''), r.prompt)
ok('and forbidding a release', /Never cut or publish a release/.test(r.prompt ?? ''), r.prompt)
const d = state().conflicts[work.lane]?.dispatch
ok('the state records the chat, so no tick opens a second', d?.tries === 1 && typeof d.at === 'number', JSON.stringify(d))
const trust = JSON.parse(readFileSync(claudeJson, 'utf8')).projects[realpathSync(work.dir)]
ok('the lane folder inherits the repo\'s trust, so the pane does not stop on the trust prompt', trust?.hasTrustDialogAccepted === true && trust.allowedTools?.[0] === 'Bash(ls:*)', JSON.stringify(trust))
ok('but not the repo\'s prompt history', trust && !('history' in trust), JSON.stringify(trust))

// ---------------------------------------------------- the chat did not settle it

patchState((s) => { s.conflicts[work.lane].dispatch.at = Date.now() - 3 * 60 * 60 * 1000 })
retryTimes(2)
ok('two hours on and still conflicted: one more chat, not two', requests().length === 2, JSON.stringify(requests().map((x) => x.lane)))
patchState((s) => { s.conflicts[work.lane].dispatch.at = Date.now() - 3 * 60 * 60 * 1000 })
lane(['retry'])
patchState((s) => { s.conflicts[work.lane].dispatch.at = Date.now() - 3 * 60 * 60 * 1000 })
retryTimes(2)
ok('three chats at most, then it is a person\'s to read', requests().length === 3 && state().conflicts[work.lane]?.dispatch?.tries === 3, JSON.stringify(state().conflicts[work.lane]?.dispatch))

// ---------------------------------------------------- a resolver already holds it

patchState((s) => {
  s.conflicts[work.lane].dispatch = null
  s.conflicts[work.lane].resolver = 'sess-fixer'
  s.conflicts[work.lane].resolverAt = Date.now()
})
retryTimes(2)
ok('a conflict a chat already adopted gets no second chat', requests().length === 3, JSON.stringify(requests().map((x) => x.lane)))

// ---------------------------------------------------- no PaneForge to ask

patchState((s) => {
  s.conflicts[work.lane].resolver = null
  s.conflicts[work.lane].resolverAt = null
})
retryTimes(2, { LANE_DISPATCH_LOG: undefined })
ok('with no pf-ctl beside lane.mjs nothing is requested', requests().length === 3)
ok('and nothing is recorded, so a later tick with an app still opens one', !state().conflicts[work.lane]?.dispatch, JSON.stringify(state().conflicts[work.lane]?.dispatch))

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
ok('an import collision autoResolve settles opens no chat', requests().slice(before).filter((x) => x.lane === mech.lane).length === 0, JSON.stringify(requests().map((x) => x.lane)))
ok('and the conflict is gone', !state().conflicts[mech.lane], JSON.stringify(state().conflicts[mech.lane]))
ok('with both imports kept', /import \{ b \}/.test(readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8')) && /import \{ c \}/.test(readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8')), readFileSync(join(mech.dir, 'src/mod.ts'), 'utf8'))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
