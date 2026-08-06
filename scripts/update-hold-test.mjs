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
const { agentsMidTurn, decideInstall } = await import(pathToFileURL(outfile).href)

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

// What the button itself decides. Tested here because it cannot be reached in dev at
// all: `npm run dev` has no update metadata, so `phase` never says 'ready' and the
// running app returns 'nothing-to-install' before this rule is consulted. Without these
// the branch would first run on a user's machine.
console.log('\nthe click')
const ready = { phase: 'ready', installStarted: false }
ok(decideInstall({ ...ready, sessions: [] }).act === 'install', 'an empty desk restarts on the click')
ok(
  decideInstall({ ...ready, sessions: [waiting, waiting] }).act === 'install',
  'panes waiting for you restart on the click'
)
ok(decideInstall({ ...ready, sessions: [working] }).act === 'wait', 'a working pane holds the click')
ok(
  decideInstall({ ...ready, sessions: [working, working, waiting] }).busy === 2,
  'the hold carries the count, so the card can name it'
)
ok(
  decideInstall({ ...ready, sessions: [deadMidTurn] }).act === 'install',
  'an exited pane with a stale runSince does not hold the click either'
)
// Nothing to install: the same click on a card whose build was superseded.
ok(
  decideInstall({ phase: 'idle', installStarted: false, sessions: [] }).act === 'nothing',
  'no build ready means nothing to do'
)
ok(
  decideInstall({ phase: 'downloading', installStarted: false, sessions: [working] }).act ===
    'nothing',
  'a build still downloading is not a restart being held'
)
// A second click while the teardown is already running must not be read as a new hold -
// the panes are already dying, and answering 'wait' would put the card back on screen
// saying it was queued.
ok(
  decideInstall({ phase: 'ready', installStarted: true, sessions: [working] }).act === 'install',
  'a second click during the teardown is still the one restart'
)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
