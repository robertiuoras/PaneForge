#!/usr/bin/env node
// The release body is generated from git history, so it is only as good as the range
// it picks - and picking the range wrong is silent: the page still renders, it just
// describes the wrong version. This builds a real repository with real tags and checks
// the four ways that goes wrong.
//
//   npm run test:notes
//
// Nothing here touches this checkout: everything happens in a temp repo that is
// deleted at the end.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { changeLog, hasChanges, notes, rangeFor, versionTags, parse } = await import(
  './release-notes.mjs'
)

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'pf-notes-'))
const repo = join(root, 'repo')
mkdirSync(repo)

const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

git('init', '-b', 'master')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test')
git('config', 'commit.gpgsign', 'false')

let n = 0
function commit(subject) {
  writeFileSync(join(repo, `f${n++}.txt`), subject)
  git('add', '-A')
  git('commit', '-m', subject)
}

// A history shaped like this repo's: two shipped versions, bookkeeping commits in
// between, and one version's worth of unreleased work on top.
commit('feat: the very first thing')
git('tag', 'v0.3.9')
commit('fix(lanes): a dead chat gives its lane back')
commit('feat(remote): type into a mirrored pane')
commit('docs: say what the heartbeat rules out')
commit('release: v0.3.10')
git('tag', 'v0.3.10')
commit('perf(git): cache the status call')
commit('not a conventional subject at all')

console.log('\nrelease-notes')

// 1. Tag order is numeric, not lexicographic. v0.3.9 sorting ABOVE v0.3.10 would make
//    every release after .9 diff against the wrong predecessor.
check('tags sort numerically', versionTags(repo)[0] === 'v0.3.10', versionTags(repo).join(','))

// 2. A tagged version describes the commits between the previous tag and its own.
check('range for a tagged version', rangeFor(repo, '0.3.10') === 'v0.3.9..v0.3.10', rangeFor(repo, '0.3.10'))

// 3. A version that has no tag yet - the local fallback path in lane.mjs, which can
//    write notes before the tag lands - means "everything since the newest tag".
check('range for an untagged version', rangeFor(repo, '0.3.11') === 'v0.3.10..HEAD', rangeFor(repo, '0.3.11'))

const body = changeLog(repo, '0.3.10')

// 4. Grouping, scope rendering and the two headings that matter.
check('feat lands under New', /### New\n\n- \*\*remote\*\* — type into a mirrored pane/.test(body), body)
check('fix lands under Fixed', /### Fixed\n\n- \*\*lanes\*\* — a dead chat gives its lane back/.test(body), body)
check('New comes before Fixed', body.indexOf('### New') < body.indexOf('### Fixed'), body)
check('docs lands under Other changes', /### Other changes\n\n- say what the heartbeat rules out/.test(body), body)

// 5. The version bump is not a change anybody wants to read about.
check('the release commit is dropped', !body.includes('release: v0.3.10'), body)

// 6. Nothing from the previous release leaks in.
check('older work stays out', !body.includes('the very first thing'), body)

// 7. A subject that is not conventional is still reported - dropping it would hide
//    real work from whoever forgot the prefix.
const head = changeLog(repo, '0.3.11')
check('unparseable subjects survive', head.includes('not a conventional subject at all'), head)
check('perf lands under Faster', /### Faster\n\n- \*\*git\*\* — cache the status call/.test(head), head)

// 8. parse() on the awkward shapes.
check('breaking-change bang parses', parse('feat!: rip it out').type === 'feat')
check('a bare subject has no type', parse('hello world').type === null)

// 9. The first release ever cut has no predecessor to diff against, so it describes
//    everything that led to it rather than nothing.
check('the first release describes all of it', changeLog(repo, '0.3.9').includes('the very first thing'))

// A version tagged on a commit that is already tagged: a re-tag, or a release cut
// with nothing new on master. Nothing to describe.
git('tag', 'v0.4.0')
git('tag', 'v0.4.1')

// 10. A range with nothing in it must not produce an empty "What changed" heading.
check('an empty range yields nothing', changeLog(repo, '0.4.1') === '', changeLog(repo, '0.4.1'))

// 11. The real template: no {{CHANGES}} placeholder, because the workflow that
//     publishes most releases only substitutes {{VERSION}} and cannot be edited from
//     this machine. The changes replace its commit-history line instead, and the
//     unsubstituted template must still read correctly - that is what CI publishes.
mkdirSync(join(repo, '.github'))
const LINK = 'New in this build: see the [commit history](https://x/commits/v{{VERSION}}).'
writeFileSync(join(repo, '.github', 'release-notes.md'), `Download v{{VERSION}}\n\n${LINK}\n`)
const full = notes(repo, '0.3.10')
check('the template keeps its own text', full.startsWith('Download v0.3.10'), full)
check('changes replace the commit link', full.includes('### Fixed') && !full.includes('New in this build'), full)
check('no placeholder survives', !/\{\{[A-Z]+\}\}/.test(full), full)

// 12. A template that DOES carry the placeholder still works, so the workflow can be
//     switched over the day the token has the scope for it.
writeFileSync(join(repo, '.github', 'release-notes.md'), 'Download v{{VERSION}}\n\n{{CHANGES}}\n')
const placeheld = notes(repo, '0.3.10')
check('a {{CHANGES}} template is filled too', placeheld.includes('### Fixed'), placeheld)
check('and leaves no placeholder', !/\{\{[A-Z]+\}\}/.test(placeheld), placeheld)

// 13. The empty case leaves the template alone rather than blanking it.
writeFileSync(join(repo, '.github', 'release-notes.md'), `Download v{{VERSION}}\n\n${LINK}\n`)
const empty = notes(repo, '0.4.1')
check('an empty release still links somewhere', empty.includes('commit history'), empty)
check('and has no half-written heading', !empty.includes('## What changed'), empty)

// 14. hasChanges is what stops the reconcile in lane.mjs rewriting a body every minute.
check('hasChanges sees a written body', hasChanges(full))
check('hasChanges rejects the plain template', !hasChanges(empty))

rmSync(root, { recursive: true, force: true })

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nrelease-notes: all good')
