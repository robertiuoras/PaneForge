#!/usr/bin/env node
// The release body, built from the commits the release actually contains.
//
// Until now every release page said the same nine sentences about which file to
// download and then punted the interesting half - what changed - to a link to the
// commit list. That link is the wrong artefact for the person reading it: it shows
// merges, version bumps and lane bookkeeping mixed in with the two commits that are
// the release, and it dies the moment somebody rewrites history. The subjects are
// already Conventional Commits, so the answer is sitting in `git log`; this turns
// `feat:`/`fix:`/`perf:` into the three headings a reader wants and leaves the rest
// under one.
//
//   node scripts/release-notes.mjs [version] [--repo <dir>] [--changes-only]
//
// Prints the finished markdown on stdout. With no version it reads package.json.
// It never fails the release: no tags, no git, an empty range - each falls back to
// the commit-history link that was there before, because a release with awkward
// notes is better than a release job going red.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Conventional-commit type -> the heading a reader cares about. Order is the order
// they appear. `release:` and the lane merges are dropped outright, being bookkeeping
// rather than change.
//
// Anything NOT listed here is dropped too, and used to land under an "Other changes"
// heading. That heading was the whole reason the release pages read like a diary: a
// `docs:` subject is written for the next session in this repo - it names files, hooks
// and measurements - and a release page is read by somebody deciding whether to take
// the update. The three headings below are the only ones that answer that, and a
// subject with no conventional prefix is a defect in the commit rather than a change
// worth publishing. The work is still in `git log`, which is where that audience is.
const HEADINGS = [
  ['feat', 'New'],
  ['fix', 'Fixed'],
  ['perf', 'Faster']
]
const DROP = /^(release|chore\(release\)):\s*v?\d|^merge lane\b/i

// `auto-sync` is the mid-feature backup subject - it exists precisely to commit work that
// is not a change anybody is announcing, and it is not a defect in the wording either, so
// `unpublished` must not name it. Three of them touch src/ in this repo's history.
//
// It is NOT in DROP, deliberately. DROP feeds `subjects()`, which feeds `changeLog`,
// `bumpFor` and `smallOnly` - and `smallOnly` returns false on an EMPTY subject list, so
// adding it there flipped a range of nothing but backups from "small, wait for company"
// to "release now", which is the exact opposite of what an auto-sync commit means.
// Publishing was never affected (the hyphen means `parse` reads no type either way);
// the release TIMING was, silently. A rule that only one caller wants belongs to that
// caller.
const NOT_A_CHANGE = /^auto-sync\b/i

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 20_000
  })
}

function gitSafe(repo, args) {
  try {
    return git(repo, args)
  } catch {
    return null
  }
}

/** Tags newest-first, compared as numbers so v0.3.9 sorts below v0.3.10. */
export function versionTags(repo) {
  const out = gitSafe(repo, ['tag', '--list', 'v*'])
  if (!out) return []
  return out
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
    })
}

/**
 * The commit range this version introduced.
 *
 * The tag usually exists by the time notes are written (the release created it), but
 * the local fallback in lane.mjs can be a step ahead of it - so an unknown version
 * means "everything since the newest tag", which is exactly what is about to ship.
 */
export function rangeFor(repo, version) {
  const tags = versionTags(repo)
  const self = `v${version}`
  const i = tags.indexOf(self)
  const head = i === -1 ? 'HEAD' : self
  const prev = i === -1 ? tags[0] : tags[i + 1]
  return prev ? `${prev}..${head}` : head
}

/** Subjects of the non-merge commits in a range, bookkeeping removed. */
export function subjects(repo, range) {
  const out = gitSafe(repo, ['log', '--no-merges', '--format=%s', range])
  if (!out) return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !DROP.test(s))
}

/**
 * The changes this release page will NOT carry although they changed the app.
 *
 * `changeLog` publishes `feat:`, `fix:` and `perf:` and drops everything else, which is
 * right for the audience and silent about its own misses: v0.8.92 carried one commit,
 * `Fix browser image drags by fetching URIs instead of pasting URL strings`, which is
 * exactly what a reader deciding whether to update wants - and because the subject had
 * no conventional prefix the page said "see the commit history" instead. Nothing looked
 * wrong: the generator behaved as written, the release published, the notes test passed.
 *
 * So the miss is reported rather than guessed at. A subject is only worth naming when it
 * touched `src/` - a commit against a script, a doc or a test is not what the drop rule
 * is losing - and this NEVER changes what is published: rewriting the subject into a
 * heading would put a guess on a public page, and the fix is to word the commit as
 * `fix:` before it ships, which is the one moment `doctor` can still say so.
 */
