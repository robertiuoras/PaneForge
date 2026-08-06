#!/usr/bin/env node
// What the other agent-runners did since the last time anybody looked.
//
// TODO.md is a competitive backlog written on three dates - 2026-07-31, 2026-08-06 and
// 2026-08-07 - and each of those was somebody sitting down and reading seven READMEs by
// hand. That is why the gaps are found in batches months apart, and why Orca reached
// 38.7k stars before it appeared on the page at all. The work of noticing does not need a
// person and does not need a model: a release tag, a star count and a README hash are
// three API fields, and "the README changed" is the only trigger that has ever mattered.
//
//   node scripts/competitors.mjs            # fetch, report what moved, save the snapshot
//   node scripts/competitors.mjs --check    # same report, snapshot left alone (CI, hooks)
//   node scripts/competitors.mjs --json     # the changes as data
//
// The snapshot is CHECKED IN (`docs/competitors.state.json`) on purpose. `git diff` after
// a run is the report, it survives both machines, and a change nobody acted on stays
// visible instead of scrolling off a terminal.
//
// It reads GitHub through `gh api`, which is already a dependency of this repo's release
// path and is already authenticated on both machines. No token handling here, and a repo
// that has been renamed or deleted is reported as that rather than crashing the run.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const WATCHLIST = join(ROOT, 'competitors.json')
const STATE = join(ROOT, 'docs', 'competitors.state.json')

// A star count wanders by a handful an hour and none of that is news. This is the smallest
// move worth a line: below it the report is noise, and a report that is mostly noise stops
// being read, which is the only way this file can fail.
const STAR_NOISE = 0.05

// ---------------------------------------------------------------- the pure half (tested)

/**
 * What changed between two snapshots of one repo.
 *
 * Returns a list of plain strings because that is what both outputs want - the terminal
 * prints them and `--json` carries them - and because a change nobody can phrase is a
 * change nobody will act on.
 *
 * `prev` undefined means the repo is new to the watchlist: say so once and do not then
 * also report every field of it as having "changed" from nothing.
 */
export function changesFor(prev, next) {
  if (next.error) return [`could not be read: ${next.error}`]
  if (!prev) return [`added to the watchlist at ${fmtStars(next.stars)} stars${next.release ? `, latest ${next.release}` : ''}`]
  if (prev.error) return [`readable again at ${fmtStars(next.stars)} stars`]

  const out = []
  if (next.release && next.release !== prev.release) {
    out.push(`released ${next.release}${next.releasedAt ? ` on ${next.releasedAt.slice(0, 10)}` : ''}${prev.release ? ` (was ${prev.release})` : ''}`)
  }
  if (next.readmeSha && prev.readmeSha && next.readmeSha !== prev.readmeSha) {
    // The one that matters. A README is where every one of these projects states its
    // feature list, so a changed hash is "they are claiming something new" - which is
    // exactly the question TODO.md answers by hand.
    out.push('README changed - re-read the feature list')
  }
  if (next.description && next.description !== prev.description) {
    out.push(`describes itself as "${next.description}"`)
  }
  if (prev.stars > 0 && Math.abs(next.stars - prev.stars) / prev.stars >= STAR_NOISE) {
    const dir = next.stars > prev.stars ? '+' : ''
    out.push(`stars ${fmtStars(prev.stars)} → ${fmtStars(next.stars)} (${dir}${pct(prev.stars, next.stars)}%)`)
  }
  if (next.archived && !prev.archived) out.push('ARCHIVED - it stopped')
  if (!next.archived && prev.archived) out.push('un-archived - it restarted')
  return out
}

/** Every repo's changes, watchlist order, silent repos dropped. */
export function report(prevState, nextState) {
  const out = []
  for (const [repo, next] of Object.entries(nextState)) {
    const lines = changesFor(prevState[repo], next)
    if (lines.length) out.push({ repo, why: next.why, lines })
  }
  return out
}

function pct(a, b) {
  return (((b - a) / a) * 100).toFixed(0)
}

function fmtStars(n) {
  if (typeof n !== 'number') return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ---------------------------------------------------------------- the half that fetches

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true
  })
}

/**
 * One repo, as five fields.
 *
 * Every call is wrapped: a repo with no releases 404s on the releases endpoint, a repo
 * with no README 404s on that, and neither is an error - it is an answer. A run that dies
 * on the third of seven repos reports nothing about the other four, which would make this
 * exactly as reliable as remembering to look.
 */
function fetchRepo(repo) {
  let meta
  try {
    meta = JSON.parse(gh(['api', `repos/${repo}`, '--jq', '{stars: .stargazers_count, description: .description, archived: .archived, pushedAt: .pushed_at, full: .full_name}']))
  } catch (e) {
    return { error: firstLine(e.stderr ?? e.message) }
  }

  let release = null
  let releasedAt = null
  try {
    const r = JSON.parse(gh(['api', `repos/${repo}/releases/latest`, '--jq', '{tag: .tag_name, at: .published_at}']))
    release = r.tag
    releasedAt = r.at
  } catch {
    // No releases at all (tmux tags without releasing, and plenty of repos never publish
    // one). Not an error, just a field this repo does not have.
  }

  let readmeSha = null
  try {
    readmeSha = gh(['api', `repos/${repo}/readme`, '--jq', '.sha']).trim() || null
  } catch {
    // Same: a repo may have no README, and that is not worth failing a run over.
  }

  return {
    stars: meta.stars,
    description: meta.description,
    archived: meta.archived,
    pushedAt: meta.pushedAt,
    // A rename is a thing to know about and would otherwise look like a dead repo.
    movedTo: meta.full?.toLowerCase() === repo.toLowerCase() ? null : meta.full,
    release,
    releasedAt,
    readmeSha
  }
}

function firstLine(s) {
  return String(s).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160) ?? 'unknown error'
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------- run

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const asJson = argv.includes('--json')

  const watch = readJson(WATCHLIST, { repos: [] }).repos ?? []
  if (!watch.length) {
    console.error(`no repos in ${WATCHLIST}`)
    process.exit(1)
  }

  const prev = readJson(STATE, {})
  const next = {}
  for (const { repo, why } of watch) {
    next[repo] = { why, ...fetchRepo(repo) }
  }

  const changes = report(prev, next)

  if (asJson) {
    console.log(JSON.stringify({ changes, checkedRepos: watch.length }, null, 2))
  } else if (!changes.length) {
    console.log(`Nothing moved across ${watch.length} repos.`)
  } else {
    for (const { repo, why, lines } of changes) {
      console.log(`\n${repo}`)
      if (why) console.log(`  (${why})`)
      for (const l of lines) console.log(`  - ${l}`)
    }
    console.log(
      `\n${changes.length} of ${watch.length} moved. A README line means the feature list is worth re-reading into TODO.md.`
    )
  }

  if (!check) {
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  }
}

// Importable for the test without running a single network call.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main()
