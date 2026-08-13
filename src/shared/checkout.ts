// Which folders in a projects root are second CHECKOUTS of another project rather than
// projects of their own.
//
// The launcher listed every directory under the root, and this desk's root holds eight
// lane worktrees - `PaneForge-a`, `taskdriver.ai-a`, `taskdriver.ai-b`, `toolstash-a`,
// `taskdriver-sessionA` ... - beside the eight repositories they are copies of. So "New
// session" opened on a list where half the rows were the same project twice, and picking
// the right one meant knowing which suffix the lane engine happened to use. Nobody
// launches into a lane by hand: the lane hook assigns one when a chat opens the project.
//
// The decision is PROVED, never guessed, because `-a` is a legitimate ending for a real
// project name (`service-a`) and hiding somebody's repository is worse than listing one
// copy too many:
//
//  - `.git` is a FILE whose `gitdir:` points into another repository's `.git/worktrees`.
//    That is git's own record of a linked worktree and it names the parent outright.
//  - or the folder is NOT a repository at all and sits next to a repository whose name it
//    extends by `-<letter>` or `-session<something>`. That is what a lane leaves behind
//    when its worktree is pruned but the directory is not - on this machine,
//    `taskdriver.ai-a` with no `.git` in it at all.
//
// Pure, so scripts/projects-test.mjs can assert the classification without a filesystem.

export interface FolderFacts {
  name: string
  /** the folder holds a `.git` DIRECTORY: a repository in its own right */
  isGit: boolean
  /** the contents of a `.git` FILE, when it is one - git writes `gitdir: <path>` */
  gitFile?: string | null
}

/** The parent named by a linked worktree's `.git` file, or '' when it is not one. */
export function worktreeParent(gitFile: string | null | undefined): string {
  if (!gitFile) return ''
  const m = /gitdir:\s*(.+)/.exec(gitFile)
  if (!m) return ''
  const parts = m[1].trim().split(/[\\/]/).filter(Boolean)
  const at = parts.lastIndexOf('worktrees')
  // .../<project>/.git/worktrees/<name>
  if (at >= 2 && parts[at - 1] === '.git') return parts[at - 2]
  return ''
}

/** A lane's leftovers: `<project>-a`, `<project>-b`, `<project>-sessionA`. */
const SUFFIX = /^(.+?)-(?:[a-z]|w\d+|session[a-z0-9]*)$/i

/**
 * folder name -> the project it is a copy of. Only names in `folders` are keys, and a
 * folder is never its own parent.
 */
export function checkoutOwners(folders: FolderFacts[]): Map<string, string> {
  const repos = new Set(folders.filter((f) => f.isGit).map((f) => f.name))
  const out = new Map<string, string>()
  for (const f of folders) {
    const linked = worktreeParent(f.gitFile)
    if (linked && linked !== f.name) {
      out.set(f.name, linked)
      continue
    }
    // A folder that IS a repository is a project, full stop - two clones of one repo are
    // two working copies a person made deliberately, and neither is a copy of the other.
    if (f.isGit || f.gitFile) continue
    const m = SUFFIX.exec(f.name)
    if (m && repos.has(m[1])) out.set(f.name, m[1])
  }
  return out
}
