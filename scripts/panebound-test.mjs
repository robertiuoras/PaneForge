// Work that may not leave this machine, and - much more of this file - work that may.
//
// `shared/paneBound.ts` is a REFUSAL fed to `shared/autoHandoff.ts`, so a false positive
// pins a pane to this desk for ever and switches the whole ladder off for it in silence.
// The expensive mistake is therefore the permanent prelude: every `claude` pane on this
// machine holds `safaridriver --mcp` and `chrome-devtools-mcp` from launch, with nobody
// having opened a page, and a rule that keyed on a browser NAME would refuse every pane on
// the desk. The CONTROL is exactly that: the prelude, asserted to bind nothing.
//
// The last block asks this machine's own process table, so the negatives are checked
// against whatever is really running here rather than only against fixtures.
//
//   node scripts/panebound-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-panebound-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return out
}
const require = createRequire(import.meta.url)
const { machineBound } = require(bundle('src/shared/paneBound.ts', 'panebound.cjs'))
const { movable, queueable } = require(bundle('src/shared/autoHandoff.ts', 'autohandoff.cjs'))

let checks = 0
const is = (actual, expected, what) => {
  checks++
  assert.equal(actual, expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const ok = (cond, what) => {
  checks++
  assert.ok(cond, what)
}

const PTY = 100
/** A pane's tree: the pty, the CLI under it, and whatever else is named. */
const tree = (...cmds) => [
  { pid: PTY, ppid: 1, cmd: '/bin/zsh' },
  { pid: 101, ppid: PTY, cmd: 'node /usr/local/bin/claude' },
  ...cmds.map((cmd, i) => ({ pid: 200 + i, ppid: 101, cmd }))
]

// --- the prelude. Every one of these is in every claude pane here, always. ---------------

const PRELUDE = [
  '/usr/bin/safaridriver --mcp',
  'node /Users/r/.npm/_npx/1a2b/node_modules/.bin/chrome-devtools-mcp',
  'node /Users/r/.npm/_npx/1a2b/node_modules/chrome-devtools-mcp/build/src/index.js',
  '/usr/local/bin/codegraph serve --mcp',
  '/usr/bin/caffeinate -i -t 300'
]
is(machineBound(tree(...PRELUDE), PTY), undefined, 'a pane holding only its MCP prelude is not bound')
for (const cmd of PRELUDE)
  is(machineBound(tree(cmd), PTY), undefined, `${cmd.slice(0, 40)} alone binds nothing`)
is(machineBound(tree(), PTY), undefined, 'a pane running nothing but its agent is not bound')

// --- a browser actually being driven ------------------------------------------------------

const DRIVEN = [
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=9222 --user-data-dir=/tmp/x',
  '/opt/chrome/chrome-headless-shell --headless --disable-gpu',
  '/usr/bin/chromium --remote-debugging-pipe --no-sandbox',
  '/usr/local/bin/firefox --headless'
]
for (const cmd of DRIVEN) ok(!!machineBound(tree(...PRELUDE, cmd), PTY), `${cmd.slice(0, 34)}… binds the pane`)
is(machineBound(tree(...PRELUDE, DRIVEN[0]), PTY), 'a browser it is driving', 'and says what it is')

// A driver that is NOT an MCP server: a test suite owns a browser through it.
ok(!!machineBound(tree('/usr/local/bin/chromedriver --port=9515'), PTY), 'a bare chromedriver binds')
is(machineBound(tree('/usr/bin/safaridriver --mcp'), PTY), undefined, '...and the same binary as an MCP server does not')

// Depth: a driver is routinely three processes down, under a shell the agent spawned.
const deep = [
  { pid: PTY, ppid: 1, cmd: '/bin/zsh' },
  { pid: 101, ppid: PTY, cmd: 'node /usr/local/bin/claude' },
  { pid: 102, ppid: 101, cmd: '/bin/bash -c npm run test:view' },
  { pid: 103, ppid: 102, cmd: 'node scripts/probe.mjs' },
  { pid: 104, ppid: 103, cmd: '/opt/chrome/chrome --headless --remote-debugging-port=9333' }
]
ok(!!machineBound(deep, PTY), 'a browser four processes down still binds the pane')

// Somebody else's browser. The table is the whole machine, so a process that is not under
// this pty may never bind it - that is what would pin every pane on a desk with Chrome open.
const elsewhere = [
  ...tree(...PRELUDE),
  { pid: 900, ppid: 1, cmd: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222' }
]
is(machineBound(elsewhere, PTY), undefined, "a browser outside the pane's tree binds nothing")
// ...and a person's ordinary browser carries none of those flags in the first place.
is(
  machineBound(tree('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), PTY),
  undefined,
  'a browser nobody is driving binds nothing even inside the tree'
)

// --- the refusals it feeds ---------------------------------------------------------------

const pane = (over) => ({ state: 'ready', asking: false, ...over })
is(movable(pane()), true, 'an ordinary finished pane moves')
is(movable(pane({ machineBound: 'a browser it is driving' })), false, '...and a bound one does not')
is(queueable(pane({ machineBound: 'a browser it is driving' })), false, 'nor is it queued for later')
is(queueable(pane({ state: 'working' })), true, 'while a busy pane is still queueable')

// `shareable` is the OTHER leg, and only an explicit false refuses: undefined is "nobody
// asked", and refusing on that would switch the ladder off wherever the reading is slow.
is(movable(pane({ shareable: false })), false, 'a repo that cannot reach the other machine does not move')
is(queueable(pane({ shareable: false })), false, '...or queue')
is(movable(pane({ shareable: undefined })), true, 'an unmeasured repo is not refused')
is(movable(pane({ shareable: true })), true, 'and a measured one moves')

// --- this machine's own table -------------------------------------------------------------

if (process.platform !== 'win32') {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }))
  const clis = rows.filter((r) => /(?:^|[/\\])(claude|codex)(?:\s|$)/.test(r.cmd) && !/--mcp/.test(r.cmd))
  let bound = 0
  for (const cli of clis) if (machineBound(rows, cli.pid)) bound++
  ok(
    bound < clis.length || clis.length === 0,
    `not every live agent on this machine is bound (${bound} of ${clis.length})`
  )
  console.log(`  (${clis.length} live agent CLIs here, ${bound} of them driving a browser right now)`)
}

rmSync(work, { recursive: true, force: true })
console.log(`panebound: ${checks} checks passed`)
