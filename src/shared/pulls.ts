/**
 * What is waiting on GitHub for the projects open on this desk, in words.
 *
 * The reader here is the same one every other screen assumes: somebody who has never
 * run `git`. So the rows say what is TRUE of a change - nobody has looked at it, the
 * tests went red, it cannot go in until something is untangled - and the GitHub words
 * appear only where GitHub itself puts them on screen ("pull request", the number).
 *
 * Pure, so the wording can be pinned without a network or a `gh` on the machine.
 */

/** How GitHub's checks came back. `none` is a repository that runs none. */
export type CheckState = 'passing' | 'failing' | 'running' | 'none'
/** What the reviewers said. `waiting` is asked-and-unanswered. */
export type ReviewState = 'approved' | 'changes' | 'waiting' | 'none'

export interface PullRow {
  number: number
  title: string
  author: string
  draft: boolean
  /** the branch it is built on, shown because it is what a pane's badge also says */
  branch: string
  url: string
  /** epoch ms of the last thing that happened to it */
  updatedAt: number
  checks: CheckState
  review: ReviewState
  /** false when GitHub says it cannot go in as it stands */
  mergeable: boolean
  /** true when it was opened by the account this machine is signed in as */
  mine: boolean
}

/** A local branch with work on it that is not on GitHub, or not merged yet. */
export interface BranchRow {
  name: string
  /** commits it has that the main branch does not */
  ahead: number
  /** true when the same commits are already pushed somewhere */
  pushed: boolean
  updatedAt: number
}

export interface RepoPulls {
  /** the folder, which is also the key */
  path: string
  /** the project as the desk names it */
  name: string
  /** `owner/repo`, or null when the folder has no GitHub remote */
  remote: string | null
  /** the branch everything else is measured against */
  main: string
  pulls: PullRow[]
  branches: BranchRow[]
  /**
   * Files changed and not committed, in this folder.
   *
   * On a screen answering "what is waiting", edits nobody has saved into the project's
   * history are the most forgettable thing there is - they are on one machine, in one
   * folder, and no branch or pull request knows about them.
   */
  unsaved: number
  /** why this repository could say nothing, in the reader's words */
  trouble?: string
}

export interface PullsAnswer {
  repos: RepoPulls[]
  /** epoch ms this was read */
  at: number
  /** set when the GitHub command itself is missing or signed out */
  blocked?: string
}

/**
 * The one sentence a row leads with, worst news first.
 *
 * Order is deliberate and is not severity for its own sake: a draft is not waiting on
 * anyone, a red check makes a review pointless, and "nobody has looked at it" is the
 * only one of these the reader can fix by asking someone.
 */
export function pullWords(p: PullRow): string {
  if (p.draft) return 'Still being written'
  if (p.checks === 'failing') return 'Its tests went red'
  if (!p.mergeable) return 'Clashes with the main copy'
  if (p.review === 'changes') return 'Someone asked for changes'
  if (p.checks === 'running') return 'Tests still running'
  if (p.review === 'approved') return 'Approved - it can go in'
  return 'Nobody has looked at it yet'
}

/** Rows that want something from a person, so the button can carry a number. */
export function needsSomebody(p: PullRow): boolean {
  return !p.draft && (p.checks === 'failing' || p.review === 'changes' || p.review === 'waiting' || p.review === 'none')
}

/**
 * How many things across every project are waiting on somebody - the number the Tools
 * button shows. Local-only work counts too: a branch nobody has pushed is the most
 * forgotten thing on this list, which is the whole reason the screen exists.
 */
export function waitingCount(answer: PullsAnswer | null): number {
  if (!answer) return 0
  let n = 0
  for (const r of answer.repos) {
    n += r.pulls.filter(needsSomebody).length
    n += r.branches.filter((b) => !b.pushed).length
    if (r.unsaved > 0) n++
  }
  return n
}

/** The one line a folder with uncommitted edits gets. */
export function unsavedWords(n: number): string {
  return `${n} file${n === 1 ? '' : 's'} changed and not saved into the project yet`
}

/** A branch's own sentence. */
export function branchWords(b: BranchRow, main: string): string {
  const work = `${b.ahead} change${b.ahead === 1 ? '' : 's'}`
  if (!b.pushed) return `${work} only on this machine`
  return `${work} not in ${main} yet`
}

/**
 * Newest first, but anything asking for a person first of all.
 *
 * A list sorted purely by time puts a green approved pull request from an hour ago above
 * a red one from yesterday, which is the wrong way round for a screen whose job is "what
 * needs me".
 */
export function sortPulls(pulls: PullRow[]): PullRow[] {
  return [...pulls].sort((a, b) => {
    const wa = needsSomebody(a) ? 0 : 1
    const wb = needsSomebody(b) ? 0 : 1
    return wa - wb || b.updatedAt - a.updatedAt
  })
}

/** `2 hours ago`, the same shape History's rows use. */
export function agoWords(at: number, now: number): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
