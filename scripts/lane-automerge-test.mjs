// Regression test for the conflict nobody should ever be asked about.
//
// What happened on 2026-08-02: lane c finished `feat(lanes): PaneForge installs its own
// lane hooks`, master had meanwhile added `import { agentsMidTurn }` four lines away from
// the lane's `import { installLaneHooks }`, and the merge failed. Both lines were wanted.
// There was no decision to make. The lane sat conflicted through two releases and its
// finished feature shipped in neither, until a human opened the file and typed both
// imports back in - which is the exact text git already had on both sides.
//
// So an import-block collision is settled by the machine now, on the lane side and on the
// release side, and everything that is not an import block still stops and asks.
//
// Real git repos in the temp folder, real lane.mjs, no stubs.
//
//   node scripts/lane-automerge-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'
import { mergeAutoConflicts, mergeImportConflicts, mergeMarkdownConflicts } from './lane-merge.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-automerge-test')
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

// ------------------------------------------------------------- the rule, on its own

const hunk = (ours, theirs) =>
  ['const x = 1', '<<<<<<< HEAD', ...ours, '=======', ...theirs, '>>>>>>> master', 'const y = 2'].join(
    '\n'
  )

const imports = mergeImportConflicts(
  hunk(["import { a } from './a'"], ["import { b } from './b'"])
)
ok(
  'both imports survive, ours first',
  imports === ["const x = 1", "import { a } from './a'", "import { b } from './b'", 'const y = 2'].join('\n'),
  imports
)
ok(
  'a line both sides added appears once',
  mergeImportConflicts(hunk(["import { a } from './a'"], ["import { a } from './a'", "import { b } from './b'"])) ===
    ["const x = 1", "import { a } from './a'", "import { b } from './b'", 'const y = 2'].join('\n')
)
ok(
  'require() and python-style imports count too',
  mergeImportConflicts(hunk(["const a = require('a')"], ['from os import path'])) !== null
)
ok('real code is still a real conflict', mergeImportConflicts(hunk(['const a = 1'], ['const a = 2'])) === null)
ok(
  'one bad hunk poisons the whole file',
  mergeImportConflicts(
    hunk(["import { a } from './a'"], ["import { b } from './b'"]) +
      '\n' +
      hunk(['return 1'], ['return 2'])
  ) === null
)
ok(
  'diff3 markers are refused - three versions is not this rule',
  mergeImportConflicts(
    ['<<<<<<< HEAD', "import { a } from './a'", '||||||| base', '=======', "import { b } from './b'", '>>>>>>> master'].join('\n')
  ) === null
)
ok('a file with no conflict is left alone', mergeImportConflicts('const x = 1\n') === null)

const mdHunk = hunk(['## Section A', '', 'Notes from lane A.'], ['## Section B', '', 'Notes from lane B.'])
const mdMerged = mergeMarkdownConflicts(mdHunk)
ok('markdown heading sections on both sides are combined', mdMerged && mdMerged.includes('Section A') && mdMerged.includes('Section B'), mdMerged)

const mdBullets = hunk(['* Note 1 from A', '* Note 2 from A'], ['* Note 3 from B', '* Note 4 from B'])
const mdBulletsMerged = mergeMarkdownConflicts(mdBullets)
ok('markdown bullet items on both sides are combined', mdBulletsMerged && mdBulletsMerged.includes('Note 1') && mdBulletsMerged.includes('Note 4'), mdBulletsMerged)

// ------------------------------------------------------------- and end to end, through the CLI

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const repo = join(root, 'demo')
mkdirSync(join(repo, 'src'), { recursive: true })
mkdirSync(join(repo, 'scripts'), { recursive: true })
const SRC = (extra) =>
  ["import { one } from './one'", ...extra, "import { two } from './two'", '', 'export const go = () => one + two', ''].join('\n')

writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'src', 'index.ts'), SRC([]))
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const lane = (...args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const laneOf = (id) => JSON.parse(lane('status').out).lanes.find((l) => l.lane === id)
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

JSON.parse(lane('claim', '--session', 'sess-main').out)
const work = JSON.parse(lane('claim', '--session', 'sess-b').out)
const state = JSON.parse(readFileSync(statePath, 'utf8'))
state.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }
writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')

// The two halves of the lane-c conflict, reproduced: one import each, same block.
commit(work.dir, 'src/index.ts', SRC(["import { fromLane } from './lane'"]), 'lane adds an import')
commit(repo, 'src/index.ts', SRC(["import { fromMaster } from './master'"]), 'master adds an import')

