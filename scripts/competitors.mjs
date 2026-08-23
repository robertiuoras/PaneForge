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
//
// Not every competitor has a repo. BridgeSpace is the same product as this one - a grid of
// agent panes, a board that dispatches them, shared agent memory - and it is closed source,
// so there is no README hash to watch and no stars to count. A `sites` entry watches the
// only thing such a product publishes: its own product page. The text of that page IS its
// feature list, so a changed hash means the same thing a changed README means, and the
// report says it in the same words.
//
// That domain sits behind Cloudflare and challenges an automated request some of the time:
// measured 2026-08-21, one node fetch went through and the next four were served the
// interstitial. A challenge is a fact about their edge, not about their product, so it is
// never reported as a change and never overwrites the last good reading - a watch that
// prints "could not be read" then "reachable again" on alternate runs is the noise failure
// this file's own thresholds exist to avoid. It is counted in a footer instead.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  // A bot check says nothing about the product. Reporting it would flap on alternate runs
  // and would also throw away the last good hash, which is the only baseline there is.
  if (next.blocked) return []
  if (next.error) return [`could not be read: ${next.error}`]
  if (!prev) {
    return [
      next.kind === 'site'
        ? `added to the watchlist${next.title ? ` as "${next.title}"` : ''}`
        : `added to the watchlist at ${fmtStars(next.stars)} stars${next.release ? `, latest ${next.release}` : ''}`
    ]
  }
  if (prev.error) {
    return [next.kind === 'site' ? 'reachable again' : `readable again at ${fmtStars(next.stars)} stars`]
  }

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
  if (next.pageSha && prev.pageSha && next.pageSha !== prev.pageSha) {
    // The `sites` half of the README line, and it means exactly the same thing: a product
    // page is where a closed-source competitor states its feature list.
    out.push('the page changed - re-read the feature list')
  }
  if (next.title && prev.title && next.title !== prev.title) {
    out.push(`the page calls itself "${next.title}"`)
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

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

/** Cloudflare's interstitial: a 403 whose body is the "Just a moment" page, not the site. */
export function isChallenge(status, body) {
  if (status !== 403 && status !== 503) return false
  return /Just a moment|cf-mitigated|Enable JavaScript and cookies|challenge-platform/i.test(body ?? '')
}

/**
 * One product page, as its visible text.
 *
 * The hash is over the TEXT, never the HTML: a marketing page ships a new build id, a new
 * script chunk name and a fresh nonce on every deploy, so hashing the markup would report
 * a change every single run and the report would stop being read - the one way this file
 * can fail. Copy is what changes when the product changes.
 */
async function fetchSite(url) {
  let html = null
  let lastError = null
  // Two tries: the challenge is served intermittently, so a retry is often the difference
  // between a reading and a blank. More than two would be a poll loop, not a watch.
  for (let attempt = 0; attempt < 2 && html === null; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9'
        },
        signal: AbortSignal.timeout(30_000)
      })
      const body = await res.text()
      if (isChallenge(res.status, body)) {
        lastError = null
        continue
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`
        continue
      }
      html = body
    } catch (e) {
      lastError = firstLine(e.message)
    }
  }
  if (html === null) return lastError ? { kind: 'site', error: lastError } : { kind: 'site', blocked: true }

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 120) || null
  const text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    kind: 'site',
    title,
    chars: text.length,
    pageSha: createHash('sha256').update(text).digest('hex').slice(0, 16)
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

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const asJson = argv.includes('--json')

  const list = readJson(WATCHLIST, { repos: [], sites: [] })
  const watch = list.repos ?? []
  const sites = list.sites ?? []
  if (!watch.length && !sites.length) {
    console.error(`nothing to watch in ${WATCHLIST}`)
    process.exit(1)
  }

  const prev = readJson(STATE, {})
  const next = {}
  for (const { repo, why } of watch) {
    next[repo] = { why, ...fetchRepo(repo) }
  }
  let blocked = 0
  for (const { url, why } of sites) {
    const read = await fetchSite(url)
    if (read.blocked) {
      blocked++
      // Keep the last good reading so the baseline survives a challenged run. With NO
      // previous reading, write no row at all: a `blocked` row would count as "seen
      // before", so the first successful read would compare against nothing and pass in
      // silence - the site would join the watchlist without ever being announced.
      if (prev[url]) next[url] = { ...prev[url], why }
      continue
    }
    next[url] = { why, ...read }
  }

  const changes = report(prev, next)

  if (asJson) {
    console.log(JSON.stringify({ changes, checkedRepos: watch.length, checkedSites: sites.length, blockedSites: blocked }, null, 2))
  } else if (!changes.length) {
    console.log(`Nothing moved across ${watch.length} repos and ${sites.length} sites.`)
  } else {
    for (const { repo, why, lines } of changes) {
      console.log(`\n${repo}`)
      if (why) console.log(`  (${why})`)
      for (const l of lines) console.log(`  - ${l}`)
    }
    console.log(
      `\n${changes.length} of ${watch.length + sites.length} moved. A README or page line means the feature list is worth re-reading into TODO.md.`
    )
  }

  if (blocked && !asJson) {
    // Said out loud rather than swallowed: a site behind a bot check was not checked, and
    // "nothing moved" must never be able to mean "nothing was read".
    console.log(`\n${blocked} of ${sites.length} sites were behind a bot check this run and were not re-read.`)
  }

  if (!check) {
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  }
}

// Importable for the test without running a single network call.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
