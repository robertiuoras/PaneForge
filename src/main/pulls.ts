/**
 * What GitHub and the local repository say about work in flight, for the projects that
 * have a pane open on this desk.
 *
 * Read on demand only - nothing here polls. The screen it feeds is a dialog somebody
 * opened, and a background job asking GitHub about six repositories every minute would
 * be a rate limit spent on a window nobody has open.
 *
 * `gh` is the whole GitHub half: it carries the user's own login and refuses politely
 * when it is missing or signed out, which is an answer worth showing rather than an
 * error worth hiding.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { which } from './which'
import type { BranchRow, PullRow, PullsAnswer, RepoPulls } from '../shared/pulls'

const run = promisify(execFile)

/** Long enough that reopening the dialog is free, short enough to still be today's news. */
const TTL_MS = 60_000
/** A repository with more open pull requests than this has a different problem. */
const LIMIT = 30
/** GitHub over a bad line must not hold the dialog open with a spinner. */
const TIMEOUT_MS = 20_000

let cached: PullsAnswer | null = null
let cachedKey = ''

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: TIMEOUT_MS, windowsHide: true })
  return stdout.trim()
}

/** The folder git calls the top of this repository, or null when it is not one. */
async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])) || null
  } catch {
    return null
  }
}

/**
 * The branch everything else is measured against.
 *
 * `origin/HEAD` is the honest answer and is missing on plenty of clones, so the two
 * usual names are tried in the order they are usual before giving up on the word.
 */
async function mainBranch(cwd: string): Promise<string> {
  try {
    const head = await git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const name = head.split('/').pop()
    if (name) return name
  } catch {
    /* no origin/HEAD on this clone */
  }
  for (const name of ['master', 'main']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', name])
      return name
    } catch {
      /* not this one */
    }
  }
  return 'master'
}

/** `owner/repo` for the origin remote, or null. */
async function remoteName(cwd: string): Promise<string | null> {
  try {
    const url = await git(cwd, ['remote', 'get-url', 'origin'])
    const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function checksOf(rollup: unknown): PullRow['checks'] {
  const rows = Array.isArray(rollup) ? (rollup as Record<string, string>[]) : []
  if (!rows.length) return 'none'
  let running = false
  for (const r of rows) {
    // A check run says `status` then `conclusion`; an old-style status context says
    // `state` and nothing else. Both shapes come back in the same array.
    const done = r.conclusion || r.state
    if (r.status && r.status !== 'COMPLETED') running = true
    if (done === 'FAILURE' || done === 'ERROR' || done === 'TIMED_OUT' || done === 'CANCELLED')
      return 'failing'
  }
  return running ? 'running' : 'passing'
}

function reviewOf(decision: string): PullRow['review'] {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes'
  if (decision === 'REVIEW_REQUIRED') return 'waiting'
  return 'none'
}

async function pullsFor(cwd: string, me: string): Promise<PullRow[]> {
  const { stdout } = await run(
    'gh',
    [
      'pr',
      'list',
      '--limit',
      String(LIMIT),
      '--json',
      'number,title,author,isDraft,headRefName,url,updatedAt,reviewDecision,mergeable,statusCheckRollup'
    ],
    { cwd, timeout: TIMEOUT_MS, windowsHide: true }
  )
  const rows = JSON.parse(stdout || '[]') as Record<string, any>[]
  return rows.map((r) => ({
    number: r.number,
    title: String(r.title ?? ''),
    author: String(r.author?.login ?? ''),
    draft: !!r.isDraft,
    branch: String(r.headRefName ?? ''),
    url: String(r.url ?? ''),
    updatedAt: Date.parse(r.updatedAt ?? '') || 0,
    checks: checksOf(r.statusCheckRollup),
    review: reviewOf(String(r.reviewDecision ?? '')),
    // `UNKNOWN` is GitHub still working it out, and calling that a clash would put a
    // red sentence on a pull request that is fine a second later.
    mergeable: r.mergeable !== 'CONFLICTING',
    mine: String(r.author?.login ?? '') === me
  }))
}

/**
 * Local work that is not in the main branch yet.
 *
 * The main branch itself is left out, and so is anything with nothing on it: a branch
 * level with master is not unfinished work, it is a name.
 */
async function branchesFor(cwd: string, main: string): Promise<BranchRow[]> {
  let listed = ''
  try {
    listed = await git(cwd, [
      'for-each-ref',
      '--format=%(refname:short)\t%(upstream:short)\t%(committerdate:unix)',
      'refs/heads'
    ])
  } catch {
    return []
  }
  const out: BranchRow[] = []
  for (const line of listed.split('\n')) {
    const [name, upstream, when] = line.split('\t')
    if (!name || name === main) continue
    let ahead = 0
    try {
      ahead = Number(await git(cwd, ['rev-list', '--count', `${main}..${name}`])) || 0
    } catch {
      continue
    }
    if (ahead <= 0) continue
    let pushed = false
    if (upstream) {
      try {
        pushed = Number(await git(cwd, ['rev-list', '--count', `${upstream}..${name}`])) === 0
      } catch {
        pushed = false
      }
    }
    out.push({ name, ahead, pushed, updatedAt: (Number(when) || 0) * 1000 })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Files changed and not committed here. A failed read counts as none, never as work. */
async function unsavedCount(cwd: string): Promise<number> {
  try {
    const out = await git(cwd, ['status', '--porcelain'])
    return out ? out.split('\n').filter((l) => l.trim()).length : 0
  } catch {
    return 0
  }
}

/** The login `gh` is signed in as, so a row can say whether it is the user's own. */
async function whoami(): Promise<string> {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], {
      timeout: TIMEOUT_MS,
      windowsHide: true
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Every repository behind the folders given, once each, with what is waiting in it.
 *
 * `refresh` is the button on the dialog; everything else is served from the last read
 * while it is under a minute old.
 */
export async function readPulls(cwds: string[], refresh = false): Promise<PullsAnswer> {
  const key = [...new Set(cwds)].sort().join('|')
  if (!refresh && cached && key === cachedKey && Date.now() - cached.at < TTL_MS) return cached

  if (!which('gh')) {
    const answer: PullsAnswer = {
      repos: [],
      at: Date.now(),
      blocked:
        'This needs GitHub’s own command line tool, which is not on this machine. Install `gh` and sign in, and this screen fills itself in.'
    }
    cached = answer
    cachedKey = key
    return answer
  }

  const roots = new Map<string, string>()
  for (const cwd of new Set(cwds)) {
    const root = await repoRoot(cwd)
    if (root) roots.set(root, root)
  }
  const me = await whoami()
  const repos: RepoPulls[] = []
  for (const root of roots.keys()) {
    const main = await mainBranch(root)
    const remote = await remoteName(root)
    const repo: RepoPulls = {
      path: root,
      name: basename(root),
      remote,
      main,
      pulls: [],
      branches: await branchesFor(root, main),
      unsaved: await unsavedCount(root)
    }
    if (remote) {
      try {
        repo.pulls = await pullsFor(root, me)
      } catch (e) {
        const text = String((e as Error)?.message ?? e)
        repo.trouble = /auth|login|HTTP 401/i.test(text)
          ? 'GitHub has not been signed in to on this machine yet.'
          : 'GitHub could not be asked about this project just now.'
      }
    }
    repos.push(repo)
  }
  repos.sort((a, b) => a.name.localeCompare(b.name))
  cached = { repos, at: Date.now() }
  cachedKey = key
  return cached
}
