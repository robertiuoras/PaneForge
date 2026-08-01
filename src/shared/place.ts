// Where a pane actually is, in words a person can act on.
//
// The app knew four separate facts about every pane - a folder, a branch, a worktree
// suffix the app invented, and (on this machine only) a PaneForge development lane - and
// drew each of them as its own chip, in its own vocabulary, with the PROJECT missing from
// all four. The report that started this file was "lanes main master, I have no idea which
// project that is", and it was exactly right: `main` is a lane id, `master` is a branch,
// and neither of them is the name of anything you could go and look at.
//
// So there is one answer now and it always starts with the project.
//
// The shape of that answer is borrowed rather than invented:
//
// - Claude Code's own worktrees are `.claude/worktrees/<name>` on branch `worktree-<name>`,
//   with a generated slug ("bright-running-fox") when you do not name one; Conductor gives
//   each parallel worktree a city name. Both NAME THE COPY and neither names the project,
//   which is fine when the tool only ever holds one repo and wrong here.
// - No editor hides a default branch: VS Code prints `main` in the status bar like any
//   other. The one shipped product that replaces it with something better is Vercel, which
//   calls the default branch's deployments "Production" - a ROLE where the name would be.
//   That is the trick used below: `master` is not hidden, it is answered. The main checkout
//   says so, and a branch only appears when it is telling you something the project name
//   is not.
// - The numbers are ours. A copy is `#2` because Ctrl+2 is what switches to it, so the
//   label and the keystroke are the same character - which is worth more than a city name.
//
// Pure, so scripts/place-test.mjs can compile this one file and assert the sentences. What
// this module produces is read at a glance in a sidebar; getting it wrong is invisible in
// a screenshot and obvious after twenty minutes of looking for the right window.

/** Branch names that mean "the trunk" rather than "some work". */
export const TRUNK = ['main', 'master', 'trunk', 'default', 'develop']

export function isTrunk(branch: string): boolean {
  return TRUNK.includes(branch.trim().toLowerCase())
}

/** The last segment of a path, whichever way its separators lean. */
export function folderName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * The project a folder belongs to, with any copy-suffix taken back off.
 *
 * `known` is the suffix the caller already knows this folder carries - a lane id from the
 * lane file, or the `w2` the app stamped on the session. Guessing instead would be wrong
 * on real repositories: `-a` is a legitimate ending for a project name, and a person whose
 * repo is called `service-a` must not see it listed as `service`. Only `-w<digits>` is
 * stripped unasked, because that shape is one the app itself creates.
 */
export function projectOf(dir: string, known?: string): string {
  const name = folderName(dir)
  if (known && known !== 'main') {
    const suffix = '-' + known
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) return name.slice(0, -suffix.length)
  }
  const auto = /^(.*)-w\d+$/.exec(name)
  if (auto) return auto[1]
  // Claude Code's own layout: <repo>/.claude/worktrees/<slug>. The project is three
  // levels up, and the folder name is a generated slug that names nobody's project.
  const parts = dir.split(/[\\/]/).filter(Boolean)
  const at = parts.lastIndexOf('worktrees')
  if (at >= 2 && parts[at - 1] === '.claude') return parts[at - 2]
  return name
}

export type PlaceKind = 'main' | 'copy' | 'lane'

/**
 * A branch that some tool invented to hold a copy, rather than one a person made.
 *
 * `pf/w2` is this app's, `lane-a` is the lane script's, `worktree-<slug>` is Claude
 * Code's. None of them says anything the copy's own number has not already said, so they
 * come off the chip - while a real branch checked out INSIDE a copy stays, because that
 * is a person telling you what the copy is for.
 */
export function isGeneratedBranch(branch: string, slot: string): boolean {
  const b = branch.trim().toLowerCase()
  if (!b) return false
  if (/^worktree-/.test(b)) return true
  if (!slot) return false
  const s = slot.toLowerCase()
  return b === `pf/w${s}` || b === `lane-${s}` || b === `w${s}` || b === s
}

