// An automatic restart must never land on a working desk.
//
// The app updates itself several times a day and the install path tears down every pty.
// On 2026-08-02 `updater.log` recorded an install that silently failed and retried
// itself three times inside three minutes (18:53:34Z, 18:54:18Z, 18:56:24Z) with eight
// panes open - three full teardowns nobody clicked, each one killing whatever the agents
// were mid-way through and restarting every run clock at zero.
//
// The rule that stops it is one function, so this can pin it against the session shapes
// that actually occur rather than against a mocked Electron app.
//
// Run: node scripts/update-hold-test.mjs   (part of `npm test`)

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })

const outfile = join(OUT, 'update-hold.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/updateHold.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { agentsMidTurn } = await import(pathToFileURL(outfile).href)

let failures = 0
function ok(cond, what) {
  if (cond) {
    console.log(`  ok   ${what}`)
  } else {
    failures++
    console.log(`  FAIL ${what}`)
  }
}

const NOW = 1785613026221
const working = { runSince: NOW - 28 * 60_000, status: 'working' }
const waiting = { status: 'idle' }
const starting = { status: 'starting' }
// The shape that makes a naive `s.runSince` check wrong: the agent exited part-way
// through a turn, so nothing ever stopped its clock. Holding on this one would defer
// the restart for the rest of the session.
const deadMidTurn = { runSince: NOW - 90 * 60_000, status: 'exited' }

console.log('update hold')
ok(agentsMidTurn([]) === 0, 'an empty desk holds nothing')
ok(agentsMidTurn([waiting, waiting, starting]) === 0, 'panes waiting for you hold nothing')
ok(agentsMidTurn([working]) === 1, 'one agent mid-turn holds the restart')
ok(agentsMidTurn([waiting, working, working]) === 2, 'every working pane is counted, not just the first')
ok(agentsMidTurn([deadMidTurn]) === 0, 'an exited pane with a stale runSince does not hold forever')
ok(agentsMidTurn([deadMidTurn, working]) === 1, 'a stale exited pane does not inflate the live count')

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
