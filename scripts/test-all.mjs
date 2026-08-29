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

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// name -> the script file, in the order they run. Cheapest first is deliberate: a broken
// build should say so in a second rather than after the slow ones.
const TESTS = [
  ['grid', 'grid-layout-test.mjs'],
  ['awake', 'awake-test.mjs'],
  ['autoclear', 'autoclear-test.mjs'],
  ['cwdgone', 'cwd-gone-test.mjs'],
  ['capacity', 'capacity-test.mjs'],
  ['trimloss', 'trim-loss-test.mjs'],
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
  ['settingsearch', 'settings-search-test.mjs'],
  ['autoanswer', 'auto-answer-test.mjs'],
  ['asknotify', 'ask-notify-test.mjs'],
  ['faultnotify', 'fault-notify-test.mjs'],
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
  ['autoclear', 'autoclear-test.mjs'],
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

const failed = []
const started = Date.now()

for (const [name, file] of run) {
  const at = Date.now()
  const r = spawnSync(process.execPath, [join(root, 'scripts', file)], {
    cwd: root,
    encoding: 'utf8',
    // Captured rather than inherited: 34 passing tests printing their own output is a
    // wall nobody reads, and the gate keeps only the tail. A failure prints in full.
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const secs = ((Date.now() - at) / 1000).toFixed(1)
  const ok = r.status === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(12)} ${secs.padStart(5)}s`)
  if (!ok) {
    failed.push(name)
    // The evidence, not a summary of it. Whatever reads this - a person or the agent
    // being told its lane failed - needs the assertion that fired.
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
    console.log(out ? `\n${out}\n` : `\n  (no output; exit ${r.status})\n`)
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failed.length) {
  console.log(`\n${failed.length} of ${run.length} failed in ${total}s: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\n${run.length} tests passed in ${total}s`)
