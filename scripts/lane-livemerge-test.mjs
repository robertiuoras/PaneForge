// Regression test: a release must never put somebody's unsaved edit in the main folder at risk.
//
// What happened on 2026-10-04 at 11:59am, in claude-memory's main folder: a plain `git merge`
// ran while hooks were writing the folder's ledger files. Git refused ("Your local changes to
// the following files would be overwritten by merge ... Aborting"), and on the way out it did
// what a failed `git merge` always does: saved the folder's edits away, reset every file, and
// put the edits back. A hook wrote in between, the putting back failed ("Index was not
// unstashed. / Merge with strategy ort failed"), and 21 files of other chats' work existed
// only in dangling commit 09deeb523. `ship` ran the same `git merge --no-ff` in the same
// folder for every lane it released, and `--no-ff` overrides the `merge.ff=only` guard put on
// that folder afterwards.
//
// Here the hooks are real: a post-index-change hook appends a line to a tracked ledger every
// time git writes the main folder's index, as claude-memory's do, and the fixture's
// `typecheck` - which `ship` runs after its dirty-folder check and before it merges - is
// where another chat saves its edit to a file the lane also changes.
//
// Real git repos in the temp folder, real lane.mjs, no stubs.
//
//   node scripts/lane-livemerge-test.mjs

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(tmpdir(), 'paneforge-livemerge-test')
// Everything below deletes and resets; none of it may run anywhere but the temp folder.
if (!root.startsWith(resolve(tmpdir()) + sep)) throw new Error(`refusing to run outside the temp folder: ${root}`)
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

// The hook: one numbered line per index write, into the tracked ledger and into a record git
// never touches, so the test can tell which lines the ledger should still hold. Main folder
// only - in a lane folder (or any other worktree) `.git` is a file, not a folder.
const HOOK = `#!/bin/sh
[ -f .git/ledger-armed ] || exit 0
n=$(cat .git/ledger-written 2>/dev/null | wc -l)
line="hook line $(( n + 1 ))"
echo "$line" >> ledger.txt
echo "$line" >> .git/ledger-written
`

// The fixture's typecheck. In the main folder only, and only when the test asks: save another
// chat's edit (once, after \`skip\` runs: autoship checks master once before \`ship\` reads the
// folder), or fail while a file is present (two lanes that compile apart, not together).
const CHECK = `import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
if (!statSync('.git').isDirectory() || !existsSync('.git/check.json')) process.exit(0)
const ask = JSON.parse(readFileSync('.git/check.json', 'utf8'))
if (ask.write && ask.skip > 0) writeFileSync('.git/check.json', JSON.stringify({ ...ask, skip: ask.skip - 1 }))
else if (ask.write) {
  writeFileSync(ask.write.file, ask.write.text)
  unlinkSync('.git/check.json')
}
if (ask.failIf && existsSync(ask.failIf)) {
  // Another chat's lane command, run while the release is still checking what it merged.
  if (ask.during) execFileSync(process.execPath, ['scripts/lane.mjs', ...ask.during], { stdio: 'ignore' })
  console.log('src/x.ts(1,1): error TS2304: they do not compile together')
  process.exit(1)
}
`

