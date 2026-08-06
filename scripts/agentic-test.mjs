/**
 * What the app is allowed to believe about an agent it drove itself.
 *
 * Half of this is model-free arithmetic - a line of a CLI's stream, a `--numstat`, a
 * reviewer's answer - and half of it spawns real processes into real git repositories,
 * because the two failures that matter here cannot be asserted on a pure function:
 *
 *   - **A turn that never ends.** The whole promise of an unattended run is that nothing
 *     can wedge it. So a stub is told to hang for ever and the budget has to kill it -
 *     the `test:wedge` pattern this repository already trusts for the updater, applied
 *     to the thing that will now be left running overnight.
 *   - **A turn that ends having done nothing.** The dangerous outcome of a driven lane is
 *     not a crash, it is twenty minutes of tokens spent producing a comment. A stub that
 *     exits 0 and changes no files must NOT reach the end of the gate.
 *
 * The seam is `bin`: every spawn here is a node script in a temp directory, so the suite
 * neither needs a coding CLI installed nor can accidentally start one.
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-agentic-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'agentic.bundle.cjs')
buildSync({
  absWorkingDir: root,
  // One bundle, not three: `agentRun` keeps its live-run map in module state, and two
  // bundles would give the cancel test a different map from the one the run registered in.
  stdin: {
    contents: [
      "export { runAgentTurn, cancelAgentRun, diffSince, headSha } from './src/main/agentRun'",
      "export { runGate, gateCommands, gateLine } from './src/main/agentGate'",
      "export { startDrive, stopDrive, listDrives, clearFinishedDrives, onDriveChange } from './src/main/supervisor'",
      "export { parseEvent, foldEvents, parseDiffstat, noOp, parseVerdict, retryBrief,",
      "  headlessArgs, driveLine, runDone, MAX_ATTEMPTS, TRIVIAL_LINES } from './src/shared/agentic'"
    ].join('\n'),
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const m = createRequire(import.meta.url)(out)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------------------
// Reading a CLI's stream

const line = (o) => JSON.stringify(o)

check(
  'a claude init line is a start',
  m.parseEvent(line({ type: 'system', subtype: 'init', model: 'sonnet' }))?.kind === 'start'
)
check(
  'a tool_use is a tool, named, with its file',
  (() => {
    const e = m.parseEvent(
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] }
      })
    )
    return e?.kind === 'tool' && e.name === 'Edit' && e.target === 'src/a.ts'
  })()
)
check(
  'a tool call outranks the text in the same message',
  m.parseEvent(
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'let me edit that' },
          { type: 'tool_use', name: 'Write', input: { file_path: 'b.ts' } }
        ]
      }
    })
  )?.kind === 'tool'
)
check('prose down the same pipe is not an event', m.parseEvent('Loading config...') === null)
check('a truncated line is not an event', m.parseEvent('{"type":"assis') === null)
check(
  'a result carries whether it failed',
  m.parseEvent(line({ type: 'result', subtype: 'error_max_turns', result: '', is_error: true }))?.error === true
)
check(
  'codex is read with its own parser',
  m.parseEvent(line({ msg: { type: 'agent_message', message: 'done' } }), 'codex')?.kind === 'text'
)

const folded = m.foldEvents([
  { kind: 'start' },
  { kind: 'tool', name: 'Read' },
  { kind: 'tool', name: 'Edit' },
  { kind: 'tool', name: 'Edit' },
  { kind: 'usage', input: 100, output: 20 },
  { kind: 'usage', input: 200, output: 30 },
  { kind: 'result', text: 'built it', error: false, input: 900, output: 45, costUsd: 0.12 }
])
check('tool calls are counted per name', folded.toolCalls === 3 && folded.tools.Edit === 2, JSON.stringify(folded.tools))
check(
  'tokens take the larger of the sum and the final figure',
  folded.tokens.input === 900 && folded.tokens.output === 50,
  JSON.stringify(folded.tokens)
)
check('the final message is what the run means', folded.text === 'built it')
check('a result event marks the turn finished', folded.finished && !folded.errored)
check(
  'a run with no result is not finished',
  m.foldEvents([{ kind: 'text', text: 'thinking' }]).finished === false
)

// ---------------------------------------------------------------------------
// What changed, and whether it counts

const stat = m.parseDiffstat(['12\t3\tsrc/a.ts', '-\t-\tbuild/icon.png', '4\t0\told.ts => new.ts'].join('\n'))
check('numstat adds up', stat.files === 3 && stat.added === 16 && stat.removed === 3, JSON.stringify(stat))
check('a binary file is a change, not zero lines', stat.paths.includes('build/icon.png'))
check('a rename is recorded at its new name', stat.paths.includes('new.ts'), JSON.stringify(stat.paths))
check(
  'a braced rename keeps its prefix',
  m.parseDiffstat('1\t1\tsrc/{old => new}/f.ts').paths[0] === 'src/new/f.ts',
  m.parseDiffstat('1\t1\tsrc/{old => new}/f.ts').paths[0]
)

check('an empty diff is a no-op', m.noOp({ files: 0, added: 0, removed: 0, paths: [] }).noop)
check('a one-line diff is a no-op worth reporting', m.noOp({ files: 1, added: 1, removed: 0, paths: [] }).noop)
check(
  'real work is not a no-op',
  m.noOp({ files: 1, added: m.TRIVIAL_LINES + 1, removed: 0, paths: [] }).noop === false
)

// ---------------------------------------------------------------------------
// The reviewer. The direction of the default is the whole gate.

check('an explicit pass is a pass', m.parseVerdict({ pass: true, summary: 'fine' }).pass)
check('an explicit fail is a fail', m.parseVerdict({ pass: false, summary: 'no' }).pass === false)
check('no answer at all is NOT a pass', m.parseVerdict(null).pass === false)
check('an unreadable answer is NOT a pass', m.parseVerdict({ verdict: 'looks good' }).pass === false)
check('a truthy non-true is NOT a pass', m.parseVerdict({ pass: 'yes' }).pass === false)

const brief = m.retryBrief(
  {
    ok: false,
    failedAt: 'typecheck',
    steps: [{ name: 'typecheck', ok: false, detail: 'error TS2322', ms: 10, output: 'src/a.ts(9,3): error TS2322' }]
  },
  0
)
check('the retry brief carries the real failure', brief.includes('error TS2322'))
check('the retry brief says which attempt this is', brief.includes(`of ${m.MAX_ATTEMPTS}`))
check('the retry brief forbids deleting the test', /weaken or delete a test/.test(brief))

// ---------------------------------------------------------------------------
// Arguments

check(
  'a model goes in before a trailing stdin marker',
  (() => {
    const a = m.headlessArgs('codex', 'gpt-5')
    return a[a.length - 1] === '-' && a.includes('--model')
  })(),
  m.headlessArgs('codex', 'gpt-5').join(' ')
)
check('claude asks for a parseable stream', m.headlessArgs('claude').join(' ').includes('stream-json'))
check('an agent nobody can drive says so', m.headlessArgs('shell') === null)

// ---------------------------------------------------------------------------
// Real processes, real repositories

const node = process.execPath
const stubs = join(work, 'stubs')
mkdirSync(stubs, { recursive: true })

// `.cjs`, not `.mjs`: the stubs use `require`, and a bare `.mjs` under a directory with
// no package.json is loaded as an ES module where `require` does not exist - which fails
// as "Node.js v24.10.0" on the last line of a stack trace and looks like a spawn problem
// rather than a module-format one.
function stub(name, body) {
  const p = join(stubs, `${name}.cjs`)
  writeFileSync(p, body, 'utf8')
  return p
}

function repo(name, files = {}) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n', 'utf8')
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body, 'utf8')
  git('add', '-A')
  git('commit', '-qm', 'seed')
  return dir
}

// A CLI that writes a file and reports a clean turn.
const worker = stub(
  'worker',
  `
  const { writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  let seen = ''
  process.stdin.on('data', (d) => (seen += d))
  process.stdin.on('end', () => {
    writeFileSync(join(process.cwd(), 'feature.ts'), 'export const feature = 1\\n'.repeat(8))
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    say({ type: 'system', subtype: 'init', model: 'stub' })
    say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'feature.ts' } }] } })
    // Deliberately split across two writes with the newline in the SECOND chunk: a line
    // arriving in pieces is the ordinary case on a real pipe and the parser must join it.
    const tail = JSON.stringify({ type: 'result', subtype: 'success', result: 'wrote the feature', is_error: false, usage: { output_tokens: 40 } })
    process.stdout.write(tail.slice(0, 20))
    setTimeout(() => { process.stdout.write(tail.slice(20) + '\\n'); process.exit(0) }, 30)
  })
`
)

// A CLI that never stops. It also ignores SIGTERM, so only a real kill ends it.
const hang = stub('hang', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
// A CLI that exits cleanly having said and done nothing at all.
const mute = stub('mute', `process.stdin.resume(); process.stdin.on('end', () => process.exit(0))`)

const cwdA = repo('built')
const turn = await m.runAgentTurn({
  cwd: cwdA,
  agent: 'claude',
  bin: node,
  argsPrefix: [worker],
  prompt: 'build the feature',
  key: 'test:built',
  budgetMs: 20_000
})
check('a real turn resolves as done', turn.exit === 'done' && turn.ok, `${turn.exit} ${turn.detail}`)
check('it saw the tool call', turn.toolCalls === 1 && turn.tools.Write === 1, JSON.stringify(turn.tools))
check('a line split across chunks still parses', turn.text === 'wrote the feature', turn.text)
check(
  'an UNCOMMITTED new file counts as work done',
  turn.diffstat.files === 1 && turn.diffstat.added === 8,
  JSON.stringify(turn.diffstat)
)

const hungAt = Date.now()
const hungTurn = await m.runAgentTurn({
  cwd: repo('hung'),
  agent: 'claude',
  bin: node,
  argsPrefix: [hang],
  prompt: 'hang',
  key: 'test:hung',
  budgetMs: 900
})
const hungMs = Date.now() - hungAt
check('a turn that never ends is killed by its budget', hungTurn.exit === 'budget', hungTurn.exit)
check('and it is killed on time, not eventually', hungMs < 8000, `${hungMs}ms`)
check('the budget kill says so in one line', /still running/.test(hungTurn.detail), hungTurn.detail)

const cancelCwd = repo('cancelled')
const pending = m.runAgentTurn({
  cwd: cancelCwd,
  agent: 'claude',
  bin: node,
  argsPrefix: [hang],
  prompt: 'hang',
  key: 'test:cancel',
  budgetMs: 60_000
})
setTimeout(() => m.cancelAgentRun('test:cancel'), 400)
const cancelled = await pending
check('a cancel settles the turn', cancelled.exit === 'cancelled', cancelled.exit)

const muteTurn = await m.runAgentTurn({
  cwd: repo('mute'),
  agent: 'claude',
  bin: node,
  argsPrefix: [mute],
  prompt: 'say nothing',
  key: 'test:mute',
  budgetMs: 20_000
})
check('exiting 0 having said nothing is not success', muteTurn.exit === 'silent' && !muteTurn.ok, muteTurn.exit)

const missing = await m.runAgentTurn({
  cwd: repo('missing'),
  agent: 'shell',
  prompt: 'x',
  key: 'test:missing',
  budgetMs: 1000
})
check('an agent that cannot be driven fails before spawning', missing.exit === 'unavailable', missing.exit)

// ---------------------------------------------------------------------------
// The gate

// A lane that changed nothing must not reach the commands, let alone the reviewer.
const idle = repo('idle')
const idleGate = await m.runGate({
  cwd: idle,
  base: await m.headSha(idle),
  mission: 'do the thing',
  brief: 'do the thing',
  agent: 'claude',
  key: 'test:idle',
  skipReview: true
})
check('a lane that changed nothing fails at the diff', !idleGate.ok && idleGate.failedAt === 'diff', idleGate.failedAt)
check('and it says so in words', /changed nothing/.test(m.gateLine(idleGate)), m.gateLine(idleGate))
check('nothing else was run', idleGate.steps.length === 1, JSON.stringify(idleGate.steps.map((s) => s.name)))

// A lane whose work does not typecheck stops there, and hands back the real output.
const broken = repo('broken', {
  'package.json': JSON.stringify({
    name: 'broken',
    scripts: { typecheck: `"${node.replace(/\\/g, '/')}" -e "console.log('src/a.ts: error TS9999'); process.exit(1)"` }
  })
})
writeFileSync(join(broken, 'a.ts'), 'export const a = 1\n'.repeat(9), 'utf8')
const brokenGate = await m.runGate({
  cwd: broken,
  base: await m.headSha(broken),
  mission: 'add a',
  brief: 'add a',
  agent: 'claude',
  key: 'test:broken',
  skipReview: true
})
check('a lane that does not typecheck fails there', !brokenGate.ok && brokenGate.failedAt === 'typecheck', brokenGate.failedAt)
check(
  'the failure carries the compiler’s own words',
  /TS9999/.test(brokenGate.steps.find((s) => s.name === 'typecheck')?.output ?? ''),
  brokenGate.steps.find((s) => s.name === 'typecheck')?.detail
)

// A repo with no scripts at all still gets a verdict, and the missing steps SAY they
// were missing rather than reading as passes.
const bare = repo('bare')
writeFileSync(join(bare, 'x.ts'), 'export const x = 1\n'.repeat(9), 'utf8')
const bareGate = await m.runGate({
  cwd: bare,
  base: await m.headSha(bare),
  mission: 'x',
  brief: 'x',
  agent: 'claude',
  key: 'test:bare',
  skipReview: true
})
check('a repo with no checks still passes the diff step', bareGate.ok, m.gateLine(bareGate))
check(
  'a missing check is reported as skipped, never as passed',
  bareGate.steps.filter((s) => /^skipped/.test(s.detail)).length >= 2,
  JSON.stringify(bareGate.steps.map((s) => `${s.name}:${s.detail}`))
)
check(
  'gateCommands finds this repository’s own typecheck',
  (m.gateCommands(root).typecheck ?? []).join(' ').includes('typecheck'),
  JSON.stringify(m.gateCommands(root).typecheck)
)

// The reviewer, against a stub that refuses. A refusal must stop the lane.
const reviewed = repo('reviewed')
writeFileSync(join(reviewed, 'y.ts'), 'export const y = 1\n'.repeat(9), 'utf8')
const nay = stub(
  'nay',
  `
  let seen = ''
  process.stdin.on('data', (d) => (seen += d))
  process.stdin.on('end', () => {
    // Proves the reviewer was handed the actual patch, not just the task.
    const sawDiff = seen.includes('DIFF START') && seen.includes('export const y')
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    say({ type: 'result', subtype: 'success', is_error: false,
          result: JSON.stringify({ pass: false, summary: sawDiff ? 'it does not do what was asked' : 'no diff reached me', issues: ['placeholder left behind'] }) })
    process.exit(0)
  })
`
)
const nayGate = await m.runGate({
  cwd: reviewed,
  base: await m.headSha(reviewed),
  mission: 'y',
  brief: 'y',
  agent: 'claude',
  bin: node,
  argsPrefix: [nay],
  key: 'test:review'
})
check('a reviewer’s refusal fails the lane', !nayGate.ok && nayGate.failedAt === 'review', nayGate.failedAt)
check(
  'the reviewer was given the diff, not just the task',
  nayGate.steps.find((s) => s.name === 'review')?.detail === 'it does not do what was asked',
  nayGate.steps.find((s) => s.name === 'review')?.detail
)

// And a reviewer that answers nothing at all is a fail, not a pass.
const quietGate = await m.runGate({
  cwd: reviewed,
  base: await m.headSha(reviewed),
  mission: 'y',
  brief: 'y',
  agent: 'claude',
  bin: node,
  // `mute` exits 0 having printed nothing - the shape a crashed or rate-limited CLI has.
  argsPrefix: [mute],
  key: 'test:review-quiet'
})
check('a silent reviewer is a fail', !quietGate.ok, m.gateLine(quietGate))

// ---------------------------------------------------------------------------
// The whole loop, end to end
//
// The case worth spending a real run on is the RETRY, because it is the one path where
// being wrong is silent: a lane whose second attempt is started with the wrong text does
// not crash, it quietly repeats the first attempt and fails again. So this stub fails its
// own gate on the first turn (it writes code that does not typecheck) and is handed the
// failure back; if the retry brief reached it, the second turn fixes the file and the
// lane passes. If it did not, the lane fails after three identical attempts.

const twoStep = stub(
  'twostep',
  `
  const { writeFileSync, existsSync } = require('node:fs')
  const { join } = require('node:path')
  let seen = ''
  process.stdin.on('data', (d) => (seen += d))
  process.stdin.on('end', () => {
    const marker = join(process.cwd(), '.attempted')
    const first = !existsSync(marker)
    if (first) {
      writeFileSync(marker, 'x')
      writeFileSync(join(process.cwd(), 'work.txt'), 'BROKEN\\n'.repeat(9))
    } else if (seen.includes('does not typecheck')) {
      writeFileSync(join(process.cwd(), 'work.txt'), 'FIXED\\n'.repeat(9))
    }
    const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
    say({ type: 'result', subtype: 'success', is_error: false, result: first ? 'first pass' : 'fixed it', usage: { output_tokens: 10 } })
    process.exit(0)
  })
`
)

// A repo whose typecheck fails exactly while the file says BROKEN.
const checker = `${node.replace(/\\/g, '/')} -e "const fs=require('fs');const t=fs.readFileSync('work.txt','utf8');if(t.includes('BROKEN')){console.log('work.txt: does not typecheck');process.exit(1)}"`
const driven = repo('driven', {
  'package.json': JSON.stringify({ name: 'driven', scripts: { typecheck: checker } })
})

const plan = {
  contracts: '',
  lanes: [
    { name: 'one', brief: 'write work.txt', owns: ['work.txt'] },
    { name: 'two', brief: 'write work.txt', owns: ['other.txt'] }
  ]
}
// Two lanes, two checkouts. Cloned rather than shared, because the point of a lane is
// that two agents are not looking at the same file.
const laneDirs = ['driven-a', 'driven-b'].map((n) => {
  const dir = join(work, n)
  execFileSync('git', ['clone', '-q', driven, dir], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' })
  return dir
})
let handed = 0
const run = m.startDrive(
  {
    cwd: driven,
    mission: 'write work.txt',
    plan,
    agent: 'claude',
    bin: node,
    argsPrefix: [twoStep],
    skipReview: true
  },
  async () => {
    const dir = laneDirs[handed++]
    return dir ? { cwd: dir, branch: `lane-${handed}` } : null
  }
)
check('a drive returns before it finishes', run.lanes.every((l) => l.state === 'queued'))

const waitFor = async (predicate, ms = 90_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}
const finished = await waitFor(() => m.runDone(run))
check('the run finishes on its own', finished, JSON.stringify(run.lanes.map((l) => `${l.name}:${l.state}`)))
check(
  'a lane that failed its gate is retried and then passes',
  run.lanes.every((l) => l.state === 'passed'),
  JSON.stringify(run.lanes.map((l) => `${l.name}:${l.state}:${l.note}`))
)
check(
  'the retry was a SECOND attempt, not a repeat of the first',
  run.lanes.every((l) => l.attempt === 1),
  JSON.stringify(run.lanes.map((l) => l.attempt))
)
check('tokens are totalled across the run', run.tokens.output > 0, String(run.tokens.output))
check('every lane kept its own checkout', new Set(run.lanes.map((l) => l.cwd)).size === 2)

// Stop, mid-flight. The stub hangs, so nothing can end this run except the switch.
const stopDirs = ['stop-a'].map((n) => {
  const dir = join(work, n)
  execFileSync('git', ['clone', '-q', driven, dir], { stdio: 'ignore' })
  return dir
})
const stoppable = m.startDrive(
  {
    cwd: driven,
    mission: 'hang about',
    plan: { contracts: '', lanes: [{ name: 'solo', brief: 'hang', owns: ['a.txt'] }] },
    agent: 'claude',
    bin: node,
    argsPrefix: [hang],
    skipReview: true
  },
  async () => ({ cwd: stopDirs[0], branch: 'lane-stop' })
)
await waitFor(() => stoppable.lanes[0].cwd !== '', 20_000)
m.stopDrive(stoppable.id)
const stopped = await waitFor(() => m.runDone(stoppable), 20_000)
check('stop ends a run that would otherwise never end', stopped, JSON.stringify(stoppable.lanes[0]?.state))
check('a stopped lane says stopped', stoppable.lanes[0]?.state === 'stopped', stoppable.lanes[0]?.state)
check('finished runs can be forgotten', m.clearFinishedDrives() >= 2 && m.listDrives().length === 0)

// ---------------------------------------------------------------------------
// The words the board says

check(
  'a passed lane leads with what a person does next',
  m.driveLine({ name: 'a', state: 'passed', cwd: '', branch: '', attempt: 0, note: '', diffstat: { files: 2, added: 30, removed: 4, paths: [] } }).startsWith('ready to review'),
  m.driveLine({ name: 'a', state: 'passed', cwd: '', branch: '', attempt: 0, note: '', diffstat: { files: 2, added: 30, removed: 4, paths: [] } })
)
check(
  'a retry says which attempt it is on',
  m.driveLine({ name: 'a', state: 'retrying', cwd: '', branch: '', attempt: 1, note: 'typecheck failed' }).includes(`2 of ${m.MAX_ATTEMPTS}`)
)
check(
  'a run is done only when every lane is',
  m.runDone({ lanes: [{ state: 'passed' }, { state: 'failed' }] }) === true &&
    m.runDone({ lanes: [{ state: 'passed' }, { state: 'working' }] }) === false
)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
