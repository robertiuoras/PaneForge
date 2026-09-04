// The dev window a person is watching survives every close that is not its own.
//
// The bug this pins: `closeTestApps` matched every Electron under any checkout of this
// repo and killed it unconditionally, so a window opened with `npm run try -- --show` was
// shot by another chat's `npm test`, by `lane.mjs ready`, and by any window suite making
// room for its own copy. The dev profile's updater.log recorded three of those in 26
// minutes on 2026-09-04, each as `nothing in the app asked ... something asked from
// outside` - which reads exactly like the app crashing.
//
// Real processes, never a stub: the whole mechanism is pgrep/ps arithmetic over a live
// process table, and a fake table would prove none of it. The stand-ins carry the path
// `closeTestApps` matches on their command line, so they are killed by the same rule a
// real test copy is.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps, dropTestAppKeep, keepTestApp, keptTestApp } from './test-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
function ok(what, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${what}`)
  if (!cond) failed++
}

if (process.platform === 'win32') {
  console.log('ok  skipped on Windows - the spare-list path here is PowerShell, covered by hand')
  process.exit(0)
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A process that looks like a test copy to `closeTestApps`: the match is its command line. */
function fakeCopy() {
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)', join(root, 'node_modules', 'electron', 'dist', 'x')],
    { stdio: 'ignore', detached: true }
  )
  child.unref()
  return child.pid
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

dropTestAppKeep()
ok('nothing is kept to begin with', keptTestApp() === 0)

const watched = fakeCopy()
const leftover = fakeCopy()
await wait(400)
keepTestApp(watched)
ok('the watched window is remembered', keptTestApp() === watched)

// Housekeeping: a lane release, a window suite. It may take the leftover and nothing else.
closeTestApps(root)
await wait(600)
ok('a housekeeping close leaves the watched window alone', alive(watched))
ok('and still clears the leftover copy', !alive(leftover))

// `npm run try -- --close`, and the launch that replaces it: those ARE somebody asking.
closeTestApps(root, { force: true })
await wait(600)
ok('a forced close takes the watched window too', !alive(watched))
ok('and forgets it, so the next close has nothing to spare', keptTestApp() === 0)

// A pid that died without anyone saying so must not spare a future window forever.
const dead = fakeCopy()
process.kill(dead, 'SIGKILL')
await wait(300)
keepTestApp(dead)
ok('a dead pid is not kept', keptTestApp() === 0)

for (const pid of [watched, leftover, dead]) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
dropTestAppKeep()

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
