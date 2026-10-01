// A chat working inside a lane COPY of a repo that never gets lanes (`claude-memory`) is
// still a live holder, and a claim must never throw away a merge somebody is finishing.
//
// 2026-10-02, claude-memory: the app opens panes in `claude-memory-b` / `-c`, but the prompt
// hook exits before claiming for that repo (`NEVER`, so the guard never refuses a memory
// write from any chat on the machine). The engine still manages the repo's ledger, so a live
// copy looked abandoned: its WIP commit was marked done, master was merged into it mid-edit
// and the pane's lane was drained the moment its tree went clean.
//
//   1. a prompt from inside an existing copy records a hold on exactly THAT copy, silently
//   2. the main checkout still records nothing and prints nothing, and the repo is never
//      registered with the write guard (a registered repo would start refusing memory writes)
//   3. a copy another chat holds is left alone and no new copy is made for the asker
//   4. a /clear in the same pane carries the copy's hold to the new chat
//   5. a claim never aborts or resets a checkout with a merge open (the staged resolution
//      survives)
//
//   node scripts/lane-never-copy-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Canonicalise /var -> /private/var on macOS so cwd prefixes match what git reports.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'paneforge-lane-never-copy-')))

let failed = 0
const ok = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!condition) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const gitTry = (cwd, ...args) => {
  try {
    return git(cwd, ...args)
  } catch (e) {
    return `ERR ${String(e.stderr ?? e.message).trim()}`
  }
}

/** A repo with a real origin, the engine and the hook installed in it. */
function makeRepo(name) {
  const origin = join(root, `${name}.git`)
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', origin])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }) + '\n')
  writeFileSync(join(repo, 'app.txt'), 'one\n')
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')
  return repo
}

const ledgerOf = (repo) => {
  try {
    return JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
  } catch {
    return { lanes: {} }
  }
}

// ---------------------------------------------------------------- the prompt hook

