/**
 * What the app is allowed to promise about work nobody is watching.
 *
 * I3 made a driven lane defensible - it is verified before it is called finished. I4 is
 * the part that makes it *unattended*: the ask is on disk, a second ask waits its turn
 * instead of fighting the first for worktrees, and when it ends something knows what it
 * turned into. Three of those four cannot be asserted on a pure function, so half of this
 * file spawns real stub CLIs into real git repositories, the way `test:agentic` does.
 *
 * The assertions that matter, in the order they would bite:
 *
 *   - **A goal survives the process.** Written atomically, read back with its plan and
 *     its attempts. A queue that forgets what it was asked to do is worse than no queue.
 *   - **A goal that was RUNNING when the app died is `interrupted`, not `done` and not
 *     re-run.** Its agents were killed on the way out, so the branch holds whatever had
 *     been written by then. Calling that a pass would put unreviewed work on a board
 *     saying "ready to review"; re-queueing it by itself would start a second agent over
 *     a worktree nobody has looked at.
 *   - **The second goal starts by itself.** Not when a person comes back - the moment the
 *     first one ends. This is the whole feature and it is the one thing a test that only
 *     called `addGoal` twice would never notice was broken.
 *   - **`outcome` stops being null.** The oldest null in this repo: the prompt archive has
 *     never been able to say what an ask became, because nothing in the app knew.
 *
 * The seam is `bin`: every agent spawned here is a node script in a temp directory, so
 * the suite neither needs a coding CLI installed nor can accidentally start one.
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-goals-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// userData for the run. `goals.json` and `prompt-archive.jsonl` both land here.
const data = join(work, 'userData')
mkdirSync(data, { recursive: true })

// `electron` is not installed as a loadable module in this context and would pull a whole
// runtime in if it were. One stub, aliased at bundle time, covers every importer.
const electronStub = join(work, 'electron-stub.cjs')
writeFileSync(
  electronStub,
  `module.exports = { app: { getPath: () => ${JSON.stringify(data)} } }\n`,
  'utf8'
)

const out = join(work, 'goals.bundle.cjs')
buildSync({
  absWorkingDir: root,
  // One bundle: `supervisor` and `goals` both keep module state (the live runs, the queue)
  // and two bundles would give the queue a different supervisor from the one it started.
  stdin: {
    contents: [
      "export { goalDone, nextGoal, queuePosition, snapshotRun, attemptOutcome, repoName,",
      "  stateForFinishedRun, reviveGoals, sortGoals, pruneGoals, goalLine, GOAL_CAP } from './src/shared/goals'",
      "export { addGoal, listGoals, getGoal, cancelGoal, retryGoal, removeGoal, clearFinishedGoals,",
      "  configureGoals, noteDriveChange, onGoalsChange, pump, flushGoals, resetGoals } from './src/main/goals'",
      "export { recordPrompt, recordOutcome, priorPrompt, resetPromptArchive } from './src/main/promptArchive'",
      "export { runDone } from './src/shared/agentic'",
      "export { listDrives, onDriveChange } from './src/main/supervisor'"
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
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

const goalsFile = join(data, 'goals.json')
const readFile = () => JSON.parse(readFileSync(goalsFile, 'utf8'))
const wipe = () => {
  m.resetGoals()
  rmSync(goalsFile, { force: true })
}

const plan = (names) => ({
  contracts: 'none',
  lanes: names.map((n) => ({ name: n, brief: `do ${n}`, owns: [`${n}.ts`], enabled: true }))
})

// ---------------------------------------------------------------------------
// 1. The arithmetic

check('nothing to run in an empty queue', m.nextGoal([]) === null)

const q = (state, id, createdAt = 1) => ({ id, state, createdAt, plan: plan(['a']), attempts: [] })

check(
  'one goal runs at a time - a queued one waits behind a running one',
  m.nextGoal([q('running', 'r'), q('queued', 'w')]) === null
)
check(
  'and starts the moment nothing is running',
  m.nextGoal([q('done', 'r'), q('queued', 'w')])?.id === 'w'
)
check(
  'the line is first in, first out',
  m.nextGoal([q('queued', 'second', 2), q('queued', 'first', 1)])?.id === 'second',
  'array order is the queue order, not createdAt'
)
check(
  'position counts only what is waiting',
  m.queuePosition([q('running', 'r'), q('queued', 'a'), q('queued', 'b')], 'b') === 2 &&
    m.queuePosition([q('running', 'r'), q('queued', 'a')], 'r') === 0
)

check('a repo is named by its folder, whatever the separator', m.repoName('C:\\code\\taskdriver') === 'taskdriver')

// The outcome string is what `promptArchive.out` will hold for ever, so its shape is
// pinned rather than left to whatever reads well on the day.
const lanes = (spec) =>
  spec.map(([name, state, files = 3, added = 40, removed = 5]) => ({
    name,
    state,
    branch: `lane-${name}`,
    note: state === 'failed' ? 'typecheck: 2 errors' : 'verified',
    files,
    added,
    removed
  }))

check(
  'an outcome names the repo, the branch, the commit and the size',
  m.attemptOutcome('/code/PaneForge', lanes([['a', 'passed']]), { a: 'abcdef1234' }) ===
    'PaneForge lane-a@abcdef1 verified, 3 files, +40 −5',
  m.attemptOutcome('/code/PaneForge', lanes([['a', 'passed']]), { a: 'abcdef1234' })
)
check(
  'a branch with no sha read is still named',
  m.attemptOutcome('/code/PaneForge', lanes([['a', 'passed']])).includes('lane-a verified')
)
check(
  'a mixed result is neither a success nor a failure - it counts the rest',
  m.attemptOutcome('/code/PaneForge', lanes([['a', 'passed'], ['b', 'failed']])).endsWith(', 1 failed'),
  m.attemptOutcome('/code/PaneForge', lanes([['a', 'passed'], ['b', 'failed']]))
)
check(
  'no lane passed means there is no branch to review, and it says why',
  m.attemptOutcome('/code/x', lanes([['a', 'failed']])) === 'x - no branch to review: typecheck: 2 errors',
  m.attemptOutcome('/code/x', lanes([['a', 'failed']]))
)

// The recovery. This is the assertion the whole restart story rests on.
const revived = m.reviveGoals(
  [
    { ...q('running', 'live'), cwd: '/code/PaneForge', runId: 'abc', outcome: null },
    { ...q('queued', 'waiting'), cwd: '/code/PaneForge', outcome: null },
    { ...q('done', 'old'), cwd: '/code/PaneForge', outcome: 'PaneForge lane-a verified' }
  ],
  1000
)
check('a goal caught running by a restart becomes interrupted', revived.goals[0].state === 'interrupted')
check('and says so rather than leaving outcome null', Boolean(revived.goals[0].outcome))
check('it loses its dead run id', revived.goals[0].runId === undefined)
check('a queued goal is untouched by the recovery', revived.goals[1].state === 'queued')
check('a finished goal is untouched too', revived.goals[2].outcome === 'PaneForge lane-a verified')
check('and the count is reported', revived.revived === 1)

check(
  'pruning never drops a live goal, however many finished ones there are',
  (() => {
    const many = Array.from({ length: m.GOAL_CAP + 20 }, (_, i) => ({
      ...q('done', `d${i}`, i),
      endedAt: i
    }))
    const kept = m.pruneGoals([...many, q('queued', 'mine', 1), q('running', 'live', 2)])
    return (
      kept.some((g) => g.id === 'mine') &&
      kept.some((g) => g.id === 'live') &&
      kept.filter((g) => m.goalDone(g)).length === m.GOAL_CAP
    )
  })()
)
check(
  'pruning keeps the NEWEST finished ones',
  (() => {
    const many = Array.from({ length: m.GOAL_CAP + 5 }, (_, i) => ({ ...q('done', `d${i}`, i), endedAt: i }))
    const kept = m.pruneGoals(many)
    return kept.every((g) => Number(g.id.slice(1)) >= 5)
  })()
)

check(
  'a waiting goal is told where it is in the line, not just that it is waiting',
  m.goalLine(q('queued', 'a'), 3) === 'waiting - 3 in line'
)
check(
  'an interrupted goal says what happened and what to press',
  m.goalLine(q('interrupted', 'a')).includes('retry')
)

// ---------------------------------------------------------------------------
// 2. The file

wipe()
// No claim wired on purpose: this section is about the file, and a queue that can
// start something would pump the goal to `running` before the assertion below.
const added = m.addGoal({
  mission: 'add a pagination guard to the links page',
  cwd: join(work, 'repo-never-runs'),
  agent: 'claude',
  plan: plan(['ui', 'api'])
})
check('a goal is queued the moment it is added', added.state === 'queued')
check('and it is on disk immediately, not after a debounce', readFile().length === 1)
check('the file carries the plan, not just the words', readFile()[0].plan.lanes.length === 2)

// A restart: forget everything in memory and read the file as a fresh process would.
m.resetGoals()
const reloaded = m.listGoals()
check('a goal survives a restart', reloaded.length === 1 && reloaded[0].mission === added.mission)
check('with its id', reloaded[0].id === added.id)

// A goal the file says was running, which is what a kill mid-run leaves behind.
m.resetGoals()
writeFileSync(
  goalsFile,
  JSON.stringify([
    {
      ...added,
      state: 'running',
      runId: 'gone',
      startedAt: 1,
      cwd: join(work, 'repo-never-runs'),
      attempts: [],
      outcome: null
    }
  ]),
  'utf8'
)
const afterCrash = m.listGoals()
check('a goal left running by a kill is interrupted on the next start', afterCrash[0].state === 'interrupted')
check('the recovery is written back, not just returned', readFile()[0].state === 'interrupted')

check('an interrupted goal can be put back in the line', m.retryGoal(afterCrash[0].id) === true)
check('and is queued again, keeping its attempts', m.getGoal(afterCrash[0].id).state === 'queued')
check('a live goal cannot be forgotten', m.removeGoal(afterCrash[0].id) === false)
check('cancelling one that never started marks it', m.cancelGoal(afterCrash[0].id) === true)
check('and it is cancelled, not done', m.getGoal(afterCrash[0].id).state === 'cancelled')
check('now it can be forgotten', m.removeGoal(afterCrash[0].id) === true)
check('and the file agrees', readFile().length === 0)

// ---------------------------------------------------------------------------
// 3. Real processes: the queue actually drives, one at a time, unattended

const node = process.execPath
const stubs = join(work, 'stubs')
mkdirSync(stubs, { recursive: true })

// `.cjs` on purpose - see the note in `agentic-test.mjs`: an `.mjs` stub using `require`
// fails as the node version on the last line of a stack and reads as a spawn problem.
function stub(name, body) {
  const p = join(stubs, `${name}.cjs`)
  writeFileSync(p, body, 'utf8')
  return p
}

function repo(name) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  return dir
}

// A CLI that writes a real file and reports a clean turn, so the diffstat is not a no-op
// and the gate has something to pass.
const worker = stub(
  'worker',
  `
  const { writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  let seen = ''
  process.stdin.on('data', (d) => (seen += d))
  process.stdin.on('end', () => {
    writeFileSync(join(process.cwd(), 'done.ts'), 'export const done = 1\\n'.repeat(9))
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    say({ type: 'system', subtype: 'init', model: 'stub' })
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'done.ts' } }] } })
    say({ type: 'result', subtype: 'success', result: 'wrote it', is_error: false, usage: { output_tokens: 30 } })
    process.exit(0)
  })
`
)

const base = repo('queued-repo')
// One lane checkout per goal, handed out and never shared - the same rule a real claim
// follows, and here it also proves the queue asked for a fresh one on the second goal.
const pool = ['lane-1', 'lane-2'].map((n) => {
  const dir = join(work, n)
  execFileSync('git', ['clone', '-q', base, dir], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' })
  return dir
})

wipe()
let handed = 0
const claimed = []
// The board's listener, wired the way `index.ts` wires it - the goal queue is fed from the
// single supervisor listener rather than registering a second one.
m.onDriveChange((run) => m.noteDriveChange(run))
m.configureGoals(
  () => async () => {
    const dir = pool[handed++]
    if (!dir) return null
    claimed.push({ dir, at: Date.now() })
    return { cwd: dir, branch: `lane-${handed}` }
  },
  { bin: node, argsPrefix: [worker] }
)

const MISSION_ONE = 'write the done marker in the first lane of the queue'
const MISSION_TWO = 'write the done marker in the second lane of the queue'

// The archive has to have SEEN the ask before it can be told what it became - it is fed
// from bytes on their way to a pty and never invents a row.
m.recordPrompt(MISSION_ONE, { project: 'queued-repo', agent: 'claude' })

const goalOne = m.addGoal({ mission: MISSION_ONE, cwd: base, agent: 'claude', plan: plan(['one']), skipReview: true })
const goalTwo = m.addGoal({ mission: MISSION_TWO, cwd: base, agent: 'claude', plan: plan(['two']), skipReview: true })

check('the first goal starts on its own, with nobody pressing anything', goalOne.state === 'running')
check('the second one waits rather than starting beside it', goalTwo.state === 'queued')

const waitFor = async (predicate, ms = 120_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const bothOver = await waitFor(() => {
  const [a, b] = [m.getGoal(goalOne.id), m.getGoal(goalTwo.id)]
  return m.goalDone(a) && m.goalDone(b)
})
const one = m.getGoal(goalOne.id)
const two = m.getGoal(goalTwo.id)

check('both goals finish unattended', bothOver, `${one?.state} / ${two?.state}`)
check(
  'the second one was STARTED by the first one finishing',
  two && two.attempts.length === 1,
  JSON.stringify(two?.attempts?.length)
)
check(
  'each goal got its own checkout',
  new Set(claimed.map((c) => c.dir)).size === 2,
  JSON.stringify(claimed.map((c) => c.dir))
)
check(
  'the second checkout was not claimed until the first goal had ended',
  claimed.length === 2 && one?.endedAt !== undefined && claimed[1].at >= one.endedAt,
  `claimed at ${claimed[1]?.at}, first goal ended ${one?.endedAt}`
)
check(
  'a finished goal knows what it produced',
  Boolean(one?.outcome) && one.outcome.includes('verified'),
  one?.outcome
)
check(
  'and its attempt kept the lane, the branch and the size',
  one?.attempts[0]?.lanes[0]?.files > 0 && Boolean(one.attempts[0].lanes[0].branch),
  JSON.stringify(one?.attempts[0]?.lanes)
)
check('the outcome is on disk with it', Boolean(readFile().find((g) => g.id === goalOne.id)?.outcome))
check(
  'a goal that ran is done, never "passed" - the gate answers per lane and a person answers overall',
  one?.state === 'done',
  one?.state
)

// ---------------------------------------------------------------------------
// 4. The oldest null

const prior = m.priorPrompt(MISSION_ONE, { now: Date.now() + 7 * 60 * 60 * 1000 })
check('the archive can now say what an ask turned into', Boolean(prior?.outcome), JSON.stringify(prior))
check(
  'and it is the goal\u2019s own outcome, not a guess',
  prior?.outcome === one?.outcome,
  `${prior?.outcome} vs ${one?.outcome}`
)
check(
  'an ask the archive has never seen does NOT gain a row',
  m.recordOutcome('an ask that was never typed into any pane at all', 'x') === false
)

// ---------------------------------------------------------------------------

m.flushGoals()
console.log(failed ? `\n${failed} failed` : '\ngoals: all good')
process.exit(failed ? 1 : 0)
