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
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutFamily } from './dev-profile.mjs'

// A DEV WINDOW SOMEBODY IS LOOKING AT IS NOT A LEFTOVER.
//
// The match above is deliberately wide - every checkout of this repo - and the kill was
// unconditional, so a window opened with `npm run try -- --show` to try a change was shot
// by any OTHER chat that ran `npm test` (three window suites close test copies before
// launching their own), `lane.mjs ready`, or its own `npm run try`. Measured 2026-09-04 in
// the dev profile's updater.log: three quits in 26 minutes, each logged as `nothing in the
// app asked ... something asked from outside`, one of them with a pane open. That reads
// exactly like the app crashing.
//
// So a launch that puts the window ON SCREEN writes its pid here, and every close that is
// not that window's own launch leaves that process and its children alone. `--close` and
// the next `npm run try` still take it: those are somebody asking for this window to go.
// `PF_KEEP_FILE` is for the suite that tests this file and nothing else. `devkeep-test`
// drops and rewrites the marker as part of what it proves, and it was doing that to the
// REAL one: a dev window Robert had open was unmarked mid-suite and then shot by the very
// next `closeTestApps` in the same test - the suite that pins "a watched window survives
// every close" was the thing killing it (dev profile updater.log, 2026-09-04 11:32:55, 40
// seconds after launch, four times in a session).
const KEEP_FILE = process.env.PF_KEEP_FILE || join(tmpdir(), 'paneforge-dev-keep.json')

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remember the dev window a person is watching, so no other lane's close touches it. */
export function keepTestApp(pid) {
  try {
    writeFileSync(KEEP_FILE, JSON.stringify({ pid, at: Date.now() }))
  } catch {
    /* the marker is an optimisation, never a requirement */
  }
}

/** Forget it - the window was closed, or a launch is replacing it. */
export function dropTestAppKeep() {
  try {
    rmSync(KEEP_FILE, { force: true })
  } catch {
    /* nothing to forget */
  }
}

/** The pid of the window being watched, or 0 - a dead pid answers 0 and clears itself. */
export function keptTestApp() {
  try {
    const pid = JSON.parse(readFileSync(KEEP_FILE, 'utf8')).pid
    if (typeof pid === 'number' && pid > 0 && alive(pid)) return pid
  } catch {
    return 0
  }
  dropTestAppKeep()
  return 0
}

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
 * "Is this pid the kept window, or one of its helpers?" - reading the process table once.
 * Answers `false` for everything when nothing is kept, so both callers can be written as
 * if a kept window always existed.
 */
function keptSubtree(kept) {
  if (!kept || process.platform === 'win32') return () => false
  const ppids = new Map()
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 15000 })
  for (const line of (ps.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line)
    if (m) ppids.set(Number(m[1]), Number(m[2]))
  }
  return (pid) => {
    for (let p = pid, hops = 0; p > 1 && hops < 12; p = ppids.get(p) ?? 0, hops++) if (p === kept) return true
    return false
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
  // A window somebody is watching is never what this is waiting for: it was not asked to
  // close, so waiting for it to go is waiting for the whole 8s and then launching anyway.
  const kept = keptTestApp()
  const ofKept = keptSubtree(kept)
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
              `Where-Object { $_.CommandLine -like '${like}' -or $_.CommandLine -like '"${like}' }` +
              (kept ? ` | Where-Object { $_.ProcessId -ne ${kept} -and $_.ParentProcessId -ne ${kept} }` : '') +
              `).Count`
          ],
          { encoding: 'utf8', timeout: 15000 }
        )
        running = Number((r.stdout ?? '').trim()) > 0
      } else {
        const r = spawnSync('pgrep', ['-f', rx], { encoding: 'utf8', timeout: 15000 })
        running = (r.stdout ?? '')
          .split('\n')
          .map((l) => Number(l.trim()))
          .some((pid) => pid && !ofKept(pid))
      }
    } catch {
      return true /* cannot tell - launching anyway beats not launching */
    }
    if (!running) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * Close the test copy.
 *
 * `force` is "somebody asked for THIS window to go" - `npm run try -- --close`, and the
 * launch that is about to replace it. Everything else (a lane release, a window suite
 * making room for its own copy) is housekeeping and must not take a window a person is
 * watching: see `KEEP_FILE` above.
 */
export function closeTestApps(root, { force = false } = {}) {
  const { rx, like } = markers(root)
  const kept = force ? 0 : keptTestApp()
  if (force) dropTestAppKeep()
  try {
    if (process.platform === 'win32') {
      // The kept window's helper processes are its own children, so both are spared by
      // one filter - Electron does not nest them any deeper.
      const spare = kept
        ? ` | Where-Object { $_.ProcessId -ne ${kept} -and $_.ParentProcessId -ne ${kept} }`
        : ''
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
            `Where-Object { $_.CommandLine -like '${like}' -or $_.CommandLine -like '"${like}' }${spare} | ` +
            `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
        ],
        { stdio: 'ignore', timeout: 15000 }
      )
    } else if (!kept) {
      spawnSync('pkill', ['-f', rx], { stdio: 'ignore', timeout: 15000 })
    } else {
      // One kept window means the kill stops being a pattern and becomes a list: every
      // matching pid except that process and the helpers it owns.
      const found = spawnSync('pgrep', ['-f', rx], { encoding: 'utf8', timeout: 15000 })
      const ofKept = keptSubtree(kept)
      for (const raw of (found.stdout ?? '').split('\n')) {
        const pid = Number(raw.trim())
        if (!pid || ofKept(pid)) continue
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* best effort - a lane release must never fail because a window would not close */
  }
}
