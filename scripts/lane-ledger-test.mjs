// Regression test for "a lane that is never clean never catches up".
//
// 2026-09-19, claude-memory lane-a: the session holding the lane rewrote its checkpoint
// json, the ledger jsonl files and the prompt log at EVERY hook boundary. `catchUp` read
// the worktree as dirty on every retry ("never merge on top of someone's uncommitted
// edit") and the lane fell further behind master until it was merged by hand.
//
// Those files are not somebody's uncommitted edit: the repo itself declares them
// machine-written, by giving them a `union` or `take-incoming` merge driver in
// .gitattributes. When EVERY dirty path is such a path, catchUp commits them first
// (subject `chore: session ledger + prompt log`, the one the ledger hook already uses)
// and then merges as it always did. One hand-written edit beside them still refuses.
//
// Real git repos in the temp folder, real lane.mjs, no stubs. Nothing here names a
// claude-memory path: the rule is read off `git check-attr`.
//
//   node scripts/lane-ledger-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-ledger-test')
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

const origin = join(root, 'origin.git')
const repo = join(root, 'demo')
const laneA = join(root, 'demo-a')
const LEDGER_SUBJECT = 'chore: session ledger + prompt log'

git(root, 'init', '-q', '--bare', '-b', 'master', origin)

mkdirSync(join(repo, 'scripts'), { recursive: true })
mkdirSync(join(repo, 'ledger', 'checkpoint'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, 'ledger', 'runs.jsonl'), '{"run":1}\n')
writeFileSync(join(repo, 'ledger', 'checkpoint', 'keep.json'), '{}\n')
// The repo's own declaration of what a machine writes. Same shapes claude-memory uses.
writeFileSync(
  join(repo, '.gitattributes'),
  ['ledger/*.jsonl merge=union', 'ledger/checkpoint/*.json merge=take-incoming', ''].join('\n')
)
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a'], release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', laneA)
git(laneA, 'config', 'user.email', 'test@example.com')
git(laneA, 'config', 'user.name', 'test')
writeFileSync(join(laneA, 'feature.js'), 'export const f = 1\n')
git(laneA, 'add', '-A')
git(laneA, 'commit', '-qm', 'feat: finished here')

// Master moves on without the lane.
writeFileSync(join(repo, 'from-master.js'), 'export const m = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'feat: on master')

const lane = (...args) => {
  try {
    return execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim()
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}
const subjects = (cwd, ref = 'HEAD') => git(cwd, 'log', '--format=%s', ref).split('\n')
const hasMaster = (cwd) => {
  try {
    git(cwd, 'merge-base', '--is-ancestor', 'master', 'HEAD')
    return true
  } catch {
    return false
  }
}

// ------------------------------------------ a hand edit beside the ledger still refuses

// What the hook leaves behind at every boundary: a tracked ledger appended to, a new
// untracked checkpoint file. Plus, this once, a real edit somebody is in the middle of.
writeFileSync(join(laneA, 'ledger', 'runs.jsonl'), '{"run":1}\n{"run":2}\n')
writeFileSync(join(laneA, 'ledger', 'checkpoint', 'sess-1.json'), '{"turn":1}\n')
writeFileSync(join(laneA, 'app.js'), 'console.log(2) // half-finished\n')

let out = lane('ready', '--session', 'worker', '--lane', 'a')
ok('a hand edit beside the ledger files still stops the merge', !hasMaster(laneA), out)
ok(
  'and nothing was committed on its behalf',
  !subjects(laneA).includes(LEDGER_SUBJECT) && git(laneA, 'status', '--porcelain').includes('app.js'),
  git(laneA, 'log', '--oneline', '-5') + '\n' + git(laneA, 'status', '--porcelain')
)
ok('the refusal names the edit, not the ledger', /app\.js/.test(out), out)

// ----------------------------------- only machine-written paths dirty: commit, then merge

git(laneA, 'checkout', '-q', '--', 'app.js')
ok(
  'setup: the lane is dirty with nothing but ledger + checkpoint files',
  git(laneA, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .every((l) => /ledger\//.test(l)),
  git(laneA, 'status', '--porcelain', '--untracked-files=all')
)

out = lane('ready', '--session', 'worker', '--lane', 'a')
ok('the lane caught up with master', hasMaster(laneA), out + '\n' + git(laneA, 'log', '--oneline', '-6'))
const log = subjects(laneA)
ok(
  `the ledger files went in as their own commit: "${LEDGER_SUBJECT}"`,
  log.includes(LEDGER_SUBJECT),
  log.join('\n')
)
ok(
  'that commit holds the ledger and the checkpoint, nothing else',
  (() => {
    const sha = git(laneA, 'log', '--format=%H', '--grep', `^${LEDGER_SUBJECT}$`, '-1')
    if (!sha) return false
    const files = git(laneA, 'show', '--format=', '--name-only', sha).split('\n').filter(Boolean).sort()
    return files.join(',') === 'ledger/checkpoint/sess-1.json,ledger/runs.jsonl'
  })(),
  git(laneA, 'show', '--format=%s', '--name-only', 'HEAD~1')
)
ok(
  'the ledger commit sits BELOW the merge, so the merge is on committed work',
  log[0] !== LEDGER_SUBJECT && log.indexOf(LEDGER_SUBJECT) > 0,
  log.slice(0, 4).join('\n')
)
ok('the worktree is clean afterwards', git(laneA, 'status', '--porcelain', '--untracked-files=all') === '', out)
ok('the lane was marked ready', /ready|shipp|merged|caught/i.test(out) || !/error|uncommitted/i.test(out), out)

// ------------------------------------------------ a path with NO merge driver is an edit

// An ordinary untracked file - the classic "someone is mid-edit" - is not machine-written
// however much it looks like data, because .gitattributes says nothing about it.
writeFileSync(join(repo, 'from-master-2.js'), 'export const m2 = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'feat: on master again')
writeFileSync(join(laneA, 'ledger', 'runs.jsonl'), '{"run":1}\n{"run":2}\n{"run":3}\n')
writeFileSync(join(laneA, 'notes.jsonl'), '{"hand":true}\n')
out = lane('ready', '--session', 'worker', '--lane', 'a')
ok('an untracked file with no merge driver still counts as an edit', !hasMaster(laneA), out)
ok(
  'and the ledger append beside it was left uncommitted too',
  git(laneA, 'status', '--porcelain').includes('runs.jsonl'),
  git(laneA, 'status', '--porcelain')
)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
