// Regression test for the lane lifecycle - src/main/laneWork.ts.
//
// The half that was missing until now: a worktree lane was created and then left alone
// forever. Its commits were never merged, its folder never removed, and a lane that
// disagreed with main told nobody. Each check below is one of the ways that goes wrong:
//
//   - work is reported honestly (commits, uncommitted files, conflicts) without touching
//     either working tree, because it is polled while agents are typing
//   - a merge back refuses on a dirty lane, a dirty main checkout, or a conflict, and
//     leaves the main checkout exactly as it found it (no half-finished merge)
//   - a clean merge really lands on the base branch, and the empty lane is removed
//   - the sweep only ever deletes a lane holding nothing - one untracked file is enough
//     to keep it
//   - a cleared session goes back to the original folder only when the lane is empty and
//     the folder is free
//
//   node scripts/lane-work-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
// realpath: macOS hands out /var/folders/... for a temp dir that git and the app both
// spell /private/var/folders/..., and every path assertion below would compare the two.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pf-lanework-')))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

/**
 * Bundle laneWork.ts (node builtins only) and import it.
 *
 * Bundled rather than compiled file-by-file: `tsc` leaves a relative import extensionless,
 * which Node's ESM loader refuses, so the first *value* import laneWork gained from
 * `shared/` broke this test with an ERR_MODULE_NOT_FOUND naming a temp directory rather
 * than the cause. esbuild follows the imports itself and there is nothing to keep in sync.
 *
 * esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
 * Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
 */
async function loadLaneWork() {
  const out = join(work, 'laneWork.bundle.mjs')
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [join('src', 'main', 'laneWork.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: out
  })
  return import(pathToFileURL(out).href)
}

const lw = await loadLaneWork()

/** A repo with one commit, plus a `-w2` worktree lane off it. */
function fixture(name) {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'app.js'), 'const a = 1\n')
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'first'])
  const lane = `${repo}-w2`
  git(repo, ['worktree', 'add', '-b', 'pf/w2', lane])
  git(lane, ['config', 'user.email', 'test@example.com'])
  git(lane, ['config', 'user.name', 'test'])
  return { repo, lane }
}

const commit = (cwd, file, text, msg) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', msg])
}

// ---------------------------------------------------------------- reading a lane

{
  const { repo, lane } = fixture('read')
  const fresh = (await lw.laneWork(lane))
  check('a fresh lane is recognised', fresh?.lane === 'w2' && fresh?.branch === 'pf/w2', JSON.stringify(fresh))
  check('a fresh lane is empty', fresh?.empty === true && fresh?.ahead === 0 && fresh?.dirty === 0)
  check('the base branch is the one the repo is on', fresh?.base === 'main', fresh?.base)
  check('the main checkout is not a lane', (await lw.laneWork(repo)) === null)

  writeFileSync(join(lane, 'scratch.txt'), 'wip\n')
  check('an untracked file makes a lane non-empty', (await lw.laneWork(lane))?.empty === false)
  rmSync(join(lane, 'scratch.txt'))

  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  const ahead = (await lw.laneWork(lane))
  check('a commit in the lane counts as ahead', ahead?.ahead === 1 && ahead?.empty === false)
  check('a non-overlapping change reports no conflicts', ahead?.conflicts.length === 0)
  // Reading must not have moved either checkout.
  check('reading left the main checkout clean', git(repo, ['status', '--porcelain']) === '')
  check('reading left main on its own commit', !existsSync(join(repo, 'feature.js')))
}

// ---------------------------------------------------------------- merging back

{
  const { repo, lane } = fixture('merge')
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  commit(lane, 'second.js', 'export const s = 2\n', 'add second')

  const busy = (await lw.mergeLaneBack(lane, { busy: [lane] }))
  check('a merge with a session still in the lane succeeds', busy.ok === true, JSON.stringify(busy))
  check('...and reports the commits it moved', busy.ok && busy.commits === 2)
  check('...and leaves the folder alone while a session holds it', busy.ok && busy.removed === false)
  check('...and the files are on the base branch', existsSync(join(repo, 'feature.js')))
  check('...as a merge commit, so the lane is on the record', git(repo, ['log', '-1', '--pretty=%s']).startsWith('merge lane w2'))
  check('a second merge has nothing to do', (await lw.mergeLaneBack(lane)).reason === 'nothing')
  check('the merged lane now reads as empty', (await lw.laneWork(lane))?.empty === true)
}

