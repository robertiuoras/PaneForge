// Regression test for the lane lifecycle - src/main/laneWork.ts.
//
// A lane that disagreed with main used to tell nobody. Each check below is one of the
// ways that goes wrong:
//
//   - work is reported honestly (commits, uncommitted files, conflicts) without touching
//     either working tree, because it is polled while agents are typing
//   - a cleared session goes back to the original folder only when the lane is empty and
//     the folder is free
//
//   node scripts/lane-work-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  // What the lane dialog PRINTS about a lane, which is a name git does not hand over plainly.
  // `--porcelain` quotes any path with a space in it (`core.quotepath`, on by default) and
  // escapes a non-ASCII one as octal, so the dialog drew `"file with spaces.txt"` - quotes
  // included - until this read switched to `-z`. Relayed from the lane-b chat's review.
  writeFileSync(join(lane, 'file with spaces.txt'), 'wip\n')
  writeFileSync(join(lane, 'café.txt'), 'wip\n')
  const named = await lw.laneWork(lane)
  check(
    'a path with a space is named without git quoting it',
    named?.touching.includes('file with spaces.txt'),
    JSON.stringify(named?.touching)
  )
  check(
    'and a non-ASCII name is not octal escapes',
    named?.touching.includes('café.txt'),
    JSON.stringify(named?.touching)
  )
  check('the count and the names agree', named?.dirty === 2, JSON.stringify(named?.touching))
  rmSync(join(lane, 'file with spaces.txt'))
  rmSync(join(lane, 'café.txt'))

  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  const ahead = (await lw.laneWork(lane))
  check('a commit in the lane counts as ahead', ahead?.ahead === 1 && ahead?.empty === false)
  check('a non-overlapping change reports no conflicts', ahead?.conflicts.length === 0)
  // Reading must not have moved either checkout.
  check('reading left the main checkout clean', git(repo, ['status', '--porcelain']) === '')
  check('reading left main on its own commit', !existsSync(join(repo, 'feature.js')))
}

// ---------------------------------------------------------------- refusing

{
  const { repo, lane } = fixture('conflict')
  commit(lane, 'app.js', 'const a = "lane"\n', 'lane edit')
  commit(repo, 'app.js', 'const a = "main"\n', 'main edit')

  const seen = (await lw.laneWork(lane))
  check('an overlapping change is surfaced before anyone merges', seen?.conflicts.includes('app.js'), JSON.stringify(seen?.conflicts))
}

// ---------------------------------------------------------------- back to base

{
  const { repo, lane } = fixture('return')
  const back = (await lw.returnToBase(lane, []))
  check('an empty lane goes back to the project folder', Boolean(back) && lw.samePath(back, repo), String(back))
  const client = join('archive', 'clients', 'finished')
  mkdirSync(join(repo, client), { recursive: true })
  mkdirSync(join(lane, client), { recursive: true })
  check('a nested client returns to the same client in base', lw.samePath((await lw.returnToBase(join(lane, client), [])) ?? '', join(repo, client)))
  check('a nested client stays in its lane while base is occupied', (await lw.returnToBase(join(lane, client), [repo])) === null)
  check('...unless another session is in it', (await lw.returnToBase(lane, [repo])) === null)
  check('...or another session holds a client subfolder', (await lw.returnToBase(lane, [join(repo, 'archive', 'clients', 'finished')])) === null)
  const alias = `${repo}-alias`
  symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
  check('...including a symlinked path to a removed client subfolder', (await lw.returnToBase(lane, [join(alias, 'archive', 'clients', 'finished')])) === null)
  commit(lane, 'feature.js', 'export const f = 1\n', 'add feature')
  check('a lane with commits stays put', (await lw.returnToBase(lane, [])) === null)
  check('the main checkout is never sent anywhere', (await lw.returnToBase(repo, [])) === null)
}

// An unreadable Git index is unknown, never a clean lane eligible for cleanup.
{
  const { repo, lane } = fixture('unreadable-status')
  const index = git(lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  writeFileSync(index, 'corrupt index')
  check('failed status is unknown', await lw.laneWork(lane) === null)
  check('failed folder enumeration is unknown', await lw.inspectLaneFolders(join(work, 'missing-repo')) === null)
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
