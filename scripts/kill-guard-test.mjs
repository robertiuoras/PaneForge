// The refusal that keeps a measurement script from killing the app it is running inside.
//
// Proved against WRITTEN chains rather than real processes: the failure this exists for is
// a session dying mid-turn, and a test that reproduces it faithfully would kill the session
// running the test. `chainOf` takes its reader as an argument for exactly that reason, so
// the walk itself is still exercised without a `ps` anywhere near it.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ELECTRON_PATTERN, chainOf, hostAncestor, refusalWords } from './kill-guard.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
function ok(what, cond) {
  if (cond) console.log(`  ok  ${what}`)
  else {
    console.error(`FAIL  ${what}`)
    failed++
  }
}

const DEV_COPY = `${root}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --minimized`
const INSTALLED = '/Applications/PaneForge.app/Contents/MacOS/PaneForge'
const AGENT = '/Users/someone/.local/bin/claude --dangerously-skip-permissions'
const SHELL = '-bash'
const LAUNCHD = '/sbin/launchd'

console.log('kill guard')

// The case that cost three sessions: a pane inside a `npm run try` copy runs boot-timing,
// and the pkill above it is that copy.
{
  const chain = [
    { pid: 500, command: 'node scripts/boot-timing.mjs --panes 8' },
    { pid: 400, command: AGENT },
    { pid: 300, command: DEV_COPY },
    { pid: 1, command: LAUNCHD }
  ]
  const host = hostAncestor(chain, ELECTRON_PATTERN)
  ok('a dev copy above this process is found', host?.pid === 300)
  ok(
    'the refusal names the copy, in words with no jargon in them',
    /refusing: this session runs inside a copy that pattern would kill/.test(refusalWords(host)) &&
      !/pkill|pattern would kill.*electron|worktree|checkout/.test(refusalWords(host).replace('that pattern would kill', ''))
  )
}

// The ordinary case: a session hosted by the INSTALLED app. The pattern cannot match
// /Applications/PaneForge.app, so the kill is safe and must not be refused - a guard that
// refuses everything would make boot-timing useless rather than safe.
{
  const chain = [
    { pid: 500, command: 'node scripts/boot-timing.mjs --panes 8' },
    { pid: 400, command: AGENT },
    { pid: 300, command: INSTALLED },
    { pid: 1, command: LAUNCHD }
  ]
  ok('the installed app is not mistaken for a checkout copy', hostAncestor(chain, ELECTRON_PATTERN) === null)
}

// Run from a terminal that no app hosts.
ok(
  'a plain shell chain refuses nothing',
  hostAncestor([{ pid: 500, command: 'node scripts/boot-timing.mjs' }, { pid: 9, command: SHELL }], ELECTRON_PATTERN) ===
    null
)

// The process itself matching is still a refusal - shooting yourself is the same accident.
ok(
  'a matching process refuses on its own command',
  hostAncestor([{ pid: 300, command: DEV_COPY }], ELECTRON_PATTERN)?.pid === 300
)

// Empty and absent chains must read as "nothing to protect", never throw: a `ps` that
// answers nothing is what a reaped parent looks like, and a guard that crashes there
// would take out the very script it exists to keep alive.
ok('an empty chain answers null', hostAncestor([], ELECTRON_PATTERN) === null)
ok('a missing chain answers null', hostAncestor(undefined, ELECTRON_PATTERN) === null)

// The walk itself, with the disk reader replaced. A parent that cannot be read ends the
// chain rather than throwing, and pid 1 is never walked past.
{
  const table = {
    77: { ppid: 66, command: 'node scripts/boot-timing.mjs' },
    66: { ppid: 55, command: AGENT },
    55: { ppid: 1, command: DEV_COPY }
  }
  const chain = chainOf(77, (pid) => table[pid] ?? null)
  ok('the walk stops at pid 1 and keeps order', chain.map((p) => p.pid).join(',') === '77,66,55')
  ok('the walked chain still refuses', hostAncestor(chain, ELECTRON_PATTERN)?.pid === 55)
  const cut = chainOf(77, (pid) => (pid === 66 ? null : (table[pid] ?? null)))
  ok('a parent that cannot be read ends the walk', cut.map((p) => p.pid).join(',') === '77')
}

// And the wiring: boot-timing must actually CALL the refusal, and before it kills anything.
{
  const src = spawnSync('cat', [join(root, 'scripts/boot-timing.mjs')], { encoding: 'utf8' }).stdout ?? ''
  // The CALL, not the import and not a commented-out line: an `indexOf` would be satisfied
  // by `// refuseSelfKill(...)`, which is exactly the shape of the regression.
  const guardAt = src.search(/^refuseSelfKill\(/m)
  const killAt = src.indexOf("spawnSync('pkill'")
  ok('boot-timing calls the guard', guardAt > 0)
  ok('it calls it BEFORE the kill', guardAt > 0 && killAt > 0 && guardAt < killAt)
  ok(
    'the kill pattern is the one the guard reads',
    !/'PaneForge\[\^\/\]\*\/node_modules\/electron'/.test(src.slice(guardAt))
  )
}

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall good')
