// The badge under every pane asks for `git status` every six seconds, and each miss of
// the cache is a real process against a real working tree. A folder nobody is editing
// answers the same thing every time, so it earns a slower tick - but the moment anything
// moves, or an agent starts working in it, it has to go straight back to six seconds or
// the badge is lying about the repo.
//
// Time and the git process are both faked here: the whole point is the clock, and a test
// that waits thirty real seconds to check a thirty-second cache is a test nobody runs.
//
//   node scripts/git-poll-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = (await import('typescript')).default
const js = tsc.transpileModule(readFileSync(join(root, 'src/main/git.ts'), 'utf8'), {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
}).outputText

// What the fake git says, and how many times it was asked.
let status = '## main...origin/main\n M src/main/git.ts\n'
let runs = 0
let now = 0

const child_process = {
  execFile(_bin, _args, _opts, cb) {
    runs++
    // Asynchronously, like the real one: the module is allowed to depend on that.
    setImmediate(() => cb(null, status))
  }
}
// A Date the test drives. Everything in the module reads the clock through this.
class FakeDate {
  static now() {
    return now
  }
}

const mod = { exports: {} }
new Function('require', 'module', 'exports', 'Date', js)(
  (id) => (id === 'node:child_process' ? child_process : {}),
  mod,
  mod.exports,
  FakeDate
)
const { gitInfo } = mod.exports
const REPO = 'C:/repo'

const at = async (t, busy = false) => {
  now = t
  return gitInfo(REPO, busy)
}

// 1. The first ask runs git; a second one moments later is the cache.
const first = await at(0)
assert.equal(runs, 1)
assert.equal(first.branch, 'main')
assert.equal(first.dirty, 1)
await at(1000)
assert.equal(runs, 1, 'cache missed inside the fast window')

// 2. Six seconds on, it asks again - it has no reason yet to think this folder is quiet.
await at(6500)
assert.equal(runs, 2)
await at(13_000)
assert.equal(runs, 3)

// 3. Two identical answers in a row: the folder is settled, and the next poll six seconds
//    later costs nothing. This is the poll the old code always spent.
await at(19_500)
assert.equal(runs, 3, 'settled folder still spawned git at the fast rate')
await at(30_000)
assert.equal(runs, 3)

// 4. Past the slow window it does check again - a badge that never refreshes is worse
//    than one that refreshes slowly.
await at(45_000)
assert.equal(runs, 4)

// 5. An agent working in that folder is the one case where the answer is expected to
//    change under us, and it keeps the fast tick whatever the cache thinks.
await at(52_000, true)
assert.equal(runs, 5, 'a working agent did not get the fast poll')

// 6. Anything actually changing puts the folder straight back on the fast tick: two more
//    identical answers are needed before it may go quiet again. (Note what step 5 also
//    proves - a settled folder keeps its slow window until something asks with `busy`,
//    so an edit made outside the app shows up within thirty seconds, not six.)
status = '## main...origin/main\n M src/main/git.ts\n M src/main/index.ts\n'
const changed = await at(58_000, true)
assert.equal(changed.dirty, 2)
assert.equal(runs, 6)
await at(64_500)
assert.equal(runs, 7, 'a changed repo was allowed to go quiet immediately')

// 7. Two panes polling the same folder in the same tick are one process, not two.
now = 200_000
const [a, b] = await Promise.all([gitInfo(REPO), gitInfo(REPO)])
assert.equal(runs, 8, 'two panes on one repo ran two git processes')
assert.deepEqual(a, b)

console.log('git-poll-test: OK')
