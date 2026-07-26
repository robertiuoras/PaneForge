// Proves scripts/rename-repo.mjs on a throwaway repo instead of on the real one.
//
// The rename it performs is four directories whose `.git` files point at each other by
// absolute path, so the failure worth catching is silent: everything appears to move and
// the lanes are quietly detached from the repo. This builds the same shape - a main
// checkout, two worktrees, a lane state file - renames it, and then asks git whether the
// worktrees still belong to the repo afterwards.
//
//   node scripts/rename-repo-test.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), `pf-rename-test-${process.pid}`)
const main = join(root, 'old-name')
const fails = []
const ok = (what, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`)
  if (!cond) fails.push(what)
}
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' })

rmSync(root, { recursive: true, force: true })
mkdirSync(main, { recursive: true })
git(main, 'init', '-q', '-b', 'master')
git(main, 'config', 'user.email', 'test@test')
git(main, 'config', 'user.name', 'test')
writeFileSync(join(main, 'a.txt'), 'hello\n')
git(main, 'add', '-A')
git(main, 'commit', '-qm', 'first')
for (const lane of ['a', 'b']) {
  git(main, 'worktree', 'add', '-q', '-b', `lane-${lane}`, join(root, `old-name-${lane}`))
}
writeFileSync(
  join(main, '.git', 'paneforge-lanes.json'),
  JSON.stringify({
    lanes: { a: { session: 'x', cwd: join(root, 'old-name-a'), seen: Date.now() - 60 * 60 * 1000 } },
    ready: {},
    release: null,
    conflicts: {}
  })
)

const run = (...extra) =>
  spawnSync(
    process.execPath,
    [join(here, 'rename-repo.mjs'), '--root', root, '--from', 'old-name', '--to', 'new-name', ...extra],
    { encoding: 'utf8' }
  )

// A lane a chat is still holding stops everything.
const state = JSON.parse(readFileSync(join(main, '.git', 'paneforge-lanes.json'), 'utf8'))
state.lanes.a.seen = Date.now()
writeFileSync(join(main, '.git', 'paneforge-lanes.json'), JSON.stringify(state))
const held = run()
ok('refuses while a lane is held by a live chat', held.status === 1 && /held by a live chat/.test(held.stdout))
ok('and nothing moved', existsSync(main) && !existsSync(join(root, 'new-name')))

// Quiet lanes: it goes.
state.lanes.a.seen = Date.now() - 60 * 60 * 1000
writeFileSync(join(main, '.git', 'paneforge-lanes.json'), JSON.stringify(state))
const dry = run('--dry')
ok('--dry says what it would do and moves nothing', /would rename/.test(dry.stdout) && existsSync(main))

const done = run()
const target = join(root, 'new-name')
ok('renamed the main checkout', done.status === 0 && existsSync(target) && !existsSync(main))
ok('renamed every worktree with it', existsSync(join(root, 'new-name-a')) && existsSync(join(root, 'new-name-b')))

// The point of the exercise: the worktrees still ARE worktrees of this repo.
const list = git(target, 'worktree', 'list').stdout
ok('git still lists three worktrees at the new paths', (list.match(/new-name/g) ?? []).length >= 3)
ok('and none of them is still registered under the old name', !/old-name/.test(list))
for (const lane of ['a', 'b']) {
  const st = git(join(root, `new-name-${lane}`), 'status', '--porcelain=v2', '--branch')
  ok(`lane ${lane} answers git from its new path`, st.status === 0 && /branch\.head lane-/.test(st.stdout))
}
const after = JSON.parse(readFileSync(join(target, '.git', 'paneforge-lanes.json'), 'utf8'))
ok('lane state paths were rewritten', after.lanes.a.cwd.includes('new-name-a'))

// Running it again is a no-op, not a second rename.
const again = run()
ok('a second run says it is already done', again.status === 0 && /already renamed/.test(again.stdout))

rmSync(root, { recursive: true, force: true })
if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log('\nrename-repo: all checks passed')
