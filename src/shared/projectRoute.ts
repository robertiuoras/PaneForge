// Which project is this message about?
//
// The failure this exists for costs nothing visible and a lot of everything else: a chat
// opened in project A, asked to do work in project B. Nothing stops it. The agent loads
// A's CLAUDE.md and A's memory index every turn, greps A's code indexes for B's symbols,
// spends six tool calls locating a folder it would have found in one, and - the part that
// is not merely wasteful - can write B's file into A's checkout. `cd` does not fix it,
// because the instructions and memory that make a session cheap are read once, at start.
//
// So the fix has to happen before the session exists, which means reading the only thing
// available at that moment: the first message. This module scores that text against every
// project's aliases and says which one it names, with a reason, or says it does not know.
//
// It is deliberately pure and deliberately dumb - no model call, no network, no fs. A
// wrong guess here is a wrong project pre-ticked in a dialog, so it has to be predictable
// enough to argue with, and fast enough to run on every keystroke.

/** Where an alias came from. Weights below are per source, strongest first. */
export type AliasKind = 'path' | 'domain' | 'remote' | 'pkg' | 'dir' | 'title'

export interface ProjectAlias {
  value: string
  kind: AliasKind
}

export interface RouteCandidate {
  name: string
  path: string
  aliases: ProjectAlias[]
}

export interface RouteMatch {
  name: string
  path: string
  score: number
  /** Human sentence for the UI: "names toolstash.xyz". Never a score. */
  why: string
  matched: string[]
}

export interface RouteResult {
  matches: RouteMatch[]
  /** Only ever true when one project is clearly ahead - see `LEAD` below. */
  confident: boolean
}

const WEIGHT: Record<AliasKind, number> = {
  path: 10,
  // A hostname is an explicit reference to one project and a folder name is a word that
  // might be incidental, so the gap between them has to be wide enough to clear `LEAD`
  // on its own: naming toolstash.xyz in a sentence that also says "paneforge" is not a
  // tie, and at 6 against 4 it was being scored as one.
  domain: 7,
  remote: 5,
  pkg: 4,
  dir: 4,
  title: 2
}

/**
 * Folder names that are also ordinary English. `assistant`, `work` and `crypto` are real
 * projects here, and they are also words that appear in sentences having nothing to do
 * with those folders ("write an assistant for..."). They still score, at a third, and
 * they can never be confident on their own - which is the whole point, because the
 * cheapest way to make this feature hated is to reroute a session on the word "work".
 */
const COMMON = new Set([
  'assistant', 'work', 'math', 'crypto', 'videos', 'video', 'logos', 'app', 'apps', 'api',
  'web', 'site', 'sites', 'test', 'tests', 'main', 'tools', 'tool', 'code', 'data', 'docs',
  'admin', 'server', 'client', 'core', 'shared', 'common', 'project', 'projects', 'temp',
  'new', 'old', 'demo', 'sample', 'script', 'scripts', 'build', 'release', 'money', 'crystal'
])

/** A match on something this short is noise, so short aliases only count when exact. */
const MIN_FUZZY = 5

/** How far ahead the top project must be before anything is done automatically. */
const LEAD = 1.6
const FLOOR = 4

/**
 * Lane checkouts are the same project. `Toolstash-a`, `PaneForge-w3` and `taskdriver-a`
 * are worktrees this app itself creates, and routing a fresh session into one of them
 * would drop a chat into a branch checkout another chat is holding. They fold into the
 * trunk folder instead, and only the trunk is ever offered.
 */
const LANE_SUFFIX = /^(.+?)-(?:[a-c]|w\d+)$/i

export function trunkOf(name: string): string | null {
  const m = LANE_SUFFIX.exec(name)
  return m ? m[1] : null
}

/**
 * Words worth matching on. Domains survive whole (`toolstash.xyz`) *and* get split, so
 * "toolstash.xyz/paneforge" can name a domain and a folder at once - which is exactly
 * what a message about one project's page for another project looks like.
 */
export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const raw of lower.split(/[^a-z0-9._-]+/)) {
    const word = raw.replace(/^[._-]+|[._-]+$/g, '')
    if (!word) continue
    out.add(word)
    if (word.includes('.') || word.includes('-') || word.includes('_')) {
      for (const part of word.split(/[._-]+/)) if (part.length > 2) out.add(part)
    }
  }
  return out
}

