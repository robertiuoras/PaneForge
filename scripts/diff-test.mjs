// What "Changes" says, against a real repository.
//
// The dialog is the easy half. The half that goes wrong silently is the reading: git's
// `-z` output puts the paths of a RENAME in two extra records with an empty field where
// the path normally is, so a parser that assumes one record per file shifts every
// subsequent entry by one and reports the wrong counts for the wrong files - with no
// error, and looking entirely plausible. Same for the line numbers down the side of a
// patch, which no part of the patch text states.
//
// So this builds a repository with one of each awkward thing in it - a rename, a file
// with a space in its name, an untracked file, a binary file, a file with no trailing
// newline - and asks the real code the real questions.
//
//   node scripts/diff-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), `pf-diff-test-${process.pid}`)
const repo = join(work, 'proj')
rmSync(work, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: out
  })
  return createRequire(import.meta.url)(out)
}
const { parsePatch, zSplit } = bundle('src/shared/patch.ts', 'patch.cjs')
const { diffFiles, diffPatch } = bundle('src/main/diff.ts', 'diff.cjs')

const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })

// ---------------------------------------------------------------------------
// The parser, on patches whose exact shape is the point

{
  const p = parsePatch(
    ['@@ -10,4 +10,5 @@ function thing() {', ' keep', '-gone', '+new one', '+new two', ' tail'].join('\n')
  )
  is(p.hunks.length, 1, 'one hunk')
  is(p.hunks[0].heading, 'function thing() {', 'the enclosing function is kept')
  const [keep, gone, one, two, tail] = p.hunks[0].lines
  is(keep.oldNo, 10, 'context starts at the old start')
  is(keep.newNo, 10, 'and at the new start')
  is(gone.oldNo, 11, 'a deletion advances the left side')
  is(gone.newNo, null, 'and has no number on the right')
  is(one.newNo, 11, 'an addition advances the right side')
  is(one.oldNo, null, 'and has none on the left')
  is(two.newNo, 12, 'the second addition follows it')
  is(tail.oldNo, 12, 'the context after them resumes on the left')
  is(tail.newNo, 13, 'and on the right, now shifted by the net change')
  is(p.added, 2, 'two lines added')
  is(p.removed, 1, 'one removed')
}

{
  // The marker git prints when a file does not end in a newline is not a line of the
  // file, and counting it as one puts every number after it out by one.
  const p = parsePatch(['@@ -1,2 +1,2 @@', ' first', '-second', '\\ No newline at end of file', '+second!'].join('\n'))
  const lines = p.hunks[0].lines
  is(lines[2].kind, 'meta', 'the no-newline marker is not a line of the file')
  is(lines[2].oldNo, null, 'and carries no number')
  is(lines[3].newNo, 2, 'the line after it is still line 2')
}

{
  // An empty line inside a hunk is a context line whose single leading space something
  // stripped. Treating it as the end of the patch loses the rest of the file.
  const p = parsePatch(['@@ -1,3 +1,3 @@', ' a', '', ' c'].join('\n'))
  is(p.hunks[0].lines.length, 3, 'a bare empty line stays inside the hunk')
  is(p.hunks[0].lines[2].oldNo, 3, 'and still advances the numbering')
}

{
  const p = parsePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')
  ok(p.binary, 'a binary patch says so')
  is(p.hunks.length, 0, 'and has no hunks to draw')
}

{
  const p = parsePatch(['@@ -1 +1 @@', '-a', '+b'].join('\n'))
  is(p.hunks[0].oldLines, 1, 'a hunk header with no count means one line')
  is(p.hunks[0].newLines, 1, 'on both sides')
}

is(zSplit('a\0b\0').length, 2, 'a -z stream does not end in an empty record')
is(zSplit('').length, 0, 'and an empty one has none at all')

// ---------------------------------------------------------------------------
// A real repository

git('init', '-q', '-b', 'main')
git('config', 'user.email', 'test@test')
git('config', 'user.name', 'test')
git('config', 'commit.gpgsign', 'false')
writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nthree\n')
writeFileSync(join(repo, 'moved.txt'), Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n')
writeFileSync(join(repo, 'with space.txt'), 'a\n')
git('add', '-A')
git('commit', '-qm', 'first')

// A branch with one commit on it, plus uncommitted work on top - the two scopes have to
// disagree, and that disagreement is the whole reason there are three of them.
git('checkout', '-q', '-b', 'feature')
writeFileSync(join(repo, 'committed.txt'), 'from the branch\n')
git('add', '-A')
git('commit', '-qm', 'second')

writeFileSync(join(repo, 'kept.txt'), 'one\nTWO\nthree\n')
git('mv', 'moved.txt', 'renamed.txt')
writeFileSync(join(repo, 'fresh.txt'), 'brand new\nsecond line\n')
writeFileSync(join(repo, 'no-newline.txt'), 'no trailing newline')
writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 4]))

