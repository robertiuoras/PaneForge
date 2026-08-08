// D2 and D3 of docs/agentic-dispatch.md: a dispatched run is a real pane, and the report
// that leaves afterwards carries the gate's per-step verdicts.
//
// The seam is `PaneDriver`: the fake here is a temp git repository and a notebook of what
// was typed and closed, so the whole loop - watch the diff, call the gate, close on
// success, stay on failure, drop on a person's keystroke - runs against real git and real
// npm scripts with no window, no pty and no coding CLI.
//
//   node scripts/dispatch-pane-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Fast clocks, set before the bundle loads anything that reads them.
process.env.PF_DISPATCH_POLL_MS = '50'
process.env.PF_DISPATCH_QUIET_MS = '250'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-dispatch-pane-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const data = join(work, 'userData')
mkdirSync(data, { recursive: true })
const electronStub = join(work, 'electron-stub.cjs')
writeFileSync(
  electronStub,
  `module.exports = { app: { getPath: () => ${JSON.stringify(data)} } }\n`,
  'utf8'
)

const out = join(work, 'dispatch-pane.bundle.cjs')
buildSync({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { startPaneDrive, notePaneInput, onDriveChange, stopDrive } from './src/main/supervisor'",
      "export { runDone } from './src/shared/agentic'",
      "export { addGoal, configureGoals, noteDriveChange, onGoalReport, priorDispatch, resetGoals, getGoal } from './src/main/goals'",
      "export { buildReport } from './src/main/dispatchReport'",
      "export { askFiles, buildAsk } from './src/main/dispatchAsk'",
      "export { route } from './src/shared/dispatch'"
    ].join('\n'),
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  alias: { electron: electronStub },
  outfile: out
})
const m = createRequire(import.meta.url)(out)

let failed = 0
let checks = 0
function check(name, ok, detail = '') {
  checks++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

// Gate commands as script files, because `gateCommands` splits a `.lanes.json` command on
// spaces with no quote handling - a node path with a space in it would shatter. `node` is
// on PATH here by construction (this test runs under it).
const pass = 'node gate-pass.cjs'
const fail = 'node gate-fail.cjs'

function repo(name, scripts) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  writeFileSync(join(dir, 'gate-pass.cjs'), 'process.exit(0)\n', 'utf8')
  writeFileSync(join(dir, 'gate-fail.cjs'), "console.log('1 test failed'); process.exit(1)\n", 'utf8')
  // `.lanes.json` names the gate commands directly, so the suite spends no time in npm.
  writeFileSync(join(dir, '.lanes.json'), JSON.stringify({ gate: scripts }), 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }), 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  return dir
}

/** The fake window side: opening "types the work" - the agent's edit is simulated by the
 * driver itself writing the change the moment the pane opens. */
function driver(dir, { edit = true, exitAfterOpen = false } = {}) {
  const d = {
    typed: [],
    closed: false,
    dead: false,
    open: async () => {
      if (edit)
        writeFileSync(join(dir, 'feature.ts'), 'export const one = 1\nexport const two = 2\nexport const three = 3\n', 'utf8')
      if (exitAfterOpen) d.dead = true
      return { id: `pane-${dir.slice(-6)}`, cwd: dir, branch: 'main' }
    },
    type: (_id, text) => d.typed.push(text),
    close: () => (d.closed = true),
    alive: () => !d.dead
  }
  return d
}

const plan1 = { contracts: 'none', lanes: [{ name: 'dispatch', brief: 'do it', owns: ['feature.ts'], enabled: true }] }
const dispatchPlan = (over = {}) => ({
  tier: 'A',
  agent: 'claude',
  model: 'sonnet',
  effort: 'low',
  budgetMs: 8000,
  gate: ['diff', 'typecheck', 'suite'],
  watch: true,
  why: 'test',
  ...over
})

