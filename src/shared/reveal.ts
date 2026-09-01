// Which folder "open this project" opens.
//
// It has always answered the PROJECT root - walk up out of a worktree, out of a package,
// and show the repo. That is right for a pane working on the repo, and wrong for the way
// Robert actually uses one repo: a pane per client, each named after the folder inside it
// that its whole session is about. Robert, 2026-08-29: "when i open project folder from
// that button in header, if session name is Sonia in clients project then it should open
// Sonia folder within clients because we working on only her stuff in that session."
//
// So the root is the FALLBACK, not the answer. The answer is the deepest folder this pane
// is demonstrably about, and there are exactly two ways to know that:
//
//   - the pane's own cwd, when it is already inside the root. A pane opened at
//     `clients/sonia` needs no name matching at all, and that case has to win outright or
//     a rename would move the button off the folder the agent is actually working in.
//   - a folder named after the pane, directly under the cwd. A rename is the one thing in
//     this app that says what a pane is FOR, and the match is only believed when a real
//     directory carries that name - a name that matches nothing on disk is just a label.
//
// The refusals are the feature. A name is matched against the folders that exist, never
// grafted onto the path as text: `title` is user input, so `../..`, an absolute path, a
// separator or a name that is simply not there must all fall through to the root rather
// than opening somewhere else on the machine. Matching is case-insensitive because a pane
// called `Sonia` is the folder `sonia` on a case-sensitive disk, and never fuzzy: the
// second-best folder is the wrong one, and this button opens a window on somebody's disk.
//
// Pure: no `fs`, no `path`. The caller reads the directory and hands the names in.
// `npm run test:reveal`.

/** What the choice is made from. Every path is absolute and already resolved. */
export interface RevealAsk {
  /** the project root, which is what this button answered before */
  root: string
  /** the pane's own working directory */
  cwd: string
  /** the pane's title - a rename, or the folder name it was born with */
  title?: string
  /**
   * The folder of the client this pane is for, absolute, already proved to exist by the
   * caller. A client pane is named out of a README heading - `Adie Bradley` - and the
   * folder holding them is a slug two levels down (`clients/clients/a4-advocate`), so the
   * title matches no subfolder of the cwd and the name match above cannot find it. This
   * is the caller handing the answer over rather than a name to graft on: absent means
   * nobody found one, and it is still refused unless it is inside the root.
   */
  clientDir?: string
  /**
   * The immediate subfolder NAMES of `cwd`, as read off disk. Empty (or absent) means
   * nobody looked, which is not the same as "there are none" - both fall through to the
   * cwd, and neither is allowed to invent a path.
   */
  subdirs?: string[]
  /** the platform separator, so a Windows path is picked apart correctly */
  sep?: string
}

/** True when `child` is `parent` or lives underneath it. */
export function within(parent: string, child: string, sep = '/'): boolean {
  if (parent === child) return true
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}

/**
 * A title may name a folder only if it is a plain name: no separator of either kind, no
 * drive letter, no `.`/`..`, nothing empty. Anything else is a label, not a path.
 */
export function nameable(title: string | undefined): boolean {
  const t = (title ?? '').trim()
  if (!t || t === '.' || t === '..') return false
  if (t.includes('/') || t.includes('\\') || t.includes(':')) return false
  return true
}

/**
 * The folder to open. Never invents a path: every answer is `cwd`, `root`, or `cwd` plus
 * one name that was read off disk.
 */
export function revealTarget(ask: RevealAsk): string {
  const sep = ask.sep ?? '/'
  // A pane already inside the root is its own answer, whatever it is called.
  const base = ask.cwd && within(ask.root, ask.cwd, sep) ? ask.cwd : ask.root
  if (nameable(ask.title)) {
    const want = (ask.title as string).trim().toLowerCase()
    // The pane is already sitting in the folder it is named after: nothing deeper to open.
    const leaf = base.split(sep).filter(Boolean).pop()
    if (leaf?.toLowerCase() === want) return base
    const hit = (ask.subdirs ?? []).find((d) => d.toLowerCase() === want)
    if (hit) return base + (base.endsWith(sep) ? '' : sep) + hit
  }
  // A client folder is only ever a step DOWN. It has to be inside the root, and it may
  // not move the button up out of a cwd that is already deeper - a pane working in
  // `clients/a4-advocate/site` means the site, not the client.
  if (ask.clientDir && within(ask.root, ask.clientDir, sep) && !within(ask.clientDir, base, sep))
    return ask.clientDir
  return base
}
