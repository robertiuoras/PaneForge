// Closing the `npm run try` copy.
//
// try.mjs spawns the test app detached and unref'd on purpose: it has to outlive the
// command that launched it, and the agent pane must not sit attached to its output.
// The cost is that nothing owns it afterwards. When the chat that launched it ends,
// the window keeps running - and with `--minimized` it is invisible, so it is left
// running for days. One was found alive 40 minutes after its npm parent had exited,
// which is what this file is for.
//
// So every place that lets go of a lane closes that lane's test copy, and try.mjs
// closes the previous one before launching a new one (a stale copy holds the
// single-instance lock and looks exactly like "my change did not apply").
//
// IT MATCHES EVERY SIBLING CHECKOUT, not only this one, and that is the whole point.
// There is one dev copy per machine now (see dev-profile.mjs), so the copy holding the
// shared `dev` lock is regularly one another lane started - and a launch that leaves it
// alive is a launch that silently exits on the lock with no window and no error. The
// match is `<projects>/PaneForge*/node_modules/electron`, so it still cannot touch
// another Electron app on the machine, and the installed PaneForge.exe - which usually
// hosts the session doing the killing - is a different binary in a different folder and
// is never matched.

import { spawnSync } from 'node:child_process'
import { checkoutFamily } from './dev-profile.mjs'

/** `pgrep -f` takes an extended regex, so a path's own metacharacters must be quoted. */
function rxEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Electron started from ANY checkout of this repo - a regex for pgrep, a glob for CIM. */
function markers(root) {
  const family = checkoutFamily(root)
  return {
    rx: `${rxEscape(family)}[^/]*/node_modules/electron`,
    like: `${family.replace(/'/g, "''")}*\\node_modules\\electron*`
  }
}

/**
 * Wait until the copy that was just told to close has actually gone.
 *
 * `pkill` only asks. The dying process still holds its profile's single-instance lock for
 * a moment, and a new copy launched into that moment sees the lock, exits, and leaves
 * nothing behind: no window, no devtools port, and no error either - `npm run try` prints
 * its cheerful "a second PaneForge is opening" and there is no second PaneForge. Measured
 * 2026-07-30 while testing the Stash drag: every first launch after a close died this way
 * and every second one worked, which reads as a flaky test rather than a race here.
 */
export async function waitTestAppsGone(root, ms = 8000) {
  const { rx, like } = markers(root)
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    let running = false
    try {
      if (process.platform === 'win32') {
        const r = spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
              `Where-Object { $_.CommandLine -like '${like}' -or $_.CommandLine -like '"${like}' }).Count`
          ],
          { encoding: 'utf8', timeout: 15000 }
        )
        running = Number((r.stdout ?? '').trim()) > 0
      } else {
        const r = spawnSync('pgrep', ['-f', rx], { encoding: 'utf8', timeout: 15000 })
        running = !!(r.stdout ?? '').trim()
      }
    } catch {
      return true /* cannot tell - launching anyway beats not launching */
    }
    if (!running) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

export function closeTestApps(root) {
  const { rx, like } = markers(root)
  try {
    if (process.platform === 'win32') {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
            `Where-Object { $_.CommandLine -like '${like}' -or $_.CommandLine -like '"${like}' } | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ],
        { stdio: 'ignore', timeout: 15000 }
      )
    } else {
      spawnSync('pkill', ['-f', rx], { stdio: 'ignore', timeout: 15000 })
    }
  } catch {
    /* best effort - a lane release must never fail because a window would not close */
  }
}
