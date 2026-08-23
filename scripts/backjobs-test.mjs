#!/usr/bin/env node
// What a machine is doing outside its panes.
//
// The negatives are the test. A list of everything a process table holds answers nothing -
// there are ~700 rows on this desk - so every rule here exists to keep something OUT, and
// the ways it can go wrong are all silent: a hook that lives for 300ms listed as a job, a
// pane's own build listed a second time next to the pane, `node --max-old-space-size=4096`
// reported as serving on port 4096. Each of those makes the panel unreadable rather than
// wrong-looking, which is how nobody notices.
//
// The last block is not a fixture: it reads THIS machine's real process table through
// `main/backJobs.ts` and asserts the shape of what comes back. A fixture that does not
// have the shape of the real thing proves nothing, and the parsing (`ps -Ao etime=`, the
// PowerShell CreationDate) is exactly the half a fixture cannot check.

import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = mkdtempSync(join(tmpdir(), 'pf-backjobs-'))

await build({
  entryPoints: [join(root, 'src/shared/backJobs.ts')],
  outfile: join(out, 'backJobs.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { backJobs, agentBinOf, projectOf, ageWords, jobsSummary, jobLine, LOOP_MIN_SECONDS } =
  await import(pathToFileURL(join(out, 'backJobs.mjs')).href)

// The main half needs node builtins, so it is bundled for node rather than neutral.
await build({
  entryPoints: [join(root, 'src/main/backJobs.ts')],
  outfile: join(out, 'mainBackJobs.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['electron']
})
const { listBackJobs, etimeSeconds } = await import(pathToFileURL(join(out, 'mainBackJobs.mjs')).href)

let n = 0
const ok = (what, fn) => {
  fn()
  n++
  console.log(`  ok  ${what}`)
}
const okAsync = async (what, fn) => {
  await fn()
  n++
  console.log(`  ok  ${what}`)
}

const ROOTS = ['/Users/rob/Projects']
const p = (pid, ppid, cmd, elapsed = 3600) => ({ pid, ppid, cmd, elapsed })

// ---------------------------------------------------------------------------
// The three classes.
// ---------------------------------------------------------------------------
ok('a scheduled agent turn is the headline case', () => {
  const jobs = backJobs(
    [p(100, 1, '/Users/rob/.local/bin/claude -p "run the nightly sweep" --output-format json')],
    [],
    ROOTS
  )
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].kind, 'agent')
  assert.equal(jobs[0].label, 'claude')
  assert.equal(jobs[0].headless, true, 'a -p run is a turn nobody is watching')
})

ok('an agent sitting at its own prompt is listed, and is not called a run', () => {
  const jobs = backJobs([p(100, 1, '/usr/local/bin/codex')], [], ROOTS)
  assert.equal(jobs[0].kind, 'agent')
  assert.equal(Boolean(jobs[0].headless), false)
})

ok('a dev server carries its port and its project', () => {
  const jobs = backJobs(
    [p(200, 1, 'node /Users/rob/Projects/taskdriver/node_modules/next/dist/bin/next dev -p 3009')],
    [],
    ROOTS
  )
  assert.equal(jobs[0].kind, 'dev')
  assert.equal(jobs[0].port, 3009)
  assert.equal(jobs[0].where, 'taskdriver')
})

ok('a long-lived script under the projects root is a loop', () => {
  const jobs = backJobs([p(300, 1, 'node /Users/rob/Projects/PaneForge/scripts/lane-cron.mjs --quiet')], [], ROOTS)
  assert.equal(jobs[0].kind, 'loop')
  assert.equal(jobs[0].label, 'lane-cron.mjs')
  assert.equal(jobs[0].where, 'PaneForge')
})

// ---------------------------------------------------------------------------
// The refusals, which are the feature.
// ---------------------------------------------------------------------------
ok("a pane's own work is never listed - it already has a card", () => {
  const procs = [
    p(10, 1, '/bin/zsh'),
    p(11, 10, 'claude'),
    p(12, 11, 'node /Users/rob/Projects/PaneForge/node_modules/vite/bin/vite.js --port 5173')
  ]
  assert.equal(backJobs(procs, [10], ROOTS).length, 0, 'the whole tree under the pty is the pane')
  const loose = backJobs(procs, [], ROOTS)
  assert.equal(loose.length, 2, 'and with no pane owning it, both are jobs')
  assert.deepEqual(
    loose.map((j) => j.kind),
    ['agent', 'dev'],
    'a dev server an agent started is a second fact, not part of the run'
  )
  assert.equal(loose[0].port, null, 'and the agent does not end up claiming its port')
})

ok('a hook that lives for a moment is not a job', () => {
  const hook = [p(400, 1, 'node /Users/rob/Projects/claude-memory/claude-config/hook-guard.mjs', 0.3)]
  assert.equal(backJobs(hook, [], ROOTS).length, 0)
  hook[0].elapsed = LOOP_MIN_SECONDS + 1
  assert.equal(backJobs(hook, [], ROOTS).length, 1, 'the same script, once it has been alive')
})

ok('an agent and a dev server are listed at once, whatever their age', () => {
  // The age filter is the loop class's alone. A `claude -p` two seconds old is exactly
  // what somebody opening this panel wants to see, and so is a dev server just started.
  const young = [p(500, 1, 'claude -p hi', 1), p(501, 1, 'node /Users/rob/Projects/x/node_modules/.bin/vite', 1)]
  assert.equal(backJobs(young, [], ROOTS).length, 2)
})

ok('a script somewhere else on the disk is the operating system\u2019s business', () => {
  assert.equal(backJobs([p(600, 1, 'node /usr/lib/some-daemon/index.js')], [], ROOTS).length, 0)
})

ok('a running Electron app is not a list of five jobs', () => {
  const app = [
    p(700, 1, '/Users/rob/Projects/PaneForge/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .'),
    p(701, 700, '.../Electron Helper (Renderer).app/Contents/MacOS/Electron Helper --type=renderer'),
    p(702, 700, '.../Electron Helper (GPU).app/Contents/MacOS/Electron Helper --type=gpu-process')
  ]
  assert.equal(backJobs(app, [], ROOTS).length, 0)
})

ok('every process has .claude in its arguments, and none of them is an agent', () => {
  // The reason `agentBinOf` reads argv[0] rather than testing the whole line: a substring
  // match on "claude" calls the entire process table an agent run.
  assert.equal(agentBinOf('node /Users/rob/.claude/hooks/thing.mjs --event=prompt'), '')
  assert.equal(agentBinOf('/Users/rob/.local/bin/claude --model opus'), 'claude')
  assert.equal(agentBinOf('node /Users/rob/.nvm/versions/node/v22/bin/claude -p x'), 'claude')
  assert.equal(agentBinOf('bash /Users/rob/Projects/x/run.sh'), '', 'a shell is not an agent')
})

ok('a number is not a port because it is a number', () => {
  const jobs = backJobs(
    [p(800, 1, 'node --max-old-space-size=4096 /Users/rob/Projects/x/node_modules/.bin/vite')],
    [],
    ROOTS
  )
  assert.equal(jobs[0].port, null)
})

ok('a manager and the tool it spawned are ONE job', () => {
  // Measured for `devList.ts` on this desk and true here for the same reason: both are
  // real, both are recognised, and killing the parent takes the tree.
  const procs = [
    p(900, 1, 'npm run dev'),
    p(901, 900, 'node /Users/rob/Projects/taskdriver/node_modules/next/dist/bin/next dev -p 3100')
  ]
  const jobs = backJobs(procs, [], ROOTS)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].pid, 900, 'the one a person typed, and the one whose kill takes the tree')
  assert.equal(jobs[0].port, 3100, 'what the child knew is folded upward - npm\u2019s title carries neither')
  assert.equal(jobs[0].where, 'taskdriver')
})

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------
ok('an age is words, and an unknown one is nothing rather than "0s"', () => {
  assert.equal(ageWords(45), '45s')
  assert.equal(ageWords(600), '10m')
  assert.equal(ageWords(7200), '2h')
  assert.equal(ageWords(60 * 60 * 72), '3d')
  assert.equal(ageWords(undefined), '')
})

