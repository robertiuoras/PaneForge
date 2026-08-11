// An install started in Settings runs in a pty nobody keeps a handle on: both callers
// await the promise and drop the RunHandle. Closing the window used to leave it running -
// a shell, and npm or winget below it, downloading into a machine whose only window onto
// them has gone.
//
// This runs a REAL one (a shell that sleeps, so nothing is installed) and proves the
// teardown takes the whole tree, not just the shell.
//
//   node scripts/install-stop-test.mjs

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = (await import('typescript')).default

// install.ts and which.ts are the only two modules involved; compile both and let the
// first require the second, so the test covers the real PATH lookup as well.
const compiled = new Map()
function load(rel) {
  if (compiled.has(rel)) return compiled.get(rel)
  const js = tsc.transpileModule(readFileSync(join(root, rel), 'utf8'), {
    compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
  }).outputText
  const mod = { exports: {} }
  compiled.set(rel, mod.exports)
  new Function('require', 'module', 'exports', js)(
    // Any relative import is another file of this app's source, resolved against the one
    // being compiled; anything else is a real module. Hard-coding the one relative import
    // this file happened to have meant the day install.ts imported a second one
    // (`../shared/agents`), the whole test died with MODULE_NOT_FOUND naming this script -
    // which reads as the test being broken rather than as the source having moved on.
    (id) =>
      id.startsWith('.')
        ? load(join(dirname(rel), id).replace(/\\/g, '/') + (id.endsWith('.ts') ? '' : '.ts'))
        : require_(id),
    mod,
    mod.exports
  )
  compiled.set(rel, mod.exports)
  return mod.exports
}
const req = (await import('node:module')).createRequire(import.meta.url)
const require_ = (id) => req(id.replace(/^node:/, ''))

const { runCommand, stopInstalls } = load('src/main/install.ts')

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every descendant of a pid, so "the tree died" can be checked rather than assumed. */
function children(pid) {
  const out =
    process.platform === 'win32'
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }`
          ],
          { encoding: 'utf8', windowsHide: true }
        )
      : execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
  return out
    .split(/\r?\n/)
    .map((s) => s.trim().split(/\s+/).map(Number))
    .filter((parts) => (process.platform === 'win32' ? Boolean(parts[0]) : parts[1] === pid))
    .map((parts) => parts[0])
}

// A command that sits there, so the test is about the teardown and not about a race with
// a command that was going to finish anyway. Nothing is installed and nothing is written.
const sleeper =
  process.platform === 'win32'
    ? 'Start-Sleep -Seconds 90; Write-Output done'
    : 'sleep 90; echo done'

let doneCode = null
const handle = runCommand(
  sleeper,
  () => undefined,
  (code) => (doneCode = code)
)
assert.ok(handle, 'runCommand returned nothing')

// Give the shell a moment to exist and to have started the sleep below it.
await new Promise((r) => setTimeout(r, 2500))

// The pty's own child is the shell; the thing worth killing is under it (npm, winget,
// node), which is why the teardown is /T and not one kill.
const tracked = children(process.pid)
assert.ok(tracked.length > 0, 'no child process was started at all')
const tree = tracked.flatMap((pid) => [pid, ...children(pid)])
assert.ok(
  tree.some((pid) => alive(pid)),
  'the install was not running before the teardown'
)

stopInstalls()
await new Promise((r) => setTimeout(r, 2500))

const survivors = tree.filter((pid) => alive(pid))
assert.deepEqual(survivors, [], `install processes survived the quit: ${survivors.join(',')}`)
assert.notEqual(doneCode, 0, 'a killed install must not report success')

// Idempotent: both quit paths call it, and the second call must do nothing rather than
// throw on an empty list.
stopInstalls()

console.log('install-stop-test: OK')