{
  const repo = makeRepo('claude-memory')
  const copyB = `${repo}-b`
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-b', copyB, 'master')
  const registry = join(root, 'registry.json')

  const hook = (event, session, cwd, pane) => {
    const env = { ...process.env, PANEFORGE_REPO: repo, LANE_REGISTRY: registry }
    if (pane) env.PF_PANE = pane
    else delete env.PF_PANE
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'lane-hook.mjs'), `--event=${event}`], {
      cwd,
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        session_id: session,
        cwd,
        transcript_path: join(root, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${session}.jsonl`),
        prompt: 'hello'
      })
    })
    return `${r.stdout ?? ''}${r.stderr ?? ''}`
  }
  const registryOf = () => {
    try {
      return JSON.parse(readFileSync(registry, 'utf8'))
    } catch {
      return { repos: {}, sessions: {} }
    }
  }

  // 2. the main checkout: nothing recorded, nothing printed, nothing registered.
  const main = hook('prompt', 'chat-main', repo)
  ok('a chat in the main checkout prints nothing', main === '', JSON.stringify(main))
  ok('and records no hold', Object.keys(ledgerOf(repo).lanes).length === 0, JSON.stringify(ledgerOf(repo).lanes))

  // 1. inside the copy.
  const first = hook('prompt', 'chat-b', copyB, 'pane-1')
  ok('a chat in a copy prints nothing', first === '', JSON.stringify(first))
  ok('and holds exactly that copy', ledgerOf(repo).lanes.b?.session === 'chat-b', JSON.stringify(ledgerOf(repo).lanes))
  ok('the hold is for no other copy', Object.keys(ledgerOf(repo).lanes).join() === 'b', JSON.stringify(ledgerOf(repo).lanes))
  ok(
    'it is not a copy the chat was moved out of',
    existsSync(copyB) && !existsSync(`${repo}-a`) && !existsSync(`${repo}-c`)
  )
  ok('the chat is registered, so Stop and SessionEnd reach its hold', registryOf().sessions['chat-b']?.includes(repo))
  ok('but the repo is not, so the write guard never starts refusing memory writes', !(repo in registryOf().repos))

  // The heartbeat: a second prompt of the same chat changes nothing and prints nothing.
  const again = hook('prompt', 'chat-b', copyB, 'pane-1')
  ok('the same chat prompting again is silent and keeps the copy', again === '' && ledgerOf(repo).lanes.b?.session === 'chat-b')

  // The Stop hook parks a clean copy like any other hold.
  hook('stop', 'chat-b', copyB, 'pane-1')
  ok('a stopped turn parks the hold', typeof ledgerOf(repo).lanes.b?.parked === 'number', JSON.stringify(ledgerOf(repo).lanes.b))

  // 3. another chat in the same copy, another pane: left alone, no new copy for it.
  const intruder = hook('prompt', 'chat-other', copyB, 'pane-2')
  ok('a second chat in a held copy prints nothing', intruder === '', JSON.stringify(intruder))
  ok('and does not take it', ledgerOf(repo).lanes.b?.session === 'chat-b', JSON.stringify(ledgerOf(repo).lanes))
  ok('and is not handed a new copy', !existsSync(`${repo}-a`) && !existsSync(`${repo}-c`) && Object.keys(ledgerOf(repo).lanes).join() === 'b')

  // 4. /clear: the old chat ends (SessionEnd marks it first), the pane's next chat inherits.
  execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), 'park', '--session', 'chat-b', '--ended', '--repo', repo], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  hook('prompt', 'chat-other', copyB, 'pane-2')
  ok('a different pane still cannot take an ended chat\'s copy', ledgerOf(repo).lanes.b?.session === 'chat-b')
  const cleared = hook('prompt', 'chat-b2', copyB, 'pane-1')
  ok('the same pane\'s next chat inherits the copy', ledgerOf(repo).lanes.b?.session === 'chat-b2' && cleared === '', JSON.stringify(ledgerOf(repo).lanes))
}

// ---------------------------------------------------------------- a claim never undoes an open merge

{
  const repo = makeRepo('demo')
  const copyA = `${repo}-a`
  git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', copyA, 'master')
  // The copy's own change reaches master by another route (same patch, so `ahead` reads 0),
  // then master moves on: merging master into the copy now really conflicts.
  writeFileSync(join(copyA, 'app.txt'), 'two\n')
  git(copyA, 'commit', '-qam', 'copy edit')
  writeFileSync(join(repo, 'app.txt'), 'two\n')
  git(repo, 'commit', '-qam', 'same edit on master')
  writeFileSync(join(repo, 'app.txt'), 'three\n')
  git(repo, 'commit', '-qam', 'master moves on')
  gitTry(copyA, 'merge', 'master')
  const open = gitTry(copyA, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')
  writeFileSync(join(copyA, 'app.txt'), 'resolved\n')
  git(copyA, 'add', 'app.txt')
  ok('setup: a merge is open with its resolution staged', open.length === 40 && git(copyA, 'diff', '--cached', '--name-only') === 'app.txt', open)

  const lane = (...args) =>
    spawnSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args, '--repo', repo], { encoding: 'utf8' })
  lane('claim', '--session', 'holds-main', '--cwd', repo)
  const r = lane('claim', '--session', 'finisher', '--cwd', copyA, '--prefer', 'a')
  let info = {}
  try {
    info = JSON.parse(r.stdout)
  } catch {
    /* reported below */
  }
  ok('the claim hands over the copy it was asked for', info.lane === 'a', `${r.stdout}${r.stderr}`)
  ok('and heals nothing in it', info.healed === null, JSON.stringify(info.healed))
  ok('the merge is still open', gitTry(copyA, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').length === 40)
  ok('the staged resolution is untouched', git(copyA, 'diff', '--cached', '--name-only') === 'app.txt' && readFileSync(join(copyA, 'app.txt'), 'utf8') === 'resolved\n')
}

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
if (failed) process.exit(1)
console.log('all lane never-copy checks passed')
