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
// - The labels are ours, and there are TWO of them, which is why they are worded apart.
//   `lane b` is another checkout of that project; `pane 3` is the third card in the
//   sidebar, and Ctrl+3 switches to it. They are independent - a project's second lane is
//   very often not the second pane on screen - so a bare `#2` on a card that already
//   carries a `3` key was one number too many with no way to tell which was which. Lanes
//   are lettered and panes are numbered for the same reason: two different labels on one
//   card should not both be digits. Only the pane number is ever a keystroke.
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

/**
 * A pane is either in a project's own checkout or in one of its lanes. There is no third
 * kind any more: the app used to call the extra checkouts it made "copies" (`<repo>-w2` on
 * `pf/w2`) while scripts/lane.mjs called its own "lanes" (`<repo>-a` on `lane-a`), and the
 * two systems made the same thing under two names, two folder shapes and two branch
 * prefixes. Anyone looking at a Projects folder saw `Toolstash-a` next to `Toolstash-w2`
 * and could not tell what the difference was, because there was not one.
 */
export type PlaceKind = 'main' | 'lane'

/**
 * A branch that some tool invented to hold a lane, rather than one a person made.
 *
 * `lane-b` is what this app and the lane script both create now; `pf/w2` is the shape the
 * app used before they were unified, still on disk wherever an old lane has not been
 * merged yet; `worktree-<slug>` is Claude Code's. None of them says anything the lane's own
 * label has not already said, so they come off the chip - while a real branch checked out
 * INSIDE a lane stays, because that is a person telling you what the lane is for.
 */
export function isGeneratedBranch(branch: string, slot: string): boolean {
  const b = branch.trim().toLowerCase()
  if (!b) return false
  if (/^worktree-/.test(b)) return true
  if (!slot) return false
  const s = slot.toLowerCase()
  return b === `lane-${s}` || b === `pf/${s}` || b === s
}

/**
 * Which copy of the project this is, counting the project's own folder as the first.
 *
 * The label a person reads must not be the label the machinery uses. `a`, `b`, `f` are
 * slots in a pool - they mean something to scripts/lane.mjs and nothing to somebody who
 * has never opened a terminal, and "copy f" on a card was read here as an error message.
 * A number is the thing everybody already understands: the project's own folder is copy 1,
 * the first extra one is copy 2. Legacy `w2` lanes already carry their number, and it is
 * the same counting - `w1` was never made because the project itself is 1.
 *
 * Null for a slot that is neither shape, so the caller prints it verbatim rather than
 * inventing a number for a folder nobody can find.
 */
export function copyNumber(slot: string): number | null {
  const s = slot.trim().toLowerCase()
  if (/^[a-z]$/.test(s)) return s.charCodeAt(0) - 'a'.charCodeAt(0) + 2
  const w = /^w(\d+)$/.exec(s)
  if (w) return Number(w[1])
  return null
}

export interface PlaceInput {
  /** the folder the pane is open in */
  cwd: string
  /** current branch, when a git badge has read one */
  branch?: string
  /**
   * The lane this pane is in: "a", "b", ... or "main" for the project's own checkout.
   * Legacy `w2`-style labels are still understood, for lanes made before the two naming
   * schemes were merged.
   */
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
  /** the lane's label ("a"), or "" for the project's own checkout */
  slot: string
  /** the branch, always - the short label decides whether to print it */
  branch: string
  /** true when the branch is the trunk and so says nothing a project name does not */
  onTrunk: boolean
  /** the chip: at most three words, project first, always */
  short: string
  /** what this folder IS, in words anybody reads: "main copy" or "copy 2" */
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
  const project = projectOf(input.cwd, input.lane)

  const kind: PlaceKind = input.lane && input.lane !== 'main' ? 'lane' : 'main'
  // The label as it is on disk, so the chip and the folder beside it read the same. A
  // legacy `w2` lane therefore says "lane w2" rather than being renamed in the UI to
  // something no folder is called.
  const slot = kind === 'lane' ? (input.lane ?? '') : ''

  const role = kind === 'lane' ? `copy ${copyNumber(slot) ?? slot}` : 'main copy'

  // The branch earns its place on the chip by disagreeing with something. On the trunk it
  // does not, and "PaneForge · master" is two words to say one - the Vercel rule. Nor does
  // the branch a tool generated to hold this lane, which repeats the lane's own label.
  const machinery = isGeneratedBranch(branch, slot)
  // A lane is named the way the FOLDER is named, and that is the whole change: the chip
  // used to read `clients · lane b` for a folder called `clients-b`, which is three words
  // for one fact and two of them are jargon - "lane" is this app's word, "b" is a letter
  // with no meaning next to it, and neither appears anywhere the person can look. The
  // folder name is the fact, it is already unique, and it is what `cd` takes.
  const tail = [onTrunk || machinery ? '' : branch].filter(Boolean)
  const head = kind === 'lane' ? `${project}-${slot}` : project
  const short = [head, ...tail].join(' · ')

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
 * Same project and same checkout. Two lanes of one project are deliberately NOT the same
 * place - that is the entire reason lanes exist.
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

/**
 * The lane a checkout is in, when its BRANCH proves it rather than its name.
 *
 * `place.ts` refuses to guess a lane off a folder suffix, and it is right to: `-a` is a
 * legitimate ending for a project name, and `service-a` must not be listed as `service`.
 * So the lane arrives from the caller - `Session.lane`, set by `main/lanes.ts` when THIS
 * app made the folder. A pane opened straight into a lane worktree that already existed
 * (a lane hook assigned it, `pf open` was pointed at it, somebody picked the folder) never
 * had one, and drew the raw folder name: `taskdriver.ai-c` where the answer is
 * `taskdriver.ai lane c`. Measured on this desk 2026-08-28: 2 of 8 saved panes.
 *
 * Both legs are required, which is what makes this evidence rather than the guess above.
 * The branch must be one a lane tool made (`lane-c`, `pf/w2`) AND the folder must carry
 * that same suffix. `service-a` on `main` is still a project called `service-a`; the same
 * folder on `lane-a` IS the a lane of `service`, and saying so is the whole point.
 */
export function laneOfCheckout(cwd: string, branch: string | undefined): string | undefined {
  const b = (branch ?? '').trim().toLowerCase()
  const m = /^(?:lane-([a-z])|pf\/(w\d+))$/.exec(b)
  if (!m) return undefined
  const slot = m[1] ?? m[2]
  return folderName(cwd).toLowerCase().endsWith('-' + slot) ? slot : undefined
}
