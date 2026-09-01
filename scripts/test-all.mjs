// The suite. `npm test`, and the third step of the gate the app runs over a lane it
// drove itself (`src/main/agentGate.ts` looks for a script called exactly `test`).
//
// Until this existed there was no such script, so every lane the app drove reported its
// suite step as *skipped* - a gate with typecheck and a reviewer and nothing in between.
// The 30-odd checks below were all sitting in package.json already; nothing was written
// for this, they were only never collected.
//
// What belongs here: a test that needs no window, no network, no real agent CLI and no
// minute of wall clock. That is the whole point - a gate a driven lane waits on has to
// be cheap, and these are the tests that catch a regression by ARITHMETIC rather than by
// somebody looking at a pane. Measured on this Mac, the lot runs in ~35s.
//
// What stays out, and where to run it instead:
//   test:caffeinate (SIGKILLs real parent processes to prove caffeinate -w cleans up),
//   test:strays (~25s of real orphan processes), test:lanes,
//   test:remote, test:updater   - slow, or they spawn real processes and repositories
//   test:view, test:stashdrag, test:activate                   - need a real window
//   test:discordbrand, mac-update-test --live                   - need the network
//
//   node scripts/test-all.mjs             every test below
//   node scripts/test-all.mjs rail theme  only the ones whose name contains one of these

import { spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// name -> the script file, in the order they run. Cheapest first is deliberate: a broken
// build should say so in a second rather than after the slow ones.
const TESTS = [
  ['power', 'power-test.mjs'],
  ['grid', 'grid-layout-test.mjs'],
  ['awake', 'awake-test.mjs'],
  ['autoclear', 'autoclear-test.mjs'],
  ['cwdgone', 'cwd-gone-test.mjs'],
  ['capacity', 'capacity-test.mjs'],
  ['trimloss', 'trim-loss-test.mjs'],
  ['unwrapcopy', 'unwrap-copy-test.mjs'],
  ['whatsnew', 'whatsnew-test.mjs'],
  ['renderwatch', 'renderwatch-test.mjs'],
  ['elapsed', 'elapsed-test.mjs'],
  ['usage', 'usage-test.mjs'],
  ['railplace', 'rail-place-test.mjs'],
  ['cursorclick', 'cursor-click-test.mjs'],
  ['stickyselect', 'sticky-select-test.mjs'],
  ['attach', 'attach-test.mjs'],
  ['dropimage', 'drop-image-test.mjs'],
  ['favicon', 'favicon-test.mjs'],
  ['promptbox', 'prompt-box-test.mjs'],
  ['choices', 'choices-test.mjs'],
  ['handoffsteps', 'handoff-steps-test.mjs'],
  ['staleframe', 'stale-frame-test.mjs'],
  ['settingsearch', 'settings-search-test.mjs'],
  ['autoanswer', 'auto-answer-test.mjs'],
  ['asknotify', 'ask-notify-test.mjs'],
  ['faultnotify', 'fault-notify-test.mjs'],
  ['spawnguard', 'spawn-guard-test.mjs'],
  ['promptsubmit', 'prompt-submit-test.mjs'],
  ['anim', 'anim-cost-test.mjs'],
  ['scrollclear', 'scroll-clear-test.mjs'],
  ['replaywidth', 'replay-width-test.mjs'],
  ['panegrid', 'pane-grid-test.mjs'],
  ['markanchor', 'mark-anchor-test.mjs'],
  ['recover', 'recover-test.mjs'],
  ['restoreturn', 'restore-turn-test.mjs'],
  ['claim', 'transcript-claim-test.mjs'],
  ['quitwords', 'quit-words-test.mjs'],
  ['reclaim', 'reclaim-test.mjs'],
  ['activity', 'activity-test.mjs'],
  ['hookdeny', 'hookdeny-test.mjs'],
  ['deaddev', 'deaddev-test.mjs'],
  ['sleep', 'sleep-test.mjs'],
  ['mascot', 'mascot-test.mjs'],
  ['tips', 'tips-test.mjs'],
  ['devservers', 'devservers-test.mjs'],
  ['devlist', 'devlist-test.mjs'],
  ['backjobs', 'backjobs-test.mjs'],
  ['orcatalogue', 'or-catalogue-test.mjs'],
  ['autohandoff', 'autohandoff-test.mjs'],
  ['idlequit', 'idlequit-test.mjs'],
  ['winshortcut', 'winshortcut-test.mjs'],
  ['promptecho', 'promptecho-test.mjs'],
  ['winfeed', 'winfeed-test.mjs'],
  ['copychip', 'copychip-test.mjs'],
  ['turncopy', 'turncopy-test.mjs'],
  ['overlayfilter', 'overlay-filter-test.mjs'],
  ['glass', 'glass-test.mjs'],
  ['phonetouch', 'phone-touch-test.mjs'],
  ['stashsummon', 'stash-summon-test.mjs'],
  ['theme', 'theme-test.mjs'],
  ['stashtheme', 'stash-theme-test.mjs'],
  ['conceal', 'conceal-test.mjs'],
  ['place', 'place-test.mjs'],
  ['laneplain', 'lane-plain-test.mjs'],
  ['clientname', 'client-name-test.mjs'],
  ['projectname', 'project-name-test.mjs'],
  ['historysearch', 'history-search-test.mjs'],
  ['projectroot', 'projectroot-test.mjs'],
  ['agentenv', 'agent-env-test.mjs'],
  ['panetrust', 'pane-trust-test.mjs'],
  // Loopback only, ~5s: the full remote suite stays out for being slow, but a device
  // that freezes instead of reporting itself gone is too costly to catch by hand.
  ['deadlink', 'deadlink-test.mjs'],
  // Four short child processes, ~3s: the incident it covers left this desk unable to
  // update for 28 hours while every surface read as healthy.
  ['blindlist', 'updater-blindlist-test.mjs'],
  ['devicewatch', 'device-watch-test.mjs'],
  ['projects', 'projects-test.mjs'],
  ['cardfit', 'card-fit-test.mjs'],
  ['closedone', 'close-done-test.mjs'],
  ['headerfit', 'pane-header-fit-test.mjs'],
  ['handofffit', 'handoff-fit-test.mjs'],
  ['versions', 'version-sync-test.mjs'],
  ['confirmfit', 'confirm-fit-test.mjs'],
  ['copymode', 'copymode-test.mjs'],
  ['silence', 'silence-test.mjs'],
  ['blurbs', 'blurb-test.mjs'],
  ['sounds', 'sound-test.mjs'],
  ['voice', 'voice-test.mjs'],
  ['busy', 'busy-test.mjs'],
  ['fleet', 'fleet-test.mjs'],
  ['crlf', 'crlf-test.mjs'],
  ['desk', 'desk-test.mjs'],
  ['panejob', 'panejob-test.mjs'],
  ['quietstate', 'quiet-state-test.mjs'],
  ['panebackjobs', 'pane-backjobs-test.mjs'],
  ['panebound', 'panebound-test.mjs'],
  ['surfacereach', 'surface-reach-test.mjs'],
  ['mirrorfit', 'mirrorfit-test.mjs'],
  ['handoff', 'handoff-test.mjs'],
  ['route', 'project-route-test.mjs'],
  ['laneargs', 'lane-args-test.mjs'],
  // Cheap, and the pair covers the two halves that fail differently: the arithmetic of a
  // cross-device claim, and the git plumbing that carries it (2.4s, real repositories).
  ['lanepeers', 'lane-peers-test.mjs'],
  ['lanedevice', 'lane-device-test.mjs'],
  ['laneensure', 'lane-ensure-test.mjs'],
  // The lane a folder already IS, for a pane the app did not move itself - with the
  // standalone `service-a` repo as the control a name-only guess gets wrong.
  ['lanedetect', 'lane-detect-test.mjs'],
  // Which screen the two copies of the app may take a half of, and the four desks where
  // nothing may move at all.
  ['desksnap', 'desk-snap-test.mjs'],
  // A ship may only report a lane it can prove went out, and a lane passed over leaves a
  // note. Real repos, and a post-receive hook that takes the push and rewinds the branch.
  ['laneproof', 'lane-proof-test.mjs'],
  ['trust', 'trust-test.mjs'],
  ['slash', 'slash-test.mjs'],
  ['reveal', 'reveal-test.mjs'],
  ['gamemode', 'gamemode-test.mjs'],
  ['updatehold', 'update-hold-test.mjs'],
  ['gitpoll', 'git-poll-test.mjs'],
  ['recall', 'prompt-recall-test.mjs'],
  ['draft', 'prompt-draft-test.mjs'],
  ['redact', 'prompt-redact-test.mjs'],
  ['pump', 'pump-test.mjs'],
  ['pipe', 'pipe-test.mjs'],
  ['diff', 'diff-test.mjs'],
  ['history', 'history-prune-test.mjs'],
  ['buffer', 'outbuffer-test.mjs'],
  ['notes', 'release-notes-test.mjs'],
  ['pickrelease', 'pickrelease-test.mjs'],
  ['promote', 'promote-test.mjs'],
  ['stash', 'stash-test.mjs'],
  ['onestash', 'one-stash-test.mjs'],
  ['phone', 'phone-test.mjs'],
  ['passkey', 'passkey-test.mjs'],
  ['panesize', 'pane-size-test.mjs'],
  ['borrowask', 'borrowask-test.mjs'],
  ['linkstate', 'link-state-test.mjs'],
  ['tunnel', 'tunnel-test.mjs'],
  ['funnel', 'funnel-test.mjs'],
  ['gist', 'gist-test.mjs'],
  ['splitplan', 'split-plan-test.mjs'],
  ['qr', 'qr-test.mjs'],
  ['pairask', 'pair-ask-test.mjs'],
  ['gate', 'release-gate-test.mjs'],
  ['conflict', 'conflict-test.mjs']
]

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const run = only.length
  ? TESTS.filter(([name]) => only.some((o) => name.includes(o)))
  : TESTS

if (!run.length) {
  console.error(`no test matches ${only.join(', ')}`)
  process.exit(2)
}

/*
 * How many suites run at once.
 *
 * Every suite is an independent `node` process that writes only to its own temp files and
 * binds only `listen(0)` ports - the kernel hands each one a port it has just confirmed
 * free, so two suites cannot collide over one. That makes the run a pool, not a queue, and
 * the machine's cores are the only reason to hold it to a number at all.
 *
 * Serial (`--jobs 1`) is kept because a FAILURE is easier to read when nothing else is
 * printing, and because a suite proven to need the machine to itself belongs in SERIAL
 * below rather than forcing the whole run back into a queue.
 */
const jobsArg = /^--jobs=(\d+)$/.exec(process.argv.slice(2).find((a) => a.startsWith('--jobs=')) ?? '')
const JOBS = Math.max(1, Number(jobsArg?.[1] ?? process.env.PF_TEST_JOBS ?? Math.min(8, cpus().length)))

/**
 * Suites that may not share the machine, each with the reason it cannot.
 *
 * A name lands here only after it has been MEASURED failing in a pool and passing alone -
 * a guess here silently gives back the time the pool was built to win.
 */
const SERIAL = new Set([
  // Reads the whole process table and asserts on what it finds, so another suite's
  // spawned children are its noise.
  'strays',
  'panejob',
  'panebackjobs',
  'deaddev',
  'usage',
  // Measured: passes alone in 4.2s, fails at jobs=8 in 31.8s - `the clock is not cut off,
  // 54.6px of 116px`. It lays out a card whose content is a RUNNING clock, so a slow
  // machine writes a wider string than the box the assertion was written against. The
  // contention is the test's input, not its environment.
  'cardfit'
])

const failed = []
const started = Date.now()

/*
 * `spawnSync` cannot be pooled - it blocks the event loop until the child exits, so eight
 * "workers" awaiting it take their turns one at a time. Measured: 136 suites, jobs=8, wall
 * 197.8s against 196.8s of summed suite time - a pool that was still a queue, and the giveaway
 * is exactly that, the two numbers agreeing. A real pool's wall clock is a fraction of the sum.
 */
function runChild(file) {
  return new Promise((done) => {
    const kid = spawn(process.execPath, [join(root, 'scripts', file)], {
      cwd: root,
      // Captured rather than inherited: 34 passing tests printing their own output is a
      // wall nobody reads, and the gate keeps only the tail. A failure prints in full.
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    kid.stdout.on('data', (b) => (stdout += b))
    kid.stderr.on('data', (b) => (stderr += b))
    kid.on('error', (e) => done({ status: 1, stdout, stderr: `${stderr}${e.message}` }))
    kid.on('close', (status) => done({ status, stdout, stderr }))
  })
}

async function runOne([name, file]) {
  const at = Date.now()
  const r = await runChild(file)
  const secs = ((Date.now() - at) / 1000).toFixed(1)
  const ok = r.status === 0
  // The evidence, not a summary of it. Whatever reads this - a person or the agent
  // being told its lane failed - needs the assertion that fired.
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
  return { name, ok, secs, out, status: r.status }
}

function report(res) {
  console.log(`${res.ok ? 'ok  ' : 'FAIL'}  ${res.name.padEnd(12)} ${res.secs.padStart(5)}s`)
  if (res.ok) return
  failed.push(res.name)
  console.log(res.out ? `\n${res.out}\n` : `\n  (no output; exit ${res.status})\n`)
}

// Lines are printed in the order the suites are LISTED, never the order they finish - a
// run whose output reshuffles itself between two runs cannot be diffed against the last one.
async function pool(list, width) {
  const results = new Array(list.length)
  let next = 0
  let printed = 0
  const flush = () => {
    while (printed < results.length && results[printed]) report(results[printed++])
  }
  await Promise.all(
    Array.from({ length: Math.min(width, list.length) }, async () => {
      for (let i = next++; i < list.length; i = next++) {
        results[i] = await runOne(list[i])
        flush()
      }
    })
  )
  flush()
}

const alone = run.filter(([n]) => SERIAL.has(n))
const together = run.filter(([n]) => !SERIAL.has(n))

await pool(together, JOBS)
await pool(alone, 1)

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failed.length) {
  console.log(`\n${failed.length} of ${run.length} failed in ${total}s: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\n${run.length} tests passed in ${total}s`)
