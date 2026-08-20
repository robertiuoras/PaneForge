// What the mascot may say about dev servers, and what it may stop.
//
// The two ways this feature can be wrong both cost somebody real work. It can name the
// wrong port - which sends a person to a page that is not there, and is worse than saying
// nothing, because a port is exactly the thing they will act on. And it can stop the wrong
// server: "close the dev" on a desk running three is a sentence that names none of them,
// so the weight of this file is in the REFUSALS - an ambiguous ask answers with the list
// rather than a guess, and a number in a command line is not a port just because it is a
// number.
//
//   node scripts/devlist-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-devlist-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const bundle = (entry, name) => {
  const outfile = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile })
  return createRequire(import.meta.url)(outfile)
}

const { portOf, runningDevs, devReport, pickDevs, mentionsDev, devLine } = bundle(
  'src/shared/devList.ts',
  'devlist.bundle.cjs'
)
const { parse, isDestructive } = bundle('src/shared/mascot.ts', 'mascot.bundle.cjs')

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}
const eq = (what, a, b) => {
  n++
  assert.deepEqual(a, b, `${what}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`)
}

// ---------------------------------------------------------------- the port

// Both shapes measured on this desk, plus the env-var one an npm script writes.
eq('-p', portOf('node /r/node_modules/next/dist/bin/next dev -p 3009'), 3009)
eq('--port', portOf('node /r/node_modules/vite/bin/vite.js --port 5173'), 5173)
eq('--port=', portOf('vite --port=5173'), 5173)
eq('PORT=', portOf('PORT=3000 node server.js'), 3000)

// A number that is not a port must never be printed as one: somebody reads that number
// and opens it. This is the whole reason the pattern is anchored to a flag.
eq('heap size is not a port', portOf('node --max-old-space-size=4096 x.js'), null)
eq('a bare number is not a port', portOf('node build.js 3000'), null)
eq('out of range', portOf('vite --port 99999'), null)

// ---------------------------------------------------------------- attribution

const panes = [
  { id: 'a', pane: 1, name: 'PaneForge', cwd: '/Users/r/Projects/PaneForge', pid: 100 },
  { id: 'b', pane: 2, name: 'taskdriver', cwd: '/Users/r/Projects/taskdriver', pid: 200 }
]

const procs = [
  { pid: 100, ppid: 1, cmd: '/bin/zsh' },
  { pid: 101, ppid: 100, cmd: 'npm run dev' },
  // The case the whole two-legged attribution exists for: reparented onto pid 1, its npm
  // parent long gone, so no tree walk from any pane reaches it.
  { pid: 300, ppid: 1, cmd: 'node /Users/r/Projects/taskdriver/node_modules/next/dist/bin/next dev -p 3009' },
  { pid: 400, ppid: 1, cmd: 'node /Users/r/other/node_modules/vite/bin/vite.js --port 5173' },
  { pid: 500, ppid: 1, cmd: 'node /Users/r/Projects/PaneForge/scripts/test-all.mjs' }
]

// The shape measured on this desk 2026-08-21: `npm run dev -p 3100` and the `next dev`
// it spawned are both real, both recognised, and are ONE server. A list that says two is
// a list where "close the second one" kills a child of the first.
const nested = runningDevs(
  [
    { pid: 900, ppid: 1, cmd: 'npm run dev -p 3100' },
    { pid: 901, ppid: 900, cmd: 'node /Users/r/Projects/toolstash/node_modules/.bin/next dev -p 3100' }
  ],
  []
)
eq('a server and its child are one server', nested.map((d) => d.pid), [900])
eq('...kept as the thing a person typed', nested[0].label, 'dev')
eq('...with the port either of them knew', nested[0].port, 3100)
eq('...and the path only the child carried', nested[0].where, 'toolstash')

const devs = runningDevs(procs, panes)
eq('three dev servers, and the test runner is not one', devs.map((d) => d.pid), [101, 300, 400])
eq('the pane tree claims its own', devs[0].pane, 1)
eq('...and its label is the script npm was running', devs[0].label, 'dev')
eq('a reparented server is claimed by its PATH', devs[1].pane, 2)
eq('...with the port it was told to serve on', devs[1].port, 3009)

