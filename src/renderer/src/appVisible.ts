/**
 * Is anyone actually looking at this window?
 *
 * The page cannot work that out for itself here. The window is created with
 * `backgroundThrottling: false` - deliberately, so the "this agent is still running"
 * timers keep their real rate while minimised - and a side effect of that flag is that
 * Chromium never moves the document to the hidden state. Measured on a minimised window:
 * `document.hidden === false` and `visibilitychange` never fires. So every
 * `if (document.hidden) return` guard in this app was dead code that had never once
 * skipped anything, including the two that exist to stop a `git status` per repo every
 * six seconds behind a minimised window.
 *
 * What Chromium DOES still do while minimised is stop painting - a minimised window was
 * measured at about 1.3 animation frames a second - so anything that costs only pixels
 * (the sidebar's looping animations) already costs nothing there and is left alone. This
 * is only for work driven by TIMERS, which do keep full rate: polls, and the processes
 * they spawn.
 *
 * The state is asked for rather than cached, on the tick that is about to use it. A
 * cached flag depends on the main process's window events arriving, and a poll that
 * silently stops because a flag went stale is the same bug in the other direction.
 */

/** True while the window is on screen (not minimised, not hidden). */
export async function appVisible(): Promise<boolean> {
  try {
    return (await window.api.appVisibleNow()) ?? true
  } catch {
    // Older preload, or the window is on its way out. Poll rather than go quiet.
    return true
  }
}

/**
 * Run `fn` when the window comes back, so a badge is current straight away rather than
 * up to a poll interval stale. Best effort: correctness does not depend on it.
 */
export function onAppVisible(fn: () => void): () => void {
  return window.api.onAppVisible((visible) => {
    if (visible) fn()
  })
}