{
  const { repo, lane } = fixture('merge-free')
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  const r = (await lw.mergeLaneBack(lane))
  check('a merged lane nobody is in is removed', r.ok === true && r.removed === true, JSON.stringify(r))
  check('...folder gone', !existsSync(lane))
  check('...branch gone', !git(repo, ['branch', '--list', 'pf/w2']))
  check('...and the work is on main', existsSync(join(repo, 'feature.js')))
}

// ---------------------------------------------------------------- refusing

{
  const { repo, lane } = fixture('conflict')
  commit(lane, 'app.js', 'const a = "lane"\n', 'lane edit')
  commit(repo, 'app.js', 'const a = "main"\n', 'main edit')

  const seen = (await lw.laneWork(lane))
  check('an overlapping change is surfaced before anyone merges', seen?.conflicts.includes('app.js'), JSON.stringify(seen?.conflicts))

  const r = (await lw.mergeLaneBack(lane))
  check('a conflicting merge refuses', r.ok === false && r.reason === 'conflict', JSON.stringify(r))
  check('...naming the files', r.ok === false && r.conflicts?.includes('app.js'))
  check('...leaving the main checkout clean', git(repo, ['status', '--porcelain']) === '')
  check('...with no merge left half-done', !existsSync(join(repo, '.git', 'MERGE_HEAD')))
  check('...and main still has its own version', readFileSync(join(repo, 'app.js'), 'utf8').includes('main'))
}

{
  const { lane } = fixture('lane-dirty')
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  writeFileSync(join(lane, 'feature.js'), 'export const f = 2\n')
  const r = (await lw.mergeLaneBack(lane))
  check('a merge refuses while the lane has uncommitted work', r.ok === false && r.reason === 'lane-dirty', JSON.stringify(r))
}

{
  const { repo, lane } = fixture('base-dirty')
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  writeFileSync(join(repo, 'README.md'), '# edited by hand\n')
  const r = (await lw.mergeLaneBack(lane))
  check('a merge refuses onto a dirty main checkout', r.ok === false && r.reason === 'base-dirty', JSON.stringify(r))
  check('...and did not touch that edit', readFileSync(join(repo, 'README.md'), 'utf8').includes('by hand'))
}

// ---------------------------------------------------------------- sweeping

{
  const { repo, lane } = fixture('sweep')
  const w3 = `${repo}-w3`
  git(repo, ['worktree', 'add', '-b', 'pf/w3', w3])
  git(w3, ['config', 'user.email', 'test@example.com'])
  git(w3, ['config', 'user.name', 'test'])
  commit(w3, 'kept.js', 'export const k = 1\n', 'work worth keeping')

  const removed = await lw.sweepLanes(repo, [])
  check('an empty lane is swept', removed.some((p) => lw.samePath(p, lane)) && !existsSync(lane))
  check('...and its branch with it', !git(repo, ['branch', '--list', 'pf/w2']))
  check('a lane holding commits is left alone', existsSync(w3))

  // The empty folder a Windows removal leaves behind (see dropEmptyShells): git has
  // already forgotten it, so nothing else would ever come back for it.
  mkdirSync(lane, { recursive: true })
  await lw.sweepLanes(repo, [])
  check('an empty leftover lane folder is cleaned up', !existsSync(lane))

  // A lane with nothing but an untracked file must survive: that is an agent mid-edit.
  const w4 = `${repo}-w4`
  git(repo, ['worktree', 'add', '-b', 'pf/w4', w4])
  writeFileSync(join(w4, 'scratch.txt'), 'wip\n')
  await lw.sweepLanes(repo, [])
  check('a lane with only an untracked file is left alone', existsSync(w4))

  // And one a session is sitting in is never touched, empty or not.
  const w5 = `${repo}-w5`
  git(repo, ['worktree', 'add', '-b', 'pf/w5', w5])
  await lw.sweepLanes(repo, [w5])
  check('a lane with a session in it is left alone', existsSync(w5))
  await lw.sweepLanes(repo, [])
  check('...and swept once that session is gone', !existsSync(w5))
}