ok('the summary counts by kind and says nothing about an empty machine', () => {
  assert.equal(jobsSummary([]), '')
  const jobs = backJobs(
    [
      p(1, 1000, 'claude -p x'),
      p(2, 1000, 'node /Users/rob/Projects/x/node_modules/.bin/vite'),
      p(3, 1000, 'node /Users/rob/Projects/x/scripts/loop.mjs')
    ].map((j, i) => ({ ...j, pid: i + 1, ppid: 1 })),
    [],
    ROOTS
  )
  assert.equal(jobsSummary(jobs), '1 agent run, 1 dev server, 1 script')
  assert.match(jobLine(jobs[0]), /claude/)
})

ok('a project name comes off the root, not off a guess', () => {
  assert.equal(projectOf('node /Users/rob/Projects/PaneForge/scripts/x.mjs', ROOTS), 'PaneForge')
  assert.equal(projectOf('node /elsewhere/PaneForge/scripts/x.mjs', ROOTS), '')
  assert.equal(projectOf('node C:\\Users\\Gamer\\Desktop\\Projects\\vrb\\x.mjs', ['C:\\Users\\Gamer\\Desktop\\Projects']), 'vrb')
})

// ---------------------------------------------------------------------------
// The real table. `ps -Ao etime=` and the PowerShell CreationDate are the half a fixture
// cannot check, and an age that comes back undefined silently drops every loop.
// ---------------------------------------------------------------------------
ok('etime is read in every shape a ps prints it', () => {
  assert.equal(etimeSeconds('01:30'), 90)
  assert.equal(etimeSeconds('02:01:30'), 7290)
  assert.equal(etimeSeconds('3-02:01:30'), 3 * 86400 + 7290)
  // Unreadable is undefined and never 0: a 0 would be younger than LOOP_MIN_SECONDS and
  // would drop every loop on a platform whose ps words this differently.
  assert.equal(etimeSeconds('what'), undefined)
})

await okAsync('this machine answers, with ages on it', async () => {
  const jobs = await listBackJobs([], [join(process.env.HOME || '/', 'Projects')])
  assert.ok(Array.isArray(jobs), 'a table that cannot be read is an empty list, never a throw')
  for (const j of jobs) {
    assert.ok(j.pid > 0, `pid ${j.pid}`)
    assert.ok(['agent', 'dev', 'loop'].includes(j.kind), j.kind)
    assert.ok(j.label && !j.label.includes(' '), `a label is a name, not a command line: ${j.label}`)
    assert.ok(j.port === null || (j.port > 0 && j.port <= 65535), `port ${j.port}`)
    if (j.kind === 'loop') {
      assert.ok((j.elapsed ?? 0) >= LOOP_MIN_SECONDS, 'a loop older than the floor, or it is a hook')
    }
  }
  console.log(`      (${jobs.length} on this machine: ${jobsSummary(jobs) || 'nothing'})`)
})

rmSync(out, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