export function unpublished(repo, range) {
  // %x00 in front of each subject, so the file names that follow a commit are told from
  // the next commit's subject without a second call per commit.
  const out = gitSafe(repo, ['log', '--no-merges', '--format=%x00%s', '--name-only', range])
  if (!out) return []
  const missed = []
  for (const block of out.split('\0')) {
    const [subject, ...rest] = block.split('\n')
    const s = (subject ?? '').trim()
    if (!s || DROP.test(s) || NOT_A_CHANGE.test(s)) continue
    // A `docs:` or `test:` subject touching src/ is dropped ON PURPOSE and is not a
    // miss - naming those is how this report becomes noise nobody reads (measured: the
    // first version of it flagged an ordinary docs commit against this repo's own
    // history). Only a subject with NO conventional prefix at all is the defect, since
    // that is the one whose author was describing a change and got no heading for it.
    if (parse(s).type !== null) continue
    if (rest.some((f) => f.trim().startsWith('src/'))) missed.push(s)
  }
  return missed
}

/** `fix(lanes): a dead chat's lane...` -> { type, scope, text } */
export function parse(subject) {
  const m = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
  if (!m) return { type: null, scope: null, text: subject }
  return { type: m[1].toLowerCase(), scope: m[2] || null, text: m[3] }
}

/**
 * The bump the commits in this release already asked for.
 *
 * Every automatic release used to be a patch, for a good reason: `ready` cannot express
 * "this one is a minor", and a release batches several chats' work, so no single chat is
 * entitled to decide. The subjects are - they say `feat:` or `fix:` per change, which is
 * the same source the notes above are built from, and reading them makes the decision
 * per RELEASE rather than per chat. So the version stops being a build counter: a run of
 * fixes moves the patch, and the release that carries a new feature moves the minor.
 *
 * This is the honest reading of the subjects and nothing else. What a release below 1.0
 * is allowed to DO with it is `nextVersion` below - see the rule there before changing
 * anything here.
 */
export function bumpFor(repo) {
  // Everything since the newest tag - the commits about to ship, which is NOT what
  // rangeFor(package.json version) answers: that tag already exists, so it would hand
  // back the range the LAST release covered and bump on last week's news.
  const latest = versionTags(repo)[0]
  let bump = 'patch'
  for (const s of subjects(repo, latest ? `${latest}..HEAD` : 'HEAD')) {
    if (/^[a-z]+(\([^)]+\))?!:/.test(s)) return 'major'
    if (parse(s).type === 'feat') bump = 'minor'
  }
  return bump
}

/**
 * Is everything waiting to go out a SMALL thing?
 *
 * "I don't want to release a new version every time for something like the running number
 * ghosting" - and he is right: a version is a claim that something changed, and a release
 * whose whole content is one CSS line teaches him to ignore the number. But a small fix
 * must not be held for ever either, so this decides one thing only - whether the batching
 * window is the ordinary half hour or the long one (`SMALL_HOLD_MS` in lane.mjs). Nothing
 * is ever dropped: held work sits on master and goes out with whatever lands next.
 *
 * Small means BOTH halves, because either alone is wrong. A `fix:` subject can carry a
 * 900-line rewrite, and a 4-line diff can be the last line of a feature - so it is the
 * types AND the size, and anything that says `feat`/`perf`/`!` is not small whatever its
 * diffstat says.
 */
export function smallOnly(repo, maxLines = 150) {
  const latest = versionTags(repo)[0]
  const range = latest ? `${latest}..HEAD` : 'HEAD'
  const list = subjects(repo, range)
  if (!list.length) return false
  const big = new Set(['feat', 'perf'])
  for (const s of list) {
    if (/^[a-z]+(\([^)]+\))?!:/.test(s)) return false
    if (big.has(parse(s).type ?? '')) return false
  }
  // `--shortstat` over the same range, so the size question is asked about exactly the
  // commits the subjects were read from.
  const stat = gitSafe(repo, ['diff', '--shortstat', range])
  const changed = [...(stat || '').matchAll(/(\d+) (?:insertion|deletion)/g)].reduce(
    (n, m) => n + Number(m[1]),
    0
  )
  return changed > 0 && changed <= maxLines
}

