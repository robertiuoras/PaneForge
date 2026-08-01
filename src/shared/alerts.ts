// When a pane is worth interrupting for, beyond "the turn ended".
//
// The chime already covers the good news. These two cover the other kind, and they
// are the two tmux has had for thirty years (`monitor-silence`, `monitor-bell`):
//
//   - the pane went completely quiet WHILE it was working, which with eight open is
//     invisible - a stalled API call, a tool waiting on a lock, a permission prompt
//     that scrolled off, an agent that quietly died mid-tool;
//   - the terminal rang its bell, which is the only way a CLI has of asking for a
//     human directly, and which this app has been swallowing.
//
// The decision lives here rather than inside the sweep because it is the part worth
// pinning: a rule about minutes cannot be checked by waiting minutes, and every
// mistake it can make is one where the app cries wolf. `scripts/silence-test.mjs`
// drives the whole truth table in milliseconds.

export interface SilenceInput {
  /** ms since this pane last printed anything */
  quiet: number
  /** the turn clock: set while a turn is running, undefined between turns */
  runSince?: number
  /** something has been asked of this session (a prompt, or you typed into it) */
  engaged?: boolean
  /** already raised for this stretch of silence - it must not repeat every second */
  raised: boolean
  /** how long counts as too long. 0 turns the alert off entirely. */
  silenceMs: number
}

/**
 * Say nothing unless a turn is IN PROGRESS and has printed nothing for too long.
 *
 * Silence at an idle prompt is the normal state of a pane you are not using - tmux
 * alerts on it because a tmux window is usually a shell you left running, and here
 * eight idle panes would raise eight alerts about nothing every N minutes. What is
 * actually worth telling you is the pane whose clock is still ticking with nothing
 * coming out of it: the app is claiming that agent is working, and this is the only
 * check on that claim.
 */
export function stalledNow(i: SilenceInput): boolean {
  if (!i.silenceMs || i.raised) return false
  if (!i.runSince || !i.engaged) return false
  return i.quiet > i.silenceMs
}

/** Minutes as the settings dialog stores them, in ms. Anything <= 0 means off. */
export function silenceMs(minutes: number | undefined): number {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return 0
  // A minute is the floor on purpose: below it, a slow tool call is an alert.
  return Math.max(60_000, Math.round(m * 60_000))
}
