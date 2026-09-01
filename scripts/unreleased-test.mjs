// Whether the app tells Robert what he is missing, or interrupts him for one commit.
//
// The rule being pinned is the THRESHOLD and what counts towards it. A session that
// suggests a release off a memory of what it built is guessing; this reads the installed
// version and the commits past it, and a bookkeeping commit must never be one of them.
//
//   node scripts/unreleased-test.mjs

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { behind, ENOUGH } from './unreleased.mjs'

const work = join(tmpdir(), 'pf-unreleased-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const git = (...a) =>
  execFileSync('git', ['-C', work, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@t')
git('config', 'user.name', 't')
git('config', 'commit.gpgsign', 'false')
const commit = (subject) => {
  writeFileSync(join(work, 'f.txt'), subject)
  git('add', '-A')
  git('commit', '-q', '-m', subject)
}

commit('feat: the thing that shipped')
git('tag', 'v1.0.0')

let checks = 0
const is = (got, want, why) => {
  assert.deepEqual(got, want, `${why}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`)
  checks++
}

is(behind('1.0.0', work).changes, [], 'an installed build at the newest tag is missing nothing')
is(behind('1.0.0', work).enough, false, '...so nothing is suggested')
is(behind(null, work).enough, false, 'no installed app is not a reason to suggest one')

commit('feat(panes): a pane says which client it is for')
commit('auto-sync (Roberts-MacBook-Pro) 2026-09-01 10:00:00')
commit('chore: bump a dependency')
const one = behind('1.0.0', work)
is(one.changes.length, 1, 'a chore and a mid-feature auto-sync are not changes a person sees')
is(one.other, 2, '...they are counted, so the sentence can say how much was housekeeping')
is(one.enough, false, `one is under the ${ENOUGH} that earns an interruption`)

commit('fix(clock): a countdown that only goes down')
commit('perf(term): fewer renders per keystroke')
const three = behind('1.0.0', work)
is(three.changes.length, ENOUGH, 'feat, fix and perf are all changes a person sees')
is(three.enough, true, '...and three of them is worth telling him about')
is(three.changes[0], 'fewer renders per keystroke', 'newest first, and the scope is stripped')
is(three.changes[2], 'a pane says which client it is for', '...the sentence itself is left alone')

// A version with no tag - a build installed from a branch - reads everything rather than
// silently saying "you have it all", which is the failure mode that would keep him on an
// old copy for ever.
is(behind('9.9.9', work).changes.length, 4, 'an unknown version reads the whole history, never nothing')

console.log(`unreleased: ${checks} checks passed`)
