import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'

async function descendantsOf(pid) {
  const output = await new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid='], { windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : stdout)
    })
  })
  const children = new Map()
  for (const line of output.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/, 2).map(Number)
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
    const siblings = children.get(parent) ?? []
    siblings.push(child)
    children.set(parent, siblings)
  }
  const pending = [pid]
  const descendants = []
  while (pending.length) {
    const parent = pending.pop()
    for (const child of children.get(parent) ?? []) {
      descendants.push(child)
      pending.push(child)
    }
  }
  return descendants.reverse()
}

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
    // A ChildProcess can update its exit fields between the first `alive()` check and
    // subscribing above. In that small window there is no later event to observe.
    if (!alive()) done()
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
      // Browser.close had a grace period above. SIGTERM can leave this test-owned Chrome
      // parent alive long enough to turn successful layout checks into a cleanup failure.
      // Stop its exact descendants first: SIGKILLing only the browser parent would orphan
      // Chrome helpers that still hold this test profile. The tree comes from chrome.pid,
      // never from a process name, so it cannot reach Electron or a user's browser.
      for (const pid of await descendantsOf(chrome.pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* exited between ps and kill */ }
      }
      chrome.kill('SIGKILL')
    }
    // taskkill can report an already-exited child while successfully stopping the tree.
    // Require the actual owned parent to exit and its profile to be removable below.
    if (!await waitForExit(5_000)) throw new Error('Test Chrome did not exit', { cause: killError })
  }
  try { ws?.close() } catch { /* an already-closed socket cannot skip profile cleanup */ }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