const until = async (cond, ms = 30_000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

// ---------------------------------------------------------------------------
// 1. The watch loop passes a good change and the pane closes itself.

{
  const dir = repo('good', { typecheck: pass, suite: pass })
  const d = driver(dir)
  const run = m.startPaneDrive(
    { cwd: dir, mission: 'add the feature', plan: plan1, agent: 'claude', skipReview: true, budgetMs: 8000 },
    d
  )
  check('a pane run settles', await until(() => m.runDone(run)))
  const lane = run.lanes[0]
  check('the good change passed its gate', lane.state === 'passed', lane.note)
  check('the diff was seen from outside', lane.diffstat?.files === 1, JSON.stringify(lane.diffstat))
  check('the pane closed itself on success', d.closed === true)
  check('nothing was typed after the prompt', d.typed.length === 0)
  check(
    'the review step says skipped, never pass',
    lane.gate?.steps.some((s) => s.name === 'review' && s.detail.startsWith('skipped'))
  )
}

// ---------------------------------------------------------------------------
// 2. A failing suite is retried through the keyboard, and the pane STAYS.

{
  const dir = repo('bad', { typecheck: pass, suite: fail })
  const d = driver(dir)
  const run = m.startPaneDrive(
    { cwd: dir, mission: 'break the feature', plan: plan1, agent: 'claude', skipReview: true, budgetMs: 8000 },
    d
  )
  check('a failing pane run settles', await until(() => m.runDone(run)))
  const lane = run.lanes[0]
  check('the failing change failed', lane.state === 'failed', lane.note)
  check('the failure names the step', lane.note.includes('suite'), lane.note)
  check('the retry briefs went in through the pane', d.typed.length === 2, String(d.typed.length))
  check('the pane STAYS on failure', d.closed === false)
}

// ---------------------------------------------------------------------------
// 3. A person typing drops the run: no gate, no close, the pane is theirs.

{
  const dir = repo('taken', { typecheck: pass, suite: pass })
  const d = driver(dir, { edit: false })
  const run = m.startPaneDrive(
    { cwd: dir, mission: 'never mind', plan: plan1, agent: 'claude', skipReview: true, budgetMs: 8000 },
    d
  )
  await new Promise((r) => setTimeout(r, 120))
  m.notePaneInput(`pane-${dir.slice(-6)}`)
  check('a taken-over run settles', await until(() => m.runDone(run)))
  const lane = run.lanes[0]
  check('takeover stops the run', lane.state === 'stopped', lane.state)
  check('and says whose pane it is now', lane.note.includes('taken over'), lane.note)
  check('no gate ran for a taken-over pane', lane.gate === undefined)
  check('and nothing closed it', d.closed === false)
}

// ---------------------------------------------------------------------------
// 4. A pty that exited with nothing written is a failure, not a wait.

{
  const dir = repo('silent', { typecheck: pass, suite: pass })
  const d = driver(dir, { edit: false, exitAfterOpen: true })
  const run = m.startPaneDrive(
    { cwd: dir, mission: 'do nothing', plan: plan1, agent: 'claude', skipReview: true, budgetMs: 8000 },
    d
  )
  check('an exited pane settles at once', await until(() => m.runDone(run), 10_000))
  const lane = run.lanes[0]
  check('a run that changed nothing is a failure', lane.state === 'failed', lane.state)
  check('an exited pane is never retried', d.typed.length === 0)
  check('and stays open to be read', d.closed === false)
}

// ---------------------------------------------------------------------------
// 5. Through the queue: the plan rides the goal, the report carries the verdicts.

{
  m.resetGoals()
  // The fan-out `index.ts` does in production: the queue only hears a run end this way.
  m.onDriveChange((run) => m.noteDriveChange(run))
  const dir = repo('queued', { typecheck: pass, suite: pass })
  const d = driver(dir)
  let reported = null
  m.configureGoals(
    () => async () => {
      throw new Error('the headless claim must not be used for a watchable goal')
    },
    { paneDriver: d }
  )
  m.onGoalReport((g) => (reported = g))
  const goal = m.addGoal({
    mission: 'add the queued feature',
    cwd: dir,
    agent: 'claude',
    skipReview: true,
    plan: plan1,
    dispatch: dispatchPlan()
  })
  check('the queued goal finishes', await until(() => m.getGoal(goal.id)?.state === 'done'))
  const done = m.getGoal(goal.id)
  check('its outcome says verified', (done.outcome ?? '').includes('verified'), done.outcome)
  check('the dispatched goal reported', reported !== null)

  const body = m.buildReport(done)
  check('the report exists for a dispatched goal', body !== null)
  check('the report names the tier', body.tier === 'A')
  check('the report carries a prompt fingerprint', /^[0-9a-f]{40}$/.test(body.promptKey), body.promptKey)
  check(
    'the per-step verdicts travel, skipped included',
    body.gate.typecheck === 'pass' && body.gate.suite === 'pass' && body.gate.review === 'skipped',
    JSON.stringify(body.gate)
  )
  check('the report counts the change', body.filesChanged === 1 && body.insertions === 3, JSON.stringify(body))

  const prior = m.priorDispatch('add the queued feature')
  check('the router can see this ask was tried', prior !== null && prior.failed === false && prior.tier === 'A')
  check('an ask never tried has no history', m.priorDispatch('something never asked') === null)
}

// ---------------------------------------------------------------------------
// 6. askFiles: a separator'd path must exist; a bare filename is taken at its word.

{
  const dir = repo('paths', { typecheck: pass, suite: pass })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'x.ts'), 'export {}\n', 'utf8')
  const files = m.askFiles(dir, 'fix src/x.ts, not phantom/y.ts, and bare.ts too')
  check('a real path counts', files.includes('src/x.ts'), JSON.stringify(files))
  check('an invented path does not', !files.includes('phantom/y.ts'))
  check('a bare filename counts unchecked', files.includes('bare.ts'))

  const ask = m.buildAsk(dir, 'fix src/x.ts', { tier: 'A', failed: true })
  check('buildAsk reads the repo gate', ask.repo.hasTypecheck === true && ask.repo.hasTests === true)
  check('and carries the history', ask.history.lastAttemptFailed === true && ask.history.lastTier === 'A')
  const plan = m.route(ask)
  check('a retry never repeats the tier it failed on', plan.tier !== 'A', plan.tier)
}

console.log(`\n${checks} checks, ${failed} failed`)
rmSync(work, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
