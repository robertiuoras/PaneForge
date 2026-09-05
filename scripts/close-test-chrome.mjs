import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'

// Close the browser through its own CDP connection first so Chromium reaps its children.
// Windows kill() alone leaves children holding the profile. The fallback targets only
// the browser PID spawned by this test, never any user's browser or process-name list.
export async function closeTestChrome(chrome, profile, ws) {
  const alive = () => chrome.pid && chrome.exitCode === null && chrome.signalCode === null
  const waitForExit = (ms) => new Promise((resolve) => {
    if (!alive()) return resolve(true)
    const done = () => { clearTimeout(timer); chrome.off('exit', done); resolve(true) }
    const timer = setTimeout(() => { chrome.off('exit', done); resolve(false) }, ms)
    chrome.once('exit', done)
  })
  if (alive() && ws?.readyState === 1) {
    try {
      ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }))
    } catch {
      // The CDP socket may close between readyState and send; the owned PID fallback
      // below still has to run when the browser itself remains alive.
    }
    await waitForExit(3_000)
  }
  let killError
  if (alive()) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
          windowsHide: true, timeout: 10_000
        }, (error) => { killError = error; resolve() })
      })
    } else {
      chrome.kill()
    }
    // taskkill can report an already-exited child while successfully stopping the tree.
    // Require the actual owned parent to exit and its profile to be removable below.
    if (!await waitForExit(5_000)) throw new Error('Test Chrome did not exit', { cause: killError })
  }
  try { ws?.close() } catch { /* an already-closed socket cannot skip profile cleanup */ }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
