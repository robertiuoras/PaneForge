/**
 * A pane whose working directory has been deleted out from under it.
 *
 * Split out from the sweep so the RULE can be tested without a pty, an Electron app or a
 * real folder - the same shape as `outputIsWork` and `stalledNow`, and for the same
 * reason: this one closes somebody's card, so the refusals are the interesting half.
 *
 * The rule is deliberately narrow. A missing folder ALONE is not a reason to close
 * anything: a rename, a `git clean`, a worktree moved by another chat, an installer
 * writing in two steps - all of those look identical from out here, and the pane
 * survives every one of them (the shell recovers to $HOME on its own, and Claude Code
 * keeps its transcript, which is keyed by session id and not by path). What has no
 * defence is a pane that is ALSO dead: no process to return to, and no directory left
 * to resume in. That card is about nothing, so it goes.
 */

export interface CwdGoneInput {
  /** the pane's status; only `exited` can ever reap */
  status: string
  /** epoch ms since the folder went missing, or undefined while it is there */
  cwdGone?: number
  now: number
  /** how long the pair must hold before the card is removed */
  graceMs: number
}

export function reapForMissingCwd({ status, cwdGone, now, graceMs }: CwdGoneInput): boolean {
  if (status !== 'exited') return false
  if (!cwdGone) return false
  return now - cwdGone > graceMs
}

/**
 * The stamp itself: unset -> now on the way out, now -> unset on the way back. Returns
 * the new value and whether it changed, so the caller can decide whether the sidebar
 * needs redrawing. A folder that comes back CLEARS the stamp, which is what stops a
 * two-step replacement (remove, recreate) from ever reaching the grace window.
 */
export function nextCwdGone(
  gone: boolean,
  current: number | undefined,
  now: number
): { value: number | undefined; changed: boolean } {
  if (gone === !!current) return { value: current, changed: false }
  return { value: gone ? now : undefined, changed: true }
}
