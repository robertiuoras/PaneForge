// Which folder the pane's OWN folder button opens.
//
// Robert, 2026-09-03: "I'm in session 5 with Jacob, I press the folder button, it opens a
// different client folder, not the one that actually has the deliverable files and
// media." That pane ran in a lane copy (`clients-a`) and had pulled 141 media files into
// it - untracked, so they exist ONLY in that copy. The folder button used
// `shell:revealProject`, which deliberately climbs a lane up to the trunk checkout (see
// `main/projectRoot.ts`) on the theory that a lane's untracked files are swept with it.
// That theory is right for where you should DROP something in; it is wrong for where the
// pane's own work already IS, and pressing "open folder" on a pane that just wrote 141
// files means the second question, not the first.
//
// So the pane's own folder button always answers its own working directory - whatever
// kind of checkout that is: a lane copy, the main checkout, or a subfolder inside either.
// The project's main folder is still one click away (a separate, plainly labelled menu
// item that still calls the old trunk-climbing path) but it is never the answer here.
//
// Pure: no fs. The caller supplies `cwd` and, only for the one case a session record was
// somehow written without one, the project root to fall back to so the button still opens
// something rather than nothing.
//
//   node scripts/reveal-pane-test.mjs

export interface RevealPaneAsk {
  /** the pane's own working directory - where its files actually are */
  cwd?: string
  /** the project this pane belongs to, used only when `cwd` is missing */
  root: string
}

/** The folder this pane's primary folder button opens. */
export function revealTargetFor(ask: RevealPaneAsk): string {
  const cwd = (ask.cwd ?? '').trim()
  return cwd || ask.root
}

/**
 * The last path segment, for a tooltip that says which folder a click will open BEFORE
 * the click - so a pane whose cwd quietly changed is visible on hover, not just after.
 */
export function folderLabel(path: string): string {
  const parts = (path ?? '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