{
  const set = await diffFiles(repo, 'working')
  is(set.problem, null, 'a real checkout has no problem to report')
  is(set.branch, 'feature', 'it names the branch it read')
  const by = Object.fromEntries(set.files.map((f) => [f.path, f]))

  ok(by['kept.txt'], 'a modified file is listed')
  is(by['kept.txt'].added, 1, 'with the lines it gained')
  is(by['kept.txt'].removed, 1, 'and the ones it lost')
  is(by['kept.txt'].status, 'modified', 'and called what it is')

  ok(by['renamed.txt'], 'a rename is listed under its new name')
  is(by['renamed.txt'].status, 'renamed', 'and called a rename')
  is(by['renamed.txt'].oldPath, 'moved.txt', 'and says where it came from')
  // The record after a rename is the one a -z parser gets wrong, and it is this file.
  ok(by['with space.txt'] === undefined, 'an untouched file is not listed at all')

  ok(by['fresh.txt'], 'a file git has never seen is listed')
  ok(by['fresh.txt'].untracked, 'and marked as untracked')
  is(by['fresh.txt'].added, 2, 'with the whole file counted as added')
  is(by['no-newline.txt'].added, 1, 'a file with no trailing newline is one line, not two')
  ok(by['blob.bin'].binary, 'an untracked binary file is spotted without diffing it')
  ok(by['committed.txt'] === undefined, 'work already committed is not "uncommitted"')
}

{
  const set = await diffFiles(repo, 'branch')
  is(set.base, 'main', 'the base of a branch with no upstream is the trunk beside it')
  const paths = set.files.map((f) => f.path)
  ok(paths.includes('committed.txt'), 'the branch scope shows what the branch committed')
  ok(!paths.includes('fresh.txt'), 'and not an untracked file, which no commit holds')
  ok(!paths.includes('kept.txt'), 'nor uncommitted edits')
}

{
  const set = await diffFiles(repo, 'all')
  const paths = set.files.map((f) => f.path)
  ok(paths.includes('committed.txt'), 'everything covers the branch...')
  ok(paths.includes('kept.txt'), '...and the uncommitted edits...')
  ok(paths.includes('fresh.txt'), '...and the files git has never seen')
}

{
  const p = await diffPatch(repo, 'working', 'kept.txt', false)
  const parsed = parsePatch(p.text)
  is(parsed.added, 1, 'the patch for one file holds that file')
  const changed = parsed.hunks[0].lines.find((l) => l.kind === 'add')
  is(changed.text, 'TWO', 'with the new line in it')
  is(changed.newNo, 2, 'numbered where it actually is in the file')
}

{
  // An untracked file has no blob to diff against, and `git add -N` would write the index
  // of a repo an agent is working in. The patch is written by hand instead.
  const p = await diffPatch(repo, 'working', 'fresh.txt', true)
  const parsed = parsePatch(p.text)
  is(parsed.added, 2, 'an untracked file is all additions')
  is(parsed.hunks[0].lines[0].text, 'brand new', 'with its real first line')
  is(parsed.hunks[0].lines[0].newNo, 1, 'numbered from one')

  const nl = parsePatch((await diffPatch(repo, 'working', 'no-newline.txt', true)).text)
  ok(
    nl.hunks[0].lines.some((l) => l.kind === 'meta'),
    'and says when the file it read has no final newline'
  )
}

{
  const p = await diffPatch(repo, 'working', 'blob.bin', true)
  ok(parsePatch(p.text).binary, 'an untracked binary file reports as binary rather than as mojibake')
}

// ---------------------------------------------------------------------------
// The answers that are not "here are the files"
//
// Each of these used to be indistinguishable from "nothing changed", which is the wrong
// answer to show beside a merge button.

{
  const plain = join(work, 'not-a-repo')
  mkdirSync(plain, { recursive: true })
  const set = await diffFiles(plain, 'working')
  ok(set.problem, 'a folder that is not a checkout says so')
  is(set.files.length, 0, 'and lists nothing')
}

{
  // A repo whose only branch IS the trunk has nothing to compare a branch scope against,
  // and saying "no changes" there would be a lie.
  const lone = join(work, 'lone')
  mkdirSync(lone, { recursive: true })
  const g = (...a) => spawnSync('git', a, { cwd: lone, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@test')
  g('config', 'user.name', 'test')
  writeFileSync(join(lone, 'a.txt'), 'a\n')
  g('add', '-A')
  g('commit', '-qm', 'only')
  const set = await diffFiles(lone, 'branch')
  ok(set.problem, 'a trunk with nothing beside it reports why, rather than showing nothing')
  const working = await diffFiles(lone, 'working')
  is(working.problem, null, 'while the uncommitted scope still works there')
  is(working.files.length, 0, 'and correctly says the folder is clean')

  // The case a probe caught against the real window: `all` on such a trunk answered "0
  // files" beside a folder holding fourteen changed ones, because half the question was
  // unanswerable. Half an answer plus a sentence beats none.
  writeFileSync(join(lone, 'a.txt'), 'a\nb\n')
  writeFileSync(join(lone, 'new.txt'), 'hello\n')
  const all = await diffFiles(lone, 'all')
  is(all.files.length, 2, 'everything falls back to what it CAN answer when there is no base')
  ok(all.problem, 'and says which half is missing')
  ok(/uncommitted/i.test(all.problem), 'in words that name what is being shown instead')
  const p = await diffPatch(lone, 'all', 'a.txt', false)
  ok(parsePatch(p.text).added === 1, 'and a file listed by that fallback opens with its real patch')
}

rmSync(work, { recursive: true, force: true })
console.log(`PASS diff: ${checks} assertions`)