const done = lane('ready', '--session', 'sess-b')
ok('a lane that only disagrees about imports finishes by itself', done.code === 0, done.err || done.out)
ok('and is not left conflicted', laneOf(work.lane).conflicted === false)
const merged = readFileSync(join(work.dir, 'src', 'index.ts'), 'utf8')
ok('the lane has master\'s import', merged.includes('fromMaster'), merged)
ok('and still has its own', merged.includes('fromLane'), merged)
ok('with no markers left behind', !/<<<<<<<|>>>>>>>/.test(merged))

// Anything that is not an import block still stops and asks.
const other = JSON.parse(lane('claim', '--session', 'sess-c').out)
commit(other.dir, 'src/index.ts', SRC([]).replace('one + two', 'one - two'), 'lane changes the code')
commit(repo, 'src/index.ts', SRC([]).replace('one + two', 'one * two'), 'master changes the code')
const stuck = lane('ready', '--session', 'sess-c')
ok('a real disagreement is still a conflict', stuck.code !== 0 && /index\.ts/.test(stuck.err), stuck.err)
ok('and it is recorded against that lane', laneOf(other.lane).conflicted === true)

// ------------------------------------------- the list conflicts, which are most of them

// Measured on taskdriver.ai for the fortnight to 2026-08-28: 10 of 92 lane merges needed a
// human, and the commit subjects say what for - "keep both sides of the test script list",
// "union of both sides' test scripts", "keep both test scripts", and a .gitignore where one
// lane ignored a scratch file while the other ignored the logs beside it. Two lanes each
// appending to one list is the commonest lane conflict there is, and there is nothing in it
// to decide.

const gitignoreHunk = [
  '# generated',
  '<<<<<<< HEAD',
  '',
  '# a per-run id, rewritten by every run',
  'scratchpad/current-run.txt',
  '=======',
  'scratchpad/*.log',
  '>>>>>>> main',
  ''
].join('\n')
const gitignoreMerged = mergeAutoConflicts(gitignoreHunk, '.gitignore')
ok(
  'two lanes ignoring different files keep both patterns',
  gitignoreMerged?.includes('scratchpad/current-run.txt') && gitignoreMerged?.includes('scratchpad/*.log'),
  gitignoreMerged
)
ok('and no marker survives', !/[<>=]{7}/.test(gitignoreMerged ?? ''), gitignoreMerged)

// `!pattern` un-ignores something ignored ABOVE it: where the line sits IS the meaning.
const negated = [
  '<<<<<<< HEAD',
  'build/',
  '=======',
  '!build/keep.js',
  '>>>>>>> main'
].join('\n')
ok('a negation makes order meaningful, so it stays a human conflict', mergeAutoConflicts(negated, '.gitignore') === null)

const scriptsHunk = [
  '  "scripts": {',
  '    "build": "next build",',
  '<<<<<<< HEAD',
  '    "test:demo-eager-images": "node scripts/site-settle-eager-images.test.mjs",',
  '=======',
  '    "test:approach-motion": "node scripts/approach-motion.test.mjs",',
  '>>>>>>> main',
  '    "verify": "npm run typecheck"',
  '  }'
].join('\n')
const scriptsMerged = mergeAutoConflicts(scriptsHunk, 'package.json')
ok(
  'two lanes each adding a test script keep both',
  scriptsMerged?.includes('test:demo-eager-images') && scriptsMerged?.includes('test:approach-motion'),
  scriptsMerged
)
ok(
  'and the JSON is still valid - every member but the last carries its comma',
  (() => {
    try {
      JSON.parse('{' + scriptsMerged + '}')
      return true
    } catch (e) {
      return false
    }
  })(),
  scriptsMerged
)

// One key, two values, is two answers to one question.
const sameKey = [
  '<<<<<<< HEAD',
  '    "test:x": "node scripts/x.mjs",',
  '=======',
  '    "test:x": "node scripts/x-renamed.mjs",',
  '>>>>>>> main'
].join('\n')
ok('the same key with two values is still a human conflict', mergeAutoConflicts(sameKey, 'package.json') === null)

// A version bump is not an addition.
const version = [
  '<<<<<<< HEAD',
  '  "version": "0.8.160",',
  '=======',
  '  "version": "0.8.161",',
  '>>>>>>> main'
].join('\n')
ok('two version bumps still stop and ask', mergeAutoConflicts(version, 'package.json') === null)

// A JSON file is not a licence to union anything shaped like text.
const notMembers = [
  '<<<<<<< HEAD',
  '  some prose that is not a member',
  '=======',
  '  other prose',
  '>>>>>>> main'
].join('\n')
ok('anything that is not an object member refuses the file', mergeAutoConflicts(notMembers, 'package.json') === null)

// The rule is scoped: a .ts file full of ignore-looking lines is not an ignore file.
ok('a source file is not treated as a list', mergeAutoConflicts(gitignoreHunk, 'lib/thing.ts') === null)

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