function fixture(name) {
  const repo = join(root, name)
  if (!resolve(repo).startsWith(root + sep)) throw new Error(`fixture outside the temp folder: ${repo}`)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name, version: '0.0.1', scripts: { typecheck: 'node scripts/check.mjs' } }, null, 2) + '\n'
  )
  writeFileSync(join(repo, 'scripts', 'check.mjs'), CHECK)
  writeFileSync(join(repo, 'notes.txt'), 'first\n')
  writeFileSync(join(repo, 'draft.txt'), 'draft\n')
  writeFileSync(join(repo, 'ledger.txt'), 'ledger\n')
  writeFileSync(join(repo, 'src', 'index.ts'), SRC([]))
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  const origin = join(root, `${name}.git`)
  git(root, 'init', '-q', '--bare', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')
  writeFileSync(join(repo, '.git', 'hooks', 'post-index-change'), HOOK, { mode: 0o755 })

  const env = { ...process.env, PF_RELEASE: 'merge' }
  const lane = (...args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
          cwd: repo,
          env,
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim()
      }
    } catch (e) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }
  JSON.parse(lane('claim', '--session', 'sess-main').out)
  const claim = (session) => JSON.parse(lane('claim', '--session', session).out)
  const commit = (dir, file, text, msg) => {
    writeFileSync(join(dir, file), text)
    git(dir, 'add', '--', file)
    git(dir, 'commit', '-qm', msg)
  }
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const arm = (check) => {
    writeFileSync(join(repo, '.git', 'ledger-armed'), '')
    // A line already waiting in the ledger when the release starts, as there always is.
    appendFileSync(join(repo, 'ledger.txt'), 'hook line 0\n')
    appendFileSync(join(repo, '.git', 'ledger-written'), 'hook line 0\n')
    if (check) writeFileSync(join(repo, '.git', 'check.json'), JSON.stringify(check))
  }
  // Every line the hook wrote, and whether the ledger still has each one.
  const ledgerKept = () => {
    const written = existsSync(join(repo, '.git', 'ledger-written'))
      ? readFileSync(join(repo, '.git', 'ledger-written'), 'utf8').split('\n').filter(Boolean)
      : []
    const now = readFileSync(join(repo, 'ledger.txt'), 'utf8')
    const lost = written.filter((l) => !now.split('\n').includes(l))
    return { written: written.length, lost }
  }
  // `git merge` saves the folder away as "WIP on <branch>" first, and resets it if it fails.
  // Only the main folder's branch counts: a scratch merge has nothing of anybody's to lose.
  const wipCommits = () =>
    git(repo, 'fsck', '--unreachable', '--no-reflogs')
      .split('\n')
      .filter((l) => l.startsWith('unreachable commit '))
      .map((l) => l.split(' ')[2])
      .map((sha) => git(repo, 'log', '-1', '--format=%s', sha))
      .filter((s) => /^(WIP on|index on) master:/.test(s))
  const midMerge = () => existsSync(join(repo, '.git', 'MERGE_HEAD'))
  const scratchLeft = () => git(repo, 'worktree', 'list').split('\n').filter((l) => /pfm-/.test(l))
  return { repo, lane, claim, commit, state, arm, ledgerKept, wipCommits, midMerge, scratchLeft }
}

const SRC = (extra) =>
  ["import { one } from './one'", ...extra, "import { two } from './two'", '', 'export const go = () => one + two', ''].join('\n')

// ------------------------------------------- the incident: an edit saved mid-release

{
  const f = fixture('edited-mid-release')
  const work = f.claim('sess-b')
  f.commit(work.dir, 'notes.txt', 'first\nfrom the lane\n', 'lane changes notes')
  const edit = 'first\nanother chat, not saved to git yet\n'
  f.arm({ write: { file: 'notes.txt', text: edit }, skip: 1 })
  const done = f.lane('ready', '--session', 'sess-b')
  const said = `${done.out}\n${done.err}`

  ok(
    "another chat's unsaved edit to a file the lane brings is still in the main folder",
    readFileSync(join(f.repo, 'notes.txt'), 'utf8') === edit,
    `notes.txt is now: ${JSON.stringify(readFileSync(join(f.repo, 'notes.txt'), 'utf8'))}\n${said}`
  )
  const kept = f.ledgerKept()
  ok('every ledger line the hooks wrote during the release is still there', kept.written > 0 && !kept.lost.length, `${kept.written} written, lost: ${kept.lost.join(', ')}`)
  const wip = f.wipCommits()
  ok('nothing was saved away into a commit nobody points at', !wip.length, wip.join('\n'))
  ok('no merge is left half done in the main folder', !f.midMerge())
  const s = f.state()
  ok('the lane is not recorded as a conflict - nothing disagrees', !s.conflicts?.[work.lane], JSON.stringify(s.conflicts))
  ok('it keeps its ready mark, so the next release takes it', Boolean(s.ready?.[work.lane]), JSON.stringify(s.ready))
  ok('and says so by name, with the file', new RegExp(`Lane ${work.lane} is NOT out.*notes\\.txt`).test(said), said)
  ok('master did not move', !git(f.repo, 'log', '--format=%s', 'master').includes('merge lane'))
}

