// A pane opened on a backlog task is briefed from the task.
//
// The rules that must hold whatever the backlog contains: an id that names nothing or two
// things opens NO pane, a finished item is not something to start, and the `Done means:`
// block is the item's own acceptance criterion rather than an invented one - the same
// command `claude-config/backlog.mjs done --gate` will run to judge the pane.
//
// The last half is PARITY with the real store: it folds Robert's own backlog.jsonl and
// asserts a brief comes out of it, and SKIPS OUT LOUD when that machine has no backlog.

import assert from 'node:assert'
import { buildSync } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundled rather than imported: `taskBrief.ts` imports `./promptForge` extensionless, and
// node's type stripping resolves nothing for that. A Windows path is also not a legal ESM
// specifier, which is why the URL conversion is here and not optional.
const out = mkdtempSync(join(tmpdir(), 'pf-taskbrief-'))
const bundle = join(out, 'taskBrief.mjs')
buildSync({ entryPoints: ['src/shared/taskBrief.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bundle })
const { foldBacklog, findTask, taskBrief, closedStates } = await import(pathToFileURL(bundle).href)

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

const ROWS = [
  {
    id: 'a3-compile-task-briefs',
    ev: 'add',
    state: 'open',
    class: 'NOW',
    project: 'PaneForge',
    title: 'Compile a pane brief from a backlog task',
    why: 'Robert still writes most prompts by hand',
    success: '`pf open <repo> --task <id>` opens a pane already carrying the brief',
    scope: 'shared/taskBrief.ts, main/backlogStore.ts, scripts/pf-ctl.mjs',
    impact: 'removes the last hand-typed step from the loop'
  },
  { id: 'a3-compile-task-briefs', ev: 'start', state: 'doing', startedAt: 123 },
  { id: 'old-and-finished', ev: 'add', state: 'open', title: 'Something else' },
  { id: 'old-and-finished', ev: 'done', state: 'done' },
  { id: 'a3-other-thing', ev: 'add', state: 'open', title: 'Another A3-ish row' },
  { ev: 'add', state: 'open', title: 'a row with no id at all' }
]
const store = foldBacklog(ROWS)

// ---------------------------------------------------------------------------
// The fold.

t('the fold is field by field, so a start row does not lose the title', () => {
  assert.strictEqual(store.get('a3-compile-task-briefs').title, 'Compile a pane brief from a backlog task')
  assert.strictEqual(store.get('a3-compile-task-briefs').state, 'doing')
})
t('a row with no id is not a row', () => assert.strictEqual(store.size, 3))

// ---------------------------------------------------------------------------
// Finding one. Nothing may open a pane on a guess.

t('an exact id wins', () => assert.strictEqual(findTask(store, 'a3-other-thing').title, 'Another A3-ish row'))
t('a unique prefix resolves', () => assert.strictEqual(findTask(store, 'a3-compile').id, 'a3-compile-task-briefs'))
t('an exact id beats being a prefix of others', () => {
  const both = foldBacklog([{ id: 'a3', title: 'the short one' }, { id: 'a3-long', title: 'the long one' }])
  assert.strictEqual(findTask(both, 'a3').title, 'the short one')
})
t('an ambiguous prefix refuses BY NAME and resolves nothing', () => {
  const r = findTask(store, 'a3-')
  assert.match(r.error, /names 2 tasks/)
  assert.match(r.error, /a3-compile-task-briefs/)
})
t('an unknown id refuses', () => assert.match(findTask(store, 'nope').error, /no task called "nope"/))
t('an empty reference refuses', () => assert.match(findTask(store, '  ').error, /no task id/))

// ---------------------------------------------------------------------------
// The brief.

const brief = taskBrief(findTask(store, 'a3-compile'))

t('the title is the ask', () => assert.ok(brief.startsWith('Compile a pane brief from a backlog task')))
t('why it matters is carried', () => assert.match(brief, /Robert still writes most prompts by hand/))
t('what it is worth is carried', () => assert.match(brief, /removes the last hand-typed step/))
t('the project is the anchor', () => assert.match(brief, /Start from:\n- the PaneForge repo/))
t("the item's own scope is a fence", () => assert.match(brief, /shared\/taskBrief\.ts/))
t('and so is "only this task"', () => assert.match(brief, /only this task/))
t('the acceptance criterion IS the done block', () =>
  assert.match(brief, /Done means:\n- `pf open <repo> --task <id>` opens a pane already carrying the brief/))
t('the pane is told how to record the result', () =>
  assert.match(brief, /backlog\.mjs done a3-compile-task-briefs/))

t('gate commands join the done block', () => {
  const withGates = taskBrief({ id: 'x', title: 'Do it', gates: ['npm test', 'npm run typecheck'] })
  assert.match(withGates, /- npm test/)
  assert.match(withGates, /- npm run typecheck/)
})
t('an item with no criterion at all still gets a done block', () => {
  assert.match(taskBrief({ id: 'x', title: 'Do it' }), /Done means:\n- the task above is finished/)
})

// ---------------------------------------------------------------------------
// A failed attempt is the thing a hand-typed prompt never carries.

t('one refusal is said, with what it said', () => {
  const again = taskBrief({ id: 'x', title: 'Do it', attempts: 1, evidence: 'npm test exited 1' })
  assert.match(again, /tried 1 time and refused/)
  assert.match(again, /The last refusal said: npm test exited 1/)
})
t('three refusals blame the approach, which is what next-action.mjs decides too', () => {
  const again = taskBrief({ id: 'x', title: 'Do it', attempts: 3 })
  assert.match(again, /tried 3 times and refused - three refusals blame the approach/)
})
t('no attempts says nothing about attempts', () =>
  assert.doesNotMatch(taskBrief({ id: 'x', title: 'Do it' }), /refused/))

// ---------------------------------------------------------------------------
// Refusals travel. A refusal must never come back as a prompt.

t('a refusal passes straight through the forge', () =>
  assert.match(taskBrief(findTask(store, 'nope')).error, /no task called/))
t('a finished item is not something to open a pane on', () => {
  assert.match(taskBrief(findTask(store, 'old-and-finished')).error, /already done/)
  assert.ok(closedStates().includes('done'))
})
t('a row with no title is a refusal, never an empty brief', () =>
  assert.match(taskBrief({ id: 'x', state: 'open' }).error, /no title to work from/))

// ---------------------------------------------------------------------------
// Parity with the real store.

const real = process.env.PF_BACKLOG || join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'ledger', 'backlog.jsonl')
if (!existsSync(real)) {
  console.log('SKIP - no backlog on this machine:', real)
} else {
  const rows = readFileSync(real, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const live = foldBacklog(rows)
  t(`the real store folds to ${live.size} items`, () => assert.ok(live.size > 10))
  t('every open item with a title compiles to a brief with a done block', () => {
    let n = 0
    for (const row of live.values()) {
      if (!row.title || closedStates().includes(row.state)) continue
      const out = taskBrief(row)
      assert.strictEqual(typeof out, 'string', `${row.id} refused: ${out.error}`)
      assert.match(out, /Done means:/)
      n++
    }
    assert.ok(n > 5, `only ${n} open items`)
  })
}

console.log(`\n${pass} checks passed`)
