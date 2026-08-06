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

const { bumpFor, changeLog, hasChanges, nextVersion, notes, rangeFor, versionTags, parse } =
  await import('./release-notes.mjs')

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

// 12. The template the workflow actually uses now that the token may write to
//     .github/workflows: a {{CHANGES}} placeholder, substituted by this script.
writeFileSync(join(repo, '.github', 'release-notes.md'), 'Download v{{VERSION}}\n\n{{CHANGES}}\n')
const placeheld = notes(repo, '0.3.10')
check('a {{CHANGES}} template is filled too', placeheld.includes('### Fixed'), placeheld)
check('and leaves no placeholder', !/\{\{[A-Z]+\}\}/.test(placeheld), placeheld)

// 13. A release with nothing to list must not leave a blank space where the changes
//     would have been - under either template shape.
const emptyPlaceheld = notes(repo, '0.4.1')
check('an empty {{CHANGES}} release links instead', emptyPlaceheld.includes('commit history'), emptyPlaceheld)
check('and leaves no placeholder either', !/\{\{[A-Z]+\}\}/.test(emptyPlaceheld), emptyPlaceheld)
check('and writes no empty heading', !emptyPlaceheld.includes('## What changed'), emptyPlaceheld)

writeFileSync(join(repo, '.github', 'release-notes.md'), `Download v{{VERSION}}\n\n${LINK}\n`)
const empty = notes(repo, '0.4.1')
check('an empty release still links somewhere', empty.includes('commit history'), empty)
check('and has no half-written heading', !empty.includes('## What changed'), empty)

// 14. hasChanges is what stops the reconcile in lane.mjs rewriting a body every minute.
check('hasChanges sees a written body', hasChanges(full))
check('hasChanges rejects the plain template', !hasChanges(empty))

// 15. The bump the commits ask for. Everything since the newest tag, never the range the
// last release already covered - reading package.json's own tag would bump on old news.
check(
  'a feat since the last tag asks for a minor',
  bumpFor(repo) === 'patch',
  `${bumpFor(repo)} (perf + a bare subject, so patch)`
)
commit('feat(stash): pin a snippet')
check('...and now a minor', bumpFor(repo) === 'minor', bumpFor(repo))
commit('fix(theme): contrast on Paper')
check('a later fix does not undo it', bumpFor(repo) === 'minor', bumpFor(repo))
commit('feat(remote)!: rename every session id')
check('a bang asks for a major', bumpFor(repo) === 'major', bumpFor(repo))

// 16. What a release is allowed to DO with that bump. Below 1.0 an automatic one only ever
// moves the patch - the rule that stops v0.4.62 becoming v0.8.0 in a day (2026-08-07).
check('below 1.0 an automatic feat: is a patch', nextVersion('0.4.62', 'minor') === '0.4.63')
check('and a run of fixes is the same patch step', nextVersion('0.4.62', 'patch') === '0.4.63')
check('a breaking change is the ONE bump a commit may still ask for', nextVersion('0.4.62', 'major') === '0.5.0')
check('...and it stops at minor, it does not fall through', nextVersion('0.4.62', 'major') !== '0.4.63')
check('a typed minor is obeyed as given', nextVersion('0.4.62', 'minor', true) === '0.5.0')
check('a typed major cuts 1.0.0, which nothing else may', nextVersion('0.4.62', 'major', true) === '1.0.0')
check('the patch resets on a minor', nextVersion('0.8.0', 'minor', true) === '0.9.0')
// At 1.0 the ordinary semver reading comes back with no demotion at all.
check('at 1.0 a feat: is a minor again', nextVersion('1.2.3', 'minor') === '1.3.0')
check('and a breaking change is a major again', nextVersion('1.2.3', 'major') === '2.0.0')
check('a patch is still a patch there', nextVersion('1.2.3', 'patch') === '1.2.4')

rmSync(root, { recursive: true, force: true })

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nrelease-notes: all good')