// ------------------------------------------- a folder Windows will not let go of

{
  // The case that got past the unit tests and only turned up in the running app: on
  // Windows, `git worktree remove` empties the lane and deregisters it, then fails on
  // the last step - deleting the folder - because a process still has it as its current
  // directory. That is normal: the pane that was just moved out of the lane is such a
  // process for a second or two. Reading git's exit code alone left the branch behind
  // forever and re-tried the same lane on every sweep.
  const { repo, lane } = fixture('locked')
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: lane })
  await new Promise((r) => setTimeout(r, 400))

  const removed = await lw.sweepLanes(repo, [])
  check('a lane whose folder is pinned open is still swept', removed.some((p2) => lw.samePath(p2, lane)))
  check('...git no longer calls it a worktree', !git(repo, ['worktree', 'list']).includes('-w2'))
  check('...and its branch is deleted, not left behind', !git(repo, ['branch', '--list', 'pf/w2']))
  holder.kill()
}

// ---------------------------------------------------------------- back to base

{
  const { repo, lane } = fixture('return')
  const back = (await lw.returnToBase(lane, []))
  check('an empty lane goes back to the project folder', Boolean(back) && lw.samePath(back, repo), String(back))
  check('...unless another session is in it', (await lw.returnToBase(lane, [repo])) === null)
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  check('a lane with commits stays put', (await lw.returnToBase(lane, [])) === null)
  check('the main checkout is never sent anywhere', (await lw.returnToBase(repo, [])) === null)
}

// ---------------------------------------------------------------- spotting /clear

{
  // Keystrokes arrive in whatever chunks the terminal sends them in, so the line has to
  // survive being typed one character at a time as well as pasted whole.
  let line = ''
  const feed = (data) => {
    const r = lw.trackTyped(line, data)
    line = r.line
    return r.submitted
  }
  check('a line typed a character at a time is seen whole', ['/', 'c', 'l', 'e', 'a', 'r'].every((c) => feed(c).length === 0) && feed('\r').includes('/clear'))
  check('a pasted line is seen too', feed('/clear\r').includes('/clear'))
  check('an ordinary prompt is not a clear', !feed('please clear the cache\r').includes('/clear'))
  const BS = String.fromCharCode(127)
  const ESC = String.fromCharCode(27)
  const CTRLC = String.fromCharCode(3)
  check('a typo backspaced away still counts', feed('/cleax' + BS + 'r\r').includes('/clear'))
  check('Ctrl-C abandons the line', !feed('/clear' + CTRLC + '\r').includes('/clear'))
  check('Escape abandons the line', !feed('/clear' + ESC + '\r').includes('/clear'))
  check('an arrow key does not become text', !feed('/clear' + ESC + '[A\r').includes('/clear'))
  // The one that actually broke it in the running app: xterm reports focus as ESC [ O
  // (out) and ESC [ I (in), so every pane that had ever lost focus carried a "[O" at
  // the front of its line, and /clear was submitted as "[O/clear" forever after.
  check('a focus report is not typing', !feed(ESC + '[O').length && feed('/clear\r').includes('/clear'))
  check('focus in the middle of a line is ignored too', feed('/cle' + ESC + '[I' + 'ar\r').includes('/clear'))
  check('an arrow key is not typing', feed(ESC + '[A/clear\r').includes('/clear'))
  check('an application-mode arrow is not typing', feed(ESC + 'OB/clear\r').includes('/clear'))
  check('a title sequence is not typing', feed(ESC + ']0;Claude Code' + String.fromCharCode(7) + '/clear\r').includes('/clear'))
  check('Ctrl-U wipes the line', !feed('/clear' + String.fromCharCode(21) + 'x\r').includes('/clear'))
  check('two lines in one chunk are both reported', lw.trackTyped('', 'hello\r/clear\r').submitted.length === 2)
  check('only the tail of a long paste is kept', lw.trackTyped('', 'x'.repeat(5000)).line.length === 32)
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failing` : '\nall good')
process.exit(failures ? 1 : 0)
