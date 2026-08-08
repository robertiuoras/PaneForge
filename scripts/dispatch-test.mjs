// The router that decides which agent gets an ask, and on what terms.
//
// D1 of docs/agentic-dispatch.md. The whole reason it is arithmetic rather than a model
// call is so it can be checked like this: real asks in, expected tiers out. The asks below
// are Robert's own, off the prompt archive and this repo's commit subjects.
//
// The load-bearing cases are the ones where the CHEAP tier must not be chosen:
//   - a repo that cannot check itself, where the gate would report skipped and pass;
//   - an ask that names no file, which means nobody has found the work yet;
//   - an ask whose words are repo-wide however few files it happens to name;
//   - a second attempt at something the cheap tier already failed.
//
//   node scripts/dispatch-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-dispatch-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'dispatch.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/dispatch.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { route, tierFor, escalate, wideAsk, pinpointed, planLine } =
  createRequire(import.meta.url)(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/** A repo that can prove a diff: both a typecheck and a `test` script. */
const CHECKED = { hasTypecheck: true, hasTests: true }

const ASKS = [
  {
    name: 'one file, and the ask quotes what is in it',
    ask: {
      text: 'the `.row-agent` span is empty on a lane card - give it a floor',
      files: ['src/renderer/src/styles.css'],
      repo: CHECKED
    },
    tier: 'A'
  },
  {
    name: 'one file named as a path, no quotes',
    ask: { text: 'fix the badge in src/main/git.ts', files: ['src/main/git.ts'], repo: CHECKED },
    tier: 'A'
  },
  {
    name: 'three files is not a one-liner',
    ask: {
      text: 'add the config flag and read it in both windows',
      files: ['src/main/config.ts', 'src/shared/types.ts', 'src/renderer/src/App.tsx'],
      repo: CHECKED
    },
    tier: 'B'
  },
  {
    name: 'six files is a change, not a fix',
    ask: {
      text: 'thread the new option through',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      repo: CHECKED
    },
    tier: 'C'
  },
  {
    name: 'no file named at all',
    ask: { text: 'the update sometimes never finishes, work out why', files: [], repo: CHECKED },
    tier: 'C'
  },
  {
    name: 'a rename is repo-wide even when it names one file',
    ask: { text: 'rename the Stash to the Shelf', files: ['src/shared/types.ts'], repo: CHECKED },
    tier: 'C'
  },
  {
    name: 'so is "everywhere"',
    ask: { text: 'use `describePlace` everywhere we print a folder', files: ['x.ts'], repo: CHECKED },
    tier: 'C'
  },
  {
    name: 'a repo with no suite has no cheap tier',
    ask: {
      text: 'fix the typo in `readmeLine`',
      files: ['src/lib.ts'],
      repo: { hasTypecheck: true, hasTests: false }
    },
    tier: 'B'
  },
  {
    name: 'nor does one with no typecheck',
    ask: {
      text: 'fix the typo in `readmeLine`',
      files: ['src/lib.ts'],
      repo: { hasTypecheck: false, hasTests: true }
    },
    tier: 'B'
  },
  {
    name: 'a second attempt never repeats the tier that failed',
    ask: {
      text: 'the `.row-agent` span is empty - give it a floor',
      files: ['src/renderer/src/styles.css'],
      repo: CHECKED,
      history: { sameAskBefore: true, lastAttemptFailed: true, lastTier: 'A' }
    },
    tier: 'B'
  },
  {
    name: 'and a failed B goes to C',
    ask: {
      text: 'the `.row-agent` span is empty - give it a floor',
      files: ['src/renderer/src/styles.css'],
      repo: CHECKED,
      history: { lastAttemptFailed: true, lastTier: 'B' }
    },
    tier: 'C'
  },
  {
    name: 'a failed C stays at C - there is no fourth tier',
    ask: {
      text: 'fix it',
      files: [],
      repo: CHECKED,
      history: { lastAttemptFailed: true, lastTier: 'C' }
    },
    tier: 'C'
  },
  {
    name: 'an ask that had been made before but passed is routed on its own merits',
    ask: {
      text: 'fix the `place` chip',
      files: ['src/shared/place.ts'],
      repo: CHECKED,
      history: { sameAskBefore: true, lastAttemptFailed: false }
    },
    tier: 'A'
  }
]

for (const c of ASKS) eq(c.name, tierFor(c.ask).tier, c.tier)

// --- what each tier costs and checks --------------------------------------------------
{
  const a = route(ASKS[0].ask)
  eq('tier A is Sonnet', a.model, 'sonnet')
  eq('on low effort', a.effort, 'low')
  eq('for six minutes', a.budgetMs, 6 * 60_000)
  check('and its gate is complete apart from the reviewer', a.gate.join() === 'diff,typecheck,suite')
  check('every plan is watchable', a.watch === true)

  const c = route(ASKS[4].ask)
  eq('tier C is Opus', c.model, 'opus')
  check('with all four gate steps', c.gate.length === 4)
  check('and a budget that fits a real piece of work', c.budgetMs >= 30 * 60_000)
}

// The cheap tier is only honest where the gate is complete, so the free CLIs - which have
// no reviewer worth failing closed on - may not appear anywhere else.
{
  const free = route({ ...ASKS[0].ask, freeFirst: true })
  eq('freeFirst routes tier A to a free CLI', free.agent, 'gemini')
  const notFree = route({ ...ASKS[4].ask, freeFirst: true })
  eq('and never routes anything else there', notFree.agent, 'claude')
  const off = route(ASKS[0].ask)
  eq('with the flag off it is the paid tier again', off.agent, 'claude')
}

// --- the pieces, on their own ---------------------------------------------------------
check('a quoted symbol is a pinpoint', pinpointed('the `row-agent` span'))
check('so is a path', pinpointed('fix src/main/git.ts'))
check('a bare sentence is not', !pinpointed('make the sidebar nicer'))
check('"migrate" is wide', wideAsk('migrate the config to zod'))
check('"refactor" is NOT wide - most are one function', !wideAsk('refactor this function'))
eq('A escalates to B', escalate('A'), 'B')
eq('B escalates to C', escalate('B'), 'C')
eq('C is the ceiling', escalate('C'), null)

// --- the line the board draws ----------------------------------------------------------
{
  const line = planLine(route(ASKS[0].ask))
  check('the line names the tier', line.includes('tier A'), line)
  check('the model', line.includes('sonnet'), line)
  check('the budget', line.includes('6m'), line)
  check('and every gate step that will really run', line.includes('diff, typecheck, suite'), line)
}

console.log(`dispatch: ${checks} checks passed`)