/**
 * Score every candidate against the text.
 *
 * A project scores its best single alias plus a small bonus for each additional distinct
 * alias that also matched, so "toolstash.xyz" beats a bare mention of "toolstash" without
 * letting a project win by having many near-identical aliases.
 */
export function routePrompt(text: string, candidates: RouteCandidate[]): RouteResult {
  const words = tokens(text)
  const lower = text.toLowerCase()
  const matches: RouteMatch[] = []

  for (const c of candidates) {
    let best = 0
    let bestAlias = ''
    let bestKind: AliasKind = 'dir'
    const hit = new Set<string>()

    for (const alias of c.aliases) {
      const value = alias.value.toLowerCase()
      if (!value) continue
      const generic = COMMON.has(value)

      let score = 0
      // The hostname the message actually used, when the project was named as a site.
      // The reason line has to quote what was in the message ("names toolstash.xyz"),
      // not the folder it resolved to, or it explains nothing.
      let sited: string | null = null
      if (alias.kind === 'path') {
        // An actual path in the message is not a guess, it is an instruction.
        if (lower.includes(value)) score = WEIGHT.path
      } else if (alias.kind !== 'domain' && (sited = sitedAs(words, value))) {
        // "toolstash.xyz" is a stronger claim than "toolstash", whether or not the repo
        // ever wrote its own domain down. Measured on the real projects folder: without
        // this, Robert's own message ("visit tracking to toolstash.xyz/paneforge") tied
        // Toolstash with PaneForge at folder-name weight and routed nowhere.
        score = WEIGHT.domain
      } else if (words.has(value)) {
        score = WEIGHT[alias.kind]
      } else if (value.length >= MIN_FUZZY) {
        // `toolstash-admin` in the text should still find `toolstash`; a bare substring
        // anywhere in the raw string should not, or `id4me` matches "id4menu".
        for (const w of words) {
          if (w.length > value.length && w.includes(value)) {
            score = WEIGHT[alias.kind] * 0.7
            break
          }
        }
      }
      if (!score) continue
      if (generic) score *= 0.35
      hit.add(value)
      if (score > best) {
        best = score
        bestAlias = sited ?? alias.value
        bestKind = sited ? 'domain' : alias.kind
      }
    }

    if (!best) continue
    const score = best + (hit.size - 1) * 0.5
    matches.push({
      name: c.name,
      path: c.path,
      score,
      why: reason(bestKind, bestAlias),
      matched: [...hit]
    })
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  const top = matches[0]
  const runnerUp = matches[1]?.score ?? 0
  // A generic-word-only win is never confident: `best` for such a project is at most
  // 4 * 0.35, which is under the floor, so the floor already enforces it.
  const confident = !!top && top.score >= FLOOR && top.score >= runnerUp * LEAD

  return { matches: matches.slice(0, 4), confident }
}

/**
 * Real top level domains, as an allowlist, shared with the alias scanner.
 *
 * It has to be an allowlist. As a blocklist of file extensions it was wrong on the first
 * real scan - `schema.prisma`, `paneforge-setup.exe`, `env.local` and `js.tmp` all came
 * back as websites - because a README is mostly filenames and there is no end to the
 * extensions people invent.
 *
 * `.app`, `.dev`, `.md` and `.sh` are left out despite being real: here they are
 * `PaneForge.app`, a dev script, a readme and a shell script far more often than they are
 * anybody's site.
 */
export const TLD = new Set([
  'com', 'net', 'org', 'io', 'ai', 'co', 'nz', 'au', 'uk', 'us', 'xyz', 'me', 'tv', 'cc',
  'gg', 'fm', 'ly', 'site', 'tech', 'cloud', 'store', 'shop', 'online', 'space', 'live',
  'studio', 'agency', 'digital', 'systems', 'works', 'run', 'page'
])

/** The hostname a message used for this project, if it named it as a site at all. */
function sitedAs(words: Set<string>, value: string): string | null {
  if (value.length < 4 || value.includes('.') || value.includes('/')) return null
  for (const w of words) {
    if (!w.startsWith(`${value}.`)) continue
    // `toolstash.xyz` and `ebb.co.nz` are sites; `toolstash.tsx` is a file.
    const rest = w.slice(value.length + 1).split('.')
    if (TLD.has(rest[rest.length - 1])) return w
  }
  return null
}

function reason(kind: AliasKind, alias: string): string {
  if (kind === 'path') return `names the path ${alias}`
  if (kind === 'domain') return `names ${alias}`
  if (kind === 'remote') return `names the repo ${alias}`
  return `names ${alias}`
}
