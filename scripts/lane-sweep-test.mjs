// The lane sweep deletes folders, so every rule it refuses on is pinned here.
//
// A lane holds real work until the moment it does not, and the difference is a handful
// of git questions. Get one wrong and the app quietly deletes a branch someone was in
// the middle of - the one failure mode in PaneForge that cannot be undone with a click.
// So this builds real repositories with real worktrees in a temp folder and checks each
// refusal against git itself rather than against a mock of it.
//
// lane-work-test.mjs covers what a lane CONTAINS and merging it back; this one is only
// about what may be deleted, including the squash-merge case, where the commit that
// carried the lane's work into the project is not the lane's commit at all.
//
//   node scripts/lane-sweep-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { sweepLanes } = await import('../src/main/laneWork.ts')

const root = join(tmpdir(), 'paneforge-lane-sweep-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

let failed = 0
function check(name, cond, detail = '') {
  if (cond) return console.log(`  ok   ${name}`)
  failed++
  console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`)
}

/** A repo with one commit, an ignored node_modules, and nothing else. */
function repo(name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'master')
  git(dir, 'config', 'user.email', 'test@paneforge')
  git(dir, 'config', 'user.name', 'PaneForge Test')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n')
  writeFileSync(join(dir, 'app.txt'), 'one\n')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'module.exports = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  return dir
}

/** The lane PaneForge would have made: `<repo>-wN` on `pf/wN`, with dependencies. */
function lane(dir, n = 2) {
  const path = `${dir}-w${n}`
  git(dir, 'worktree', 'add', '-q', '-b', `pf/w${n}`, path)
  mkdirSync(join(path, 'node_modules'), { recursive: true })
  writeFileSync(join(path, 'node_modules', 'dep.js'), 'module.exports = 1\n')
  writeFileSync(join(path, '.env'), 'SECRET=1\n')
  return path
}

console.log('lane sweep')

// 1. The ordinary case: work committed in the lane, merged into the project, chat gone.
{
  const dir = repo('merged')
  const path = lane(dir)
  writeFileSync(join(path, 'app.txt'), 'two\n')
  git(path, 'commit', '-qam', 'lane work')
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge lane', 'pf/w2')

  const swept = await sweepLanes(dir, [])
  check('merged lane is removed', !existsSync(path))
  check(
    'it is reported back, so the pane in it can be sent home',
    swept.length === 1 && swept[0].toLowerCase().endsWith('-w2')
  )
  check('its branch is deleted', !git(dir, 'branch', '--list', 'pf/w2'))
  check('the work survived in the project', git(dir, 'show', 'HEAD:app.txt') === 'two')
  check(
    "the project's own node_modules is untouched",
    existsSync(join(dir, 'node_modules', 'dep.js'))
  )
}

// 2. Squash-merged: no merge commit, and the lane's commit is not in the history at
//    all - only its content is. Nothing may be deleted on the strength of a diff.
{
  const dir = repo('squashed')
  const path = lane(dir)
  writeFileSync(join(path, 'app.txt'), 'two\n')
  git(path, 'commit', '-qam', 'lane work')
  git(dir, 'merge', '-q', '--squash', 'pf/w2')
  git(dir, 'commit', '-qm', 'squashed lane')

  await sweepLanes(dir, [])
  check('a squash-merged lane is removed', !existsSync(path))
  check('its branch goes too, or the next w2 inherits it', !git(dir, 'branch', '--list', 'pf/w2'))
}

// 2b. Two commits squashed into one: patch-equivalence cannot see that, and being sure
//     beats being thorough. The folder stays.
{
  const dir = repo('squashed-many')
  const path = lane(dir)
  writeFileSync(join(path, 'app.txt'), 'two\n')
  git(path, 'commit', '-qam', 'lane work one')
  writeFileSync(join(path, 'more.txt'), 'three\n')
  git(path, 'add', '-A')
  git(path, 'commit', '-qm', 'lane work two')
  git(dir, 'merge', '-q', '--squash', 'pf/w2')
  git(dir, 'commit', '-qm', 'squashed lane')

  await sweepLanes(dir, [])
  check('a lane squashed from several commits is kept', existsSync(path))
}

// 3. Uncommitted work in the lane.
{
  const dir = repo('dirty')
  const path = lane(dir)
  writeFileSync(join(path, 'app.txt'), 'half an edit\n')

  await sweepLanes(dir, [])
  check('a lane with uncommitted changes is kept', existsSync(path))
}

// 4. An untracked file nobody has added yet - a scratch script, a screenshot.
{
  const dir = repo('untracked')
  const path = lane(dir)
  writeFileSync(join(path, 'notes.md'), 'thinking out loud\n')

  await sweepLanes(dir, [])
  check('a lane holding an untracked file is kept', existsSync(path))
}

// 5. Committed but not merged: the whole point of the refusal.
{
  const dir = repo('unmerged')
  const path = lane(dir)
  writeFileSync(join(path, 'app.txt'), 'two\n')
  git(path, 'commit', '-qam', 'lane work')

  await sweepLanes(dir, [])
  check('an unmerged lane is kept', existsSync(path))
  check('and its branch with it', git(dir, 'branch', '--list', 'pf/w2') !== '')
}

// 6. Merged and clean, but a pane is open in it.
{
  const dir = repo('busy')
  const path = lane(dir)

  await sweepLanes(dir, [path])
  check('a lane with a pane in it is kept', existsSync(path))
  await sweepLanes(dir, [join(path, 'src')])
  check('a pane in a subfolder of it counts too', existsSync(path))
  // Same folder, other spelling: this is what the caller actually passes on Windows.
  await sweepLanes(dir, [path.replace(/\\/g, '/').toUpperCase()])
  check('the folder match is case and slash insensitive', existsSync(path))
}

// 7. A worktree the user made themselves, which happens to sit at a lane-shaped path.
{
  const dir = repo('handmade')
  const path = `${dir}-w2`
  git(dir, 'worktree', 'add', '-q', '-b', 'my-feature', path)

  await sweepLanes(dir, [])
  check("a worktree on someone else's branch is never touched", existsSync(path))
}

// 8. An empty lane - claimed, never used. This is most of them.
{
  const dir = repo('untouched')
  const path = lane(dir)

  const swept = await sweepLanes(dir, [])
  check('a lane nothing was ever done in is removed', !existsSync(path) && swept.length === 1)
  check('with its ignored files', !existsSync(join(path, 'node_modules')))
}

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