// A server no pane owns is still LISTED. The question is "what dev servers are running",
// not "what does PaneForge own" - and an unclaimed one is the likeliest to be forgotten.
eq('an unowned server is listed', devs[2].pane, null)
ok('...and says where it came from', devs[2].where.length > 0)

// ---------------------------------------------------------------- picking one

eq('by port', pickDevs('close the one on 3009', devs).map((d) => d.pid), [300])
eq('by pid', pickDevs(`stop ${devs[2].pid}`, devs).map((d) => d.pid), [400])
eq('by pane', pickDevs('close the dev in pane 2', devs).map((d) => d.pid), [300])
eq('by project', pickDevs('kill the taskdriver dev server', devs).map((d) => d.pid), [300])
eq('by tool', pickDevs('stop vite', devs).map((d) => d.pid), [400])
eq('all of them', pickDevs('close both dev servers', devs).map((d) => d.pid), [101, 300, 400])
eq('the first one', pickDevs('close the first dev', devs).map((d) => d.pid), [101])
eq('the second one', pickDevs('close the second dev', devs).map((d) => d.pid), [300])

// The refusal. Three running and a sentence naming none of them picks NONE - the caller
// prints the list and asks. Guessing here is how somebody loses the build they were
// watching, and the guess would be invisible until the page stopped answering.
eq('an ambiguous ask picks nothing', pickDevs('close the dev server', devs), [])
// ...but with exactly one running there is nothing to be ambiguous about.
eq('one running is unambiguous', pickDevs('close the dev server', [devs[0]]).map((d) => d.pid), [101])

// ---------------------------------------------------------------- the words

ok('the report names every one', devReport(devs).split('\n').length === devs.length + 1)
ok('a line carries the port', devLine(devs[1], 1).includes('3009'))
ok('...and the pane number, which is also the Ctrl key', devLine(devs[1], 1).includes('pane 2'))
eq('nothing running says so', devReport([]), 'No dev server running that I can see.')

ok('mentionsDev', mentionsDev('what dev servers are running'))
ok('mentionsDev on port', mentionsDev('what is on port 3009'))
ok('a pane question is not a dev question', !mentionsDev('what is pane 3'))

// ---------------------------------------------------------------- through the mascot

const mp = [
  { id: 'a', pane: 1, name: 'PaneForge', state: 'ready', memMb: 190, idleMs: 0, remote: false, asking: false }
]

const report = parse('what dev servers are running?', mp, devs)
eq('a question about dev servers is answered as a report', report.kind, 'say')
ok('...and the answer is the list', report.say.includes('3009'))

const stop = parse('close the dev on 3009', mp, devs)
eq('a named stop is an intent', stop.kind, 'stopDev')
eq('...naming that pid and no other', stop.pids, [300])
ok('...and it is destructive, so it is confirmed', isDestructive(stop))

const ambiguous = parse('close the dev server', mp, devs)
eq('an ambiguous stop asks', ambiguous.kind, 'say')
ok('...by printing the list', ambiguous.say.includes('3009') && ambiguous.say.includes('5173'))

const both = parse('close both dev servers', mp, devs)
eq('both', both.kind, 'stopDev')
eq('...is all of them', both.pids, [101, 300, 400])

// A dev question with nothing running is answered about dev servers, not about panes -
// falling through to the pane parser is what made "close the dev" answer "nothing quiet
// enough to close", which is an answer to a question nobody asked.
const none = parse('close the dev server', mp, [])
eq('nothing running, and it says so', none.kind, 'say')
ok('...about servers', none.say.toLowerCase().includes('dev server'))

// And the control: a pane question must still reach the pane parser untouched.
const pane = parse('close pane 1', mp, devs)
eq('a pane close is still a pane close', pane.kind, 'close')
eq('...of that pane', pane.ids, ['a'])

rmSync(work, { recursive: true, force: true })
console.log(`devlist: ${n} checks passed`)
