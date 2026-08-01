// The sweep that kills console hosts the app left behind. Everything about it that can
// be wrong is in the pid bookkeeping and in the three conditions of the script, so both
// are pure functions and both are checked here without killing anything.
//
//   node scripts/console-sweep-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = (await import('typescript')).default
const src = readFileSync(join(root, 'src/main/consoles.ts'), 'utf8')
const js = tsc.transpileModule(src, {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
}).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', js)(
  (id) => (id === 'electron' ? {} : { spawn() {}, existsSync: () => false }),
  mod,
  mod.exports
)
const { rollPids, reapScript, MAX_REMEMBERED } = mod.exports

// 1. This run's pid is remembered, and the earlier ones are kept so their leftovers can
//    still be found - a crash loop leaves several runs' worth at once.
assert.deepEqual(rollPids([10, 20], 30), [10, 20, 30])

// 2. Never twice: a pid that somehow comes back is one entry, and it is the newest.
assert.deepEqual(rollPids([10, 30, 20], 30), [10, 20, 30])

// 3. Junk out of a half-written file cannot become an argument to Stop-Process.
assert.deepEqual(rollPids([0, -1, 1.5, NaN, 'x', null, undefined, 7], 9), [7, 9])

// 4. The list is bounded, keeping the newest.
const many = Array.from({ length: 100 }, (_, i) => i + 1)
const rolled = rollPids(many, 999)
assert.equal(rolled.length, MAX_REMEMBERED)
assert.equal(rolled.at(-1), 999)
assert.equal(rolled.at(-2), 100)

// 5. The script kills a console only when all three conditions hold. The middle one is
//    what makes it safe against pid reuse and against a second PaneForge that is still
//    running: a live parent means that console is somebody's, and is left alone.
const script = reapScript([11, 22], 900)
assert.match(script, /Start-Sleep -Milliseconds 900/)
assert.match(script, /\$own = @\(11,22\)/)
// The sweep runs inside a conhost --headless WE spawned (the windowless wrapper), and
// on exit that host matches all three kill conditions. Killing it drops the sweep's own
// console mid-run, so the script must exempt its own direct parent by pid.
assert.match(script, /ProcessId=\$PID/)
assert.match(script, /\$_\.ProcessId -ne \$me/)
assert.match(script, /Name='conhost\.exe'/)
assert.match(script, /\$own -contains \$_\.ParentProcessId/)
assert.match(script, /\$live -notcontains \$_\.ParentProcessId/)
assert.match(script, /--headless/)
assert.match(script, /Stop-Process -Id \$_\.ProcessId -Force/)
// Nothing in it may name our own image: a sweep that can kill PaneForge itself is how a
// tidy-up becomes the thing that closes the app you are sitting in.
assert.doesNotMatch(script, /PaneForge|electron/i)

// 6. No delay is a valid delay, and the number is always a whole one.
assert.match(reapScript([5], 0), /Start-Sleep -Milliseconds 0/)
assert.match(reapScript([5], 12.7), /Start-Sleep -Milliseconds 13/)

console.log('console-sweep-test: OK')
