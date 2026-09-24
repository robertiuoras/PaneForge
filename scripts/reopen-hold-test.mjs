// Regression test for "could not open eugenie-a from History" (Robert, 2026-09-24).
//
// What happened, from the logs on the Mac (userData, all times UTC):
//   06:50:07  reclaim.log   the memory sweep closed Codex pane s68 (`Eugenie A | clients`,
//                           folder clients/clients/eugenie-a). Its lane-ledger hold on the
//                           `clients` main folder (pane s68, session 01a0d200...) stayed.
//   06:56:46  offload.log   History `Open again` -> "you chose this machine" ... and no
//   06:57:02                `started` line after either press: `laneFor` threw.
//   ~07:02                  the gone-sweep (`GONE_MS`, 15 min after the hold's last beat
//                           at 06:46:52) released the hold. Too late for both presses.
// The chain: `ledgerTakenFolders` counted the CLOSED pane's hold, so `resolveLane` saw
// `clients` in use and looked for a spare copy holding `clients/eugenie-a` - which no copy
// can, because that folder was never committed. It refused with "No free lane containing
// this folder in clients ... lane pool", read by Robert as "is lane closed?".
//
// Real git, real ledger file, the real `ledgerTakenFolders` and `resolveLane` bundled from
// src - only the desk (the pane list) and History's "this pane ended" are handed in.
//
//   node scripts/reopen-hold-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const root = join(realpathSync(tmpdir()), 'paneforge-reopen-hold-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

function load(entry, name) {
  const out = join(root, `${name}.bundle.mjs`)
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['electron'],
    outfile: out
  })
  return import(pathToFileURL(out).href)
}

// The ledger is found by scanning `~/Projects` (`~/Desktop/Projects` too on Windows), so
// the whole fixture lives under a home of its own. Read per call by `os.homedir()`.
const home = join(root, 'home')
const projects = join(home, 'Projects')
mkdirSync(join(home, 'Desktop'), { recursive: true })
process.env.HOME = home
process.env.USERPROFILE = home

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const repo = join(projects, 'clients')
mkdirSync(join(repo, 'clients', 'alison'), { recursive: true })
writeFileSync(join(repo, 'clients', 'alison', 'README.md'), '# alison\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c', 'd', 'e', 'f'] }) + '\n')
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
// Same shape as the real repo that day: copies a and b on disk, branches c-f left behind.
git(repo, 'worktree', 'add', '-q', '-b', 'lane-a', join(projects, 'clients-a'))
git(repo, 'worktree', 'add', '-q', '-b', 'lane-b', join(projects, 'clients-b'))
for (const l of ['c', 'd', 'e', 'f']) git(repo, 'branch', `lane-${l}`)
// The client folder that exists only on this disk - `?? clients/eugenie-a/` in git status.
const eugenie = join(repo, 'clients', 'eugenie-a')
mkdirSync(eugenie, { recursive: true })
writeFileSync(join(eugenie, 'README.md'), '# eugenie\n')

const CLOSED = 's68-muf4ibe8'
const LIVE = 's75-muf630ho'
const OTHER_COPY = 's3-other-running-copy'
writeFileSync(
  join(repo, '.git', 'paneforge-lanes.json'),
  JSON.stringify({
    lanes: {
      main: { session: '01a0d200-90fc-7691-b5fb-e6fb61ad6e97', cwd: eugenie, pane: CLOSED, visitor: true },
      a: { session: '1d5f0797-4773-4283-98ca-5e5006c72fe5', cwd: join(projects, 'clients-a', 'clients', 'alison'), pane: LIVE }
    }
  })
)

const shared = await load(join('src', 'shared', 'laneTaken.ts'), 'laneTaken')
const { ledgerTakenFolders } = await load(join('src', 'main', 'laneLedger.ts'), 'laneLedger')
const { resolveLane } = await load(join('src', 'main', 'lanes.ts'), 'lanes')
// Absent before the fix; the checks below then fail on what the app DOES, not on an import.
const holdIsOver = shared.holdIsOver ?? (() => false)

// The desk at 06:56: s75 working in copy a, s68 gone from the desk, its History row ended.
const desk = [{ id: LIVE, cwd: join(projects, 'clients-a', 'clients', 'alison'), status: 'idle' }]
const ended = (pane) => pane === CLOSED
const over = (pane) => holdIsOver(pane, desk, ended)
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

// --- the rule, on its own --------------------------------------------------------------
ok('a hold for a pane that left the desk and whose History row ended is over', holdIsOver(CLOSED, desk, ended) === true)
ok('a hold for a pane still working on the desk is not over', holdIsOver(LIVE, desk, ended) === false)
ok(
  'a hold for an ASLEEP pane is not over - it is one press from working there again',
  holdIsOver('s9', [{ id: 's9', cwd: repo, status: 'exited', asleep: 1 }], () => true) === false
)
ok(
  'a pane on the desk that exited and is not asleep holds nothing (same as takenFolders)',
  holdIsOver('s9', [{ id: 's9', cwd: repo, status: 'exited' }], () => false) === true
)
ok(
  'a pane this app never saw keeps its hold - it may be another running copy of the app',
  holdIsOver(OTHER_COPY, desk, ended) === false
)

// --- the refusal Robert saw, still reachable when the hold is real ----------------------
// A hold that counts (nobody closed it) with a copy pool that cannot hold the folder.
const strict = ledgerTakenFolders('', () => false)
let refusal = ''
try {
  await resolveLane(eugenie, [...desk.map((s) => s.cwd), ...strict])
} catch (e) {
  refusal = String(e?.message ?? e)
}
ok('with the main folder genuinely in use, the untracked client folder is still refused', refusal !== '', 'resolveLane did not refuse')
ok(
  'the refusal is written for somebody who has never used git',
  refusal && !/\b(lane|lanes|worktree|checkout|commit|pool)\b/i.test(refusal),
  refusal
)
ok('...and names the project and what to do', /clients/.test(refusal) && /Close the other clients chat/.test(refusal), refusal)

// --- the fix: the closed pane's own hold does not block its reopen ----------------------
const taken = ledgerTakenFolders('', over)
ok('the closed pane s68 no longer holds the clients main folder', !taken.some((t) => same(t, repo)), JSON.stringify(taken))
ok('the live pane s75 still holds copy a', taken.some((t) => same(t, join(projects, 'clients-a'))), JSON.stringify(taken))

let placed = null
let why = ''
try {
  placed = await resolveLane(eugenie, [...desk.map((s) => s.cwd), ...taken])
} catch (e) {
  why = String(e?.message ?? e)
}
ok('History `Open again` on Eugenie A opens in its own folder instead of refusing', placed && same(placed.cwd, eugenie), why || JSON.stringify(placed))
ok('...without making a copy it did not need', !existsSync(join(projects, 'clients-c')))

// A second running copy's hold is untouched by this: unknown pane, no History row.
writeFileSync(
  join(repo, '.git', 'paneforge-lanes.json'),
  JSON.stringify({ lanes: { main: { session: 'x', cwd: repo, pane: OTHER_COPY } } })
)
ok(
  "another running copy's hold still keeps the main folder taken",
  ledgerTakenFolders('', over).some((t) => same(t, repo))
)

rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`\nreopen-hold: ${failed} FAILED`)
  process.exit(1)
}
console.log('\nreopen-hold: 13 ok')
