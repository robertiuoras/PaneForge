/**
 * The one place PaneForge sends a signal to a process id it did not just spawn.
 *
 * kill(-1) signals every process the user owns, kill(0) the caller's own group, and the
 * descendants of pid 1 are every process on the machine. A pid of 0 or 1 (a test's fake pty,
 * a parse that failed, a record read back from disk) must never be signalled or walked.
 * 2026-10-06 3:10am and 3:16am: a test pane's fake pid 1 reached kill(-1, 'SIGHUP') and every
 * app on the Mac quit. `test:signalguard` fails on any other raw `process.kill(`.
 */
export function signalable(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/** `target` is a pid, or minus a pid for its process group. False when refused or when the kill failed. */
export function signal(target: number, name: NodeJS.Signals | number): boolean {
  if (!signalable(Math.abs(target))) return false
  try {
    process.kill(target, name)
    return true
  } catch {
    return false
  }
}
