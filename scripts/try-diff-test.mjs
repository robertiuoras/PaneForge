// What `npm run try` says is different from the installed app.
//
// Built against a REAL throwaway repository rather than a hand-written log: the reading is
// `git log v<installed>..HEAD`, and a fixture that does not carry tags, merges and
// conventional-commit subjects proves nothing about the command that reads them.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffLines, report } from './try-diff.mjs'

let failed = 0
const ok = (what, cond) => {
  if (cond) console.log(`ok  ${what}`)
  else {
    failed++
    console.log(`FAIL ${what}`)
  }
}

const repo = mkdtempSync(join(tmpdir(), 'pf-trydiff-'))
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
const commit = (subject) => {
  writeFileSync(join(repo, 'f.txt'), String(Math.random()))
  git('add', '-A')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', subject)
}

git('init', '-q', '-b', 'master')
commit('feat: before the release')
git('tag', 'v9.9.9')
commit('feat(remote): the machine pick is a labelled box')
commit('chore: version bump')
commit('fix(try): --pull names origin trunk')
commit('docs: a note')

const got = diffLines(repo)
ok('compares against the newest tag when the installed version is unknown', got.base === 'v9.9.9')
ok('only feat/fix/perf reach the list', got.lines.length === 2)
ok(
  'the conventional-commit prefix is stripped and the sentence capitalised',
  got.lines.includes('The machine pick is a labelled box')
)
// Newest first, the order the log answers in: the last thing built is the first thing to check.
ok('newest change leads', got.lines[0] === '--pull names origin trunk')
ok('a chore is left out', !got.lines.some((l) => /version bump/i.test(l)))
ok('a doc note is left out', !got.lines.some((l) => /a note/i.test(l)))

// Nothing to say is SAID - a silent launch reads as "the script is broken".
const clean = mkdtempSync(join(tmpdir(), 'pf-trydiff-clean-'))
const cgit = (...args) => spawnSync('git', args, { cwd: clean, encoding: 'utf8' })
cgit('init', '-q', '-b', 'master')
writeFileSync(join(clean, 'f.txt'), 'x')
cgit('add', '-A')
cgit('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feat: it')
cgit('tag', 'v1.0.0')
ok('a build level with its release says so out loud', /Nothing user-visible differs/.test(report(clean)))

// No tags at all must not throw and must not claim a comparison it never made.
const bare = mkdtempSync(join(tmpdir(), 'pf-trydiff-bare-'))
spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: bare })
ok('an untagged checkout says there is nothing to compare against', /no release tag/.test(report(bare)))

// And the real repository answers without throwing, whatever it happens to hold today.
ok('this checkout answers', typeof report(process.cwd()) === 'string')

for (const d of [repo, clean, bare]) rmSync(d, { recursive: true, force: true })

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\ntry-diff ok')