/**
 * The version an automatic release cuts, given the one it is on and the bump its commits
 * asked for. `typed` is a bump Robert named himself (`ship minor`), which is always obeyed.
 *
 * **Below 1.0 an automatic release only ever moves the patch.** Reading `feat:` as a minor
 * is the right rule for a released product and the wrong one here: below 1.0 almost every
 * commit adds something, so the minor stopped meaning "a batch of work landed" and started
 * meaning "a session happened". Measured 2026-08-07 - v0.4.62 became v0.8.0 inside a day
 * across six releases carrying seven commits between them, two of them `feat:`, and Robert
 * could no longer tell a week of work from a one-line fix by looking at the number.
 *
 * So below 1.0 the ladder is one step shorter and every rung has to be typed:
 *
 *   plain `feat:` / `fix:` / anything  -> patch, whatever the subjects say
 *   `feat!:` (a breaking change)       -> minor, the only bump a commit may still ask for
 *   `lane.mjs ship minor` / `major`    -> exactly that, because a person said so
 *
 * At 1.0 and above the usual semver reading comes back on its own: nothing is demoted, a
 * `feat:` is a minor and a `!` is a major.
 */
export function nextVersion(current, bump, typed = false) {
  const [maj, min, pat] = current.split('.').map(Number)
  let b = bump
  if (maj === 0 && !typed) {
    // Order matters: `!` lands on minor and stops there, it does not fall through to patch.
    if (b === 'major') b = 'minor'
    else if (b === 'minor') b = 'patch'
  }
  if (b === 'major') return `${maj + 1}.0.0`
  if (b === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

/**
 * The "What changed" section, or '' when there is nothing honest to say.
 *
 * Duplicate subjects collapse: a change cherry-picked into a lane and then merged
 * back appears twice in the range and once on the page.
 */
export function changeLog(repo, version) {
  const groups = new Map()
  const seen = new Set()
  for (const s of subjects(repo, rangeFor(repo, version))) {
    const { type, scope, text } = parse(s)
    const heading = HEADINGS.find(([t]) => t === type)?.[1]
    // Not a change a reader of the release page is deciding about - see HEADINGS.
    if (!heading) continue
    const line = scope ? `**${scope}** — ${text}` : text
    const key = `${heading}\u0000${line}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!groups.has(heading)) groups.set(heading, [])
    groups.get(heading).push(line)
  }
  if (!groups.size) return ''

  const order = HEADINGS.map(([, h]) => h)
  const parts = []
  for (const heading of order) {
    const lines = groups.get(heading)
    if (!lines?.length) continue
    parts.push(`### ${heading}\n\n${lines.map((l) => `- ${l}`).join('\n')}`)
  }
  return `## What changed\n\n${parts.join('\n\n')}`
}

// An older shape of the template said this instead of carrying a placeholder, because
// the workflow could only substitute {{VERSION}} and a raw {{CHANGES}} would have been
// published verbatim. Still handled: a release cut from a checkout older than the
// switch-over reads its own template, not this one.
const LINK_LINE = /^New in this build:.*$/m

/** Where to send a reader when there is nothing to list. */
function linkTo(repo, version) {
  let url = 'https://github.com/robertiuoras/PaneForge'
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    url = (pkg.repository?.url ?? url).replace(/\.git$/, '')
  } catch {
    // Keep the default: this is a fallback line, not worth failing a release over.
  }
  return `New in this build: see the [commit history](${url}/commits/v${version}).`
}

/**
 * The whole release body: the download instructions with the changes filled in.
 *
 * Every publisher goes through here - the workflow's `notes` job, `publishFallback`
 * for when Actions never ran, and `reconcileNotes` on the retry timer - so the three
 * cannot produce different pages.
 */
export function notes(repo, version) {
  const tpl = join(repo, '.github', 'release-notes.md')
  if (!existsSync(tpl)) return changeLog(repo, version)
  const body = readFileSync(tpl, 'utf8').replaceAll('{{VERSION}}', version)
  // Nothing parseable in the range - a re-tag, or a version whose only commit was its
  // own bump. Say where to look rather than leaving a blank space under a heading.
  const changes = changeLog(repo, version) || linkTo(repo, version)
  if (body.includes('{{CHANGES}}')) return body.replaceAll('{{CHANGES}}', changes)
  if (LINK_LINE.test(body)) return body.replace(LINK_LINE, changes)
  return `${body.trimEnd()}\n\n${changes}\n`
}

/** Has a published body already had the changes written into it? */
export function hasChanges(body) {
  return typeof body === 'string' && body.includes('## What changed')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const repoAt = argv.indexOf('--repo')
  const repo = repoAt === -1 ? join(HERE, '..') : argv[repoAt + 1]
  if (repoAt !== -1) argv.splice(repoAt, 2)
  const changesOnly = argv.includes('--changes-only')
  const version =
    argv.find((a) => !a.startsWith('--')) ??
    JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
  process.stdout.write((changesOnly ? changeLog(repo, version) : notes(repo, version)) + '\n')
}