// ------------------------------------------- the ordinary release, with the hooks writing

{
  const f = fixture('clean-release')
  const work = f.claim('sess-b')
  f.commit(work.dir, 'notes.txt', 'first\nfrom the lane\n', 'lane changes notes')
  const tip = git(work.dir, 'rev-parse', 'HEAD')
  writeFileSync(join(f.repo, 'draft.txt'), 'draft\nsomebody is still writing this\n')
  f.arm()
  const before = git(f.repo, 'rev-parse', 'master')
  const done = f.lane('ready', '--session', 'sess-b')
  ok('a lane with nothing in its way lands', done.code === 0 && git(f.repo, 'log', '-1', '--format=%s', 'master') === `merge lane ${work.lane}`, done.err || done.out)
  ok('as a real merge: master before, then the lane', git(f.repo, 'log', '-1', '--format=%P', 'master') === `${before} ${tip}`)
  ok('the main folder shows the lane\'s file', readFileSync(join(f.repo, 'notes.txt'), 'utf8') === 'first\nfrom the lane\n')
  ok('an unrelated unsaved edit is untouched', readFileSync(join(f.repo, 'draft.txt'), 'utf8') === 'draft\nsomebody is still writing this\n')
  const kept = f.ledgerKept()
  ok('every ledger line is still there', kept.written > 0 && !kept.lost.length, `${kept.written} written, lost: ${kept.lost.join(', ')}`)
  ok('and it went to origin', git(f.repo, 'rev-parse', 'origin/master') === git(f.repo, 'rev-parse', 'master'))
  ok('nothing saved away', !f.wipCommits().length, f.wipCommits().join('\n'))
}

// ------------------------------------------- two lanes that meet only at the release

{
  const f = fixture('meet-at-release')
  const x = f.claim('sess-x')
  const y = f.claim('sess-y')
  const p = f.claim('sess-p')
  const q = f.claim('sess-q')
  f.commit(x.dir, 'notes.txt', 'first\nx\n', 'x changes notes')
  f.commit(y.dir, 'notes.txt', 'first\ny\n', 'y changes notes the other way')
  f.commit(p.dir, 'src/index.ts', SRC(["import { fromP } from './p'"]), 'p adds an import')
  f.commit(q.dir, 'src/index.ts', SRC(["import { fromQ } from './q'"]), 'q adds an import')
  // All four finished at once: ready marks as `ready` writes them, then one release.
  const s = f.state()
  for (const [w, session] of [[x, 'sess-x'], [y, 'sess-y'], [p, 'sess-p'], [q, 'sess-q']])
    s.ready[w.lane] = { at: Date.now(), commit: git(w.dir, 'rev-parse', 'HEAD'), commits: 1, session }
  writeFileSync(join(f.repo, '.git', 'paneforge-lanes.json'), JSON.stringify(s, null, 2) + '\n')
  writeFileSync(join(f.repo, 'draft.txt'), 'draft\nsomebody is still writing this\n')
  f.arm()
  const done = f.lane('ship', '--session', 'sess-release')
  const said = `${done.out}\n${done.err}`
  const after = f.state()
  const log = git(f.repo, 'log', '--format=%s', 'master')
  ok('the first of two clashing lanes lands', log.includes(`merge lane ${x.lane}`), said)
  ok('the second is recorded as a conflict, naming the file', /notes\.txt/.test(after.conflicts?.[y.lane]?.detail ?? ''), JSON.stringify(after.conflicts))
  ok('and keeps its ready mark', Boolean(after.ready?.[y.lane]))
  ok('two lanes that only each added an import both land, settled by the machine', log.includes(`merge lane ${p.lane}`) && log.includes(`merge lane ${q.lane}`), said)
  const src = readFileSync(join(f.repo, 'src', 'index.ts'), 'utf8')
  ok('with both imports and no markers', src.includes('fromP') && src.includes('fromQ') && !/<<<<<<<|>>>>>>>/.test(src), src)
  ok('the settled merge is a real merge too', git(f.repo, 'log', '-1', '--format=%P', `master^{/merge lane ${q.lane}}`).split(' ').length === 2)
  ok('no merge is left half done in the main folder', !f.midMerge())
  ok('the main folder holds no conflict markers', readFileSync(join(f.repo, 'notes.txt'), 'utf8') === 'first\nx\n')
  ok('an unrelated unsaved edit is untouched', readFileSync(join(f.repo, 'draft.txt'), 'utf8') === 'draft\nsomebody is still writing this\n')
  const kept = f.ledgerKept()
  ok('every ledger line is still there', kept.written > 0 && !kept.lost.length, `${kept.written} written, lost: ${kept.lost.join(', ')}`)
  ok('no scratch folder is left registered', !f.scratchLeft().length, f.scratchLeft().join('\n'))
  ok('nothing saved away', !f.wipCommits().length, f.wipCommits().join('\n'))
}

