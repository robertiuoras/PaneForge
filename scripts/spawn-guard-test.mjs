// A spawn nobody waits for must not be able to take the main process down.
//
// `spawn()` returns before the fork happens, so ENOENT (no such binary) and EAGAIN (no
// process slots left) arrive as an `error` EVENT on the child, and a ChildProcess with no
// listener for it re-raises that as an uncaught exception. Five fire-and-forget spawns in
// `src/main` were written with a synchronous `try { spawn(...) } catch {}` around them,
// each with a comment naming the exact failure the catch could never see. Measured on this
// machine 2026-08-30 03:00:30: two `uncaughtException: Error: spawn sh EAGAIN` a tenth of a
// second apart, out of the stray reaper on a pane close.
//
// The first block is the RED PROOF and is the load-bearing half: it runs the unguarded
// shape in a real child process and requires it to die, then the guarded shape and
// requires it to live. Without the first case a green test here would prove nothing about
// the language.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
let failed = 0

function ok(cond, what) {
  checks++
  if (!cond) {
    failed++
    console.log(`  FAIL ${what}`)
  }
}

function runNode(source) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['-e', source], (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) })
    })
    child.on('error', () => resolve({ code: -1, out: '', err: 'could not start node' }))
  })
}

console.log('spawn-guard: the language, proved in a real process')

// The shape every one of those five call sites had. `no-such-binary-pf` cannot exist, so
// the spawn fails asynchronously; the try/catch sees nothing and node raises.
const UNGUARDED = `
const { spawn } = require('node:child_process')
try {
  spawn('no-such-binary-pf', ['x'], { detached: true, stdio: 'ignore' }).unref()
} catch { console.log('caught') }
setTimeout(() => console.log('survived'), 300)
`

// The shape spawnQuiet uses.
const GUARDED = `
const { spawn } = require('node:child_process')
const child = spawn('no-such-binary-pf', ['x'], { detached: true, stdio: 'ignore' })
child.on('error', () => console.log('recorded'))
child.unref()
setTimeout(() => console.log('survived'), 300)
`

const bad = await runNode(UNGUARDED)
ok(bad.code !== 0, `an unguarded detached spawn KILLS the process (exit ${bad.code})`)
ok(/ENOENT/.test(bad.err), 'and it dies on the spawn error, not something else')
ok(!/survived/.test(bad.out), 'nothing after it runs')
ok(!/caught/.test(bad.out), 'the try/catch around it never fired - the failure is an EVENT')

const good = await runNode(GUARDED)
ok(good.code === 0, `the guarded shape survives (exit ${good.code})`)
ok(/recorded/.test(good.out), 'and the failure is recorded')
ok(/survived/.test(good.out), 'and the process carries on')

console.log('spawn-guard: the app has no unguarded fire-and-forget spawn left')

const quiet = readFileSync(join(root, 'src/main/spawnQuiet.ts'), 'utf8')
ok(/child\.on\('error'/.test(quiet), "spawnQuiet attaches an 'error' listener")
ok(
  quiet.indexOf("child.on('error'") < quiet.indexOf('child.unref()'),
  'and attaches it before unref, so nothing can fire in between'
)
ok(/logProblem\(/.test(quiet), 'a failure is written to paneforge-errors.log, never swallowed')

// Each of the five that crashed, by file, named so a regression says which one came back.
for (const [file, what] of [
  ['src/main/strays.ts', 'the stray reaper (the one that crashed)'],
  ['src/main/consoles.ts', 'the detached no-window launcher'],
  ['src/main/install.ts', "the installer's taskkill"],
  ['src/main/sessions.ts', "shutdown's taskkill"],
  ['src/main/macUpdate.ts', 'the mac update swap']
]) {
  const src = readFileSync(join(root, file), 'utf8')
  ok(/spawnQuiet\(/.test(src), `${what} goes through spawnQuiet`)
  // The bare form back in any of these files is the regression this exists to catch.
  const bare = src.match(/(?<![.\w])spawn\(\s*['"`]/g) ?? []
  ok(bare.length === 0, `${what}: no bare spawn('...') left in ${file}`)
}

// The other half of the same log: four `unhandledRejection: Error: Failed to open URL`
// lines, from two openExternal calls whose promise nobody took.
const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const opens = index.match(/shell\.openExternal\([^)]*\)[^\n]*/g) ?? []
ok(opens.length >= 2, `both openExternal call sites are still there (${opens.length})`)
for (const line of opens) ok(/\.catch\(/.test(line), `openExternal is caught: ${line.trim().slice(0, 60)}`)

console.log(`spawn-guard: ${checks - failed}/${checks} checks passed`)
if (failed) process.exit(1)
