// The one place the scripts send a signal to a pid they did not just spawn. Same rule as
// src/shared/signalGuard.ts (scripts cannot import TS): never pid 0, 1, a non-integer or this process.
// 2026-10-06: a fake pid 1 reached kill(-1) and every app on the Mac quit.
export function signalable(pid) {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/** `target` is a pid, or minus a pid for its process group. False when refused or when the kill failed. */
export function signal(target, name) {
  if (!signalable(Math.abs(target))) return false
  try {
    process.kill(target, name)
    return true
  } catch {
    return false
  }
}
