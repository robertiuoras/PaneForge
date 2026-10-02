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

// How long a killed test Chrome gets to actually go. On the PC `taskkill /T /F` answers
// SUCCESS for every process in the tree and they still take 34s and 58s to leave the
// process table (measured 2026-09-23, chrome-headless-shell 131, two runs: 'exit' fired
// 33982ms and 57808ms after taskkill returned). 5s turned every Chrome-driven fit suite's
// passing run into "Test Chrome did not exit", and that red suite held every lane merge.
// The kill is not in doubt there, only its speed, so Windows waits for it.
export function exitWaitMs(platform = process.platform) {
  return platform === 'win32' ? 90_000 : 5_000
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
    if (!await waitForExit(exitWaitMs())) throw new Error('Test Chrome did not exit', { cause: killError })
  }
  try { ws?.close() } catch { /* an already-closed socket cannot skip profile cleanup */ }
  // The parent leaving is not the helpers leaving. On the PC they go as slowly as the
  // parent does (above) and hold the profile open meanwhile: rmSync's own retries ran out
  // in ~2s with EPERM on a confirmfit run whose assertions had all passed (2026-09-23).
  // Same budget as the exit wait - the removal has to succeed, only later.
  const deadline = Date.now() + exitWaitMs()
  for (;;) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}