// ------------------------------------------- lanes that compile apart but not together

{
  const f = fixture('red-once-merged')
  const work = f.claim('sess-b')
  f.commit(work.dir, 'breaks.txt', 'x\n', 'lane adds what breaks the build with master')
  writeFileSync(join(f.repo, 'draft.txt'), 'draft\nsomebody is still writing this\n')
  f.arm({ failIf: 'breaks.txt' })
  const before = git(f.repo, 'rev-parse', 'master')
  const done = f.lane('ready', '--session', 'sess-b')
  const said = `${done.out}\n${done.err}`
  ok('a merged tree that does not compile is not pushed', /did not compile once merged/.test(said) && git(f.repo, 'rev-parse', 'origin/master') === before, said)
  ok('master goes back where it was', git(f.repo, 'rev-parse', 'master') === before)
  ok('and the lane\'s file leaves the main folder with it', !existsSync(join(f.repo, 'breaks.txt')))
  ok(
    'an unrelated unsaved edit survives putting master back',
    readFileSync(join(f.repo, 'draft.txt'), 'utf8') === 'draft\nsomebody is still writing this\n',
    `draft.txt is now: ${JSON.stringify(readFileSync(join(f.repo, 'draft.txt'), 'utf8'))}`
  )
  const kept = f.ledgerKept()
  ok('every ledger line is still there', kept.written > 0 && !kept.lost.length, `${kept.written} written, lost: ${kept.lost.join(', ')}`)
}

// ------------------------- a lane put back off master is still waiting to go out
//
// 2026-10-07, 8:36-8:51pm, PaneForge: a release merged lane a into master and waited on the
// PC for master's suite. Meanwhile another chat's lane command found lane a's commits on
// master and dropped its ready mark ("nothing on lane-a that master does not already
// have"). The suite never got its turn, the release put master back - and lane a's finished
// work sat on its branch with nothing left saying it was ready to go out.

{
  const f = fixture('put-back-stays-ready')
  const work = f.claim('sess-b')
  f.commit(work.dir, 'breaks.txt', 'x\n', 'lane adds what breaks the build with master')
  f.arm({ failIf: 'breaks.txt', during: ['release', '--session', 'sess-elsewhere'] })
  const before = git(f.repo, 'rev-parse', 'master')
  const done = f.lane('ready', '--session', 'sess-b')
  const said = `${done.out}\n${done.err}`
  ok('the release puts master back', /did not compile once merged/.test(said) && git(f.repo, 'rev-parse', 'master') === before, said)
  const after = f.state()
  ok('the lane it put back is still marked ready', Boolean(after.ready?.[work.lane]), JSON.stringify({ ready: after.ready, passed: after.passed }))
  ok('and is not noted as passed over', !after.passed?.[work.lane], JSON.stringify(after.passed))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