export interface PlaceInput {
  /** the folder the pane is open in */
  cwd: string
  /** current branch, when a git badge has read one */
  branch?: string
  /** the worktree copy the app made for this pane, e.g. "w2" */
  copy?: string
  /** a development lane id ("a"), for a repo that runs the lane system */
  lane?: string
  /**
   * The pane's switch number, 1-9, when it has one. Ctrl+N focuses it, so this is the
   * one label in the app that is also a keystroke.
   */
  pane?: number
}

export interface Place {
  project: string
  kind: PlaceKind
  /** "2" for a copy, "a" for a lane, "" for the main checkout */
  slot: string
  /** the branch, always - the short label decides whether to print it */
  branch: string
  /** true when the branch is the trunk and so says nothing a project name does not */
  onTrunk: boolean
  /** the chip: at most three words, project first, always */
  short: string
  /** what the copy IS, for a second line: "main checkout", "copy #2", "lane a" */
  role: string
  /** the tooltip: every fact, spelled out */
  full: string
}

/**
 * One line naming a place, and one paragraph explaining it.
 *
 * The rule the whole thing turns on: the project name is never omitted and never abbreviated,
 * and everything else is only added when it is not implied. A single pane in a single repo on
 * its trunk reads `PaneForge`, full stop - which is the common case, and the common case is
 * what a person is reading past on the way to the unusual one.
 */
export function describePlace(input: PlaceInput): Place {
  const branch = (input.branch ?? '').trim()
  const onTrunk = branch === '' || isTrunk(branch)
  const known = input.copy ?? input.lane
  const project = projectOf(input.cwd, known)

  const kind: PlaceKind = input.copy ? 'copy' : input.lane && input.lane !== 'main' ? 'lane' : 'main'
  const slot = input.copy ? input.copy.replace(/^w/i, '') : kind === 'lane' ? (input.lane ?? '') : ''

  const role =
    kind === 'copy'
      ? `copy #${slot}`
      : kind === 'lane'
        ? `lane ${slot}`
        : 'main checkout'

  // The branch earns its place on the chip by disagreeing with something. On the trunk it
  // does not, and "PaneForge · master" is two words to say one - the Vercel rule. Nor does
  // the branch a tool generated to hold this copy, which repeats the copy's own number.
  const machinery = isGeneratedBranch(branch, slot)
  const tail = [
    kind === 'copy' ? `#${slot}` : kind === 'lane' ? `lane ${slot}` : '',
    onTrunk || machinery ? '' : branch
  ].filter(Boolean)
  const short = [project, ...tail].join(' · ')

  // No branch line at all when there is no branch to state.
  //
  // This said "not a git checkout" and was wrong wherever the caller simply had not asked
  // git - which is the sidebar, deliberately: a card would otherwise cost a `git status`
  // per pane to print a word. Measured in the real window, a card for a repository with 19
  // uncommitted files carried a tooltip claiming it was not a repository. An absent fact
  // and a known-negative fact are not the same thing, and only one of them is safe to
  // assert.
  const full = [
    `${project} - ${role}`,
    branch ? `on ${branch}${onTrunk ? ' (the trunk)' : ''}` : '',
    input.pane ? `pane ${input.pane}` : '',
    input.cwd
  ]
    .filter(Boolean)
    .join('\n')

  return { project, kind, slot, branch, onTrunk, short, role, full }
}

/**
 * Two panes are "in the same place" when a change in one can land on top of the other.
 *
 * Same project and same checkout. Different copies of one project are deliberately NOT the
 * same place - that is the entire reason copies exist.
 */
export function samePlace(a: Place, b: Place): boolean {
  return a.project === b.project && a.kind === b.kind && a.slot === b.slot
}

/**
 * How a chat is named once its pane is known.
 *
 * Every id in this app used to be printed as its first eight hex characters, which is a
 * correct answer to "which chat" and a useless one to a person, who has never seen that
 * string anywhere else. A pane number is on screen, on the card, and on the keyboard.
 */
export function paneRef(pane?: number, session?: string | null): string {
  if (pane) return `pane ${pane}`
  if (session) return `chat ${session.slice(0, 6)}`
  return 'another chat'
}
