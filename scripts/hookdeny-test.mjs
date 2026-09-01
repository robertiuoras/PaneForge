// A pane whose commands are being refused, and the two ways that reading goes wrong.
//
// The fixtures here are REAL: every deny string below is copied out of
// ~/.claude/projects/-Users-robertiuoras-Projects-clients/0db2932a-....jsonl, the clients
// session of 2026-09-01 that had 7 of its 57 tool calls refused by run-guard between
// 04:00:31 and 04:02:22. A hand-written "BLOCKED: something" proves nothing about a
// matcher whose whole job is telling a real refusal apart from the CLI echoing one back.
//
// The two failure modes this pins:
//   1. An echoed refusal is not a refusal. Once the text has gone back to the agent the
//      CLI prints it again inside the conversation, and a person can paste one into a
//      prompt - both arrive behind a `>` marker. Counting those would make every refusal
//      read as two or three.
//   2. One row per stretch, never one per refusal. Seven rows saying the same thing is
//      the noise the bell exists to replace.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-hookdeny-'))
const outfile = join(work, 'hookdeny.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/hookDeny.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { readDenies, stretchDue, denyWords, STRETCH_QUIET_MS, MIN_FOR_ROW } = createRequire(
  import.meta.url
)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

// Verbatim, including the box-drawing furniture the CLI draws in front of a tool result.
const RUN_GUARD =
  '  ⎿  Error: BLOCKED: 3 consecutive Bash calls, each its own round trip (~7s generation + a full context re-read each).'
const COMMAND_LESSONS =
  '  ⎿  Error: command-lessons: Foreground poll loop - DENIED, not advised. This row was a `warn` from 2026-08-08.'
const BASH_GUARD = '  ⎿  Error: BLOCKED by bash-guard: writing to a .env secrets file'

// --- what counts ------------------------------------------------------------

{
  eq('run-guard named', readDenies(RUN_GUARD)[0]?.gate, 'run-guard')
  eq('command-lessons named', readDenies(COMMAND_LESSONS)[0]?.gate, 'command-lessons')
  eq('bash-guard named', readDenies(BASH_GUARD)[0]?.gate, 'bash-guard')
  // A gate this build has never heard of still counts: one firing constantly is exactly
  // the thing worth seeing, and dropping it would hide the newest mis-tuned gate.
  eq('unknown gate still counted', readDenies('  Error: BLOCKED: something new')[0]?.gate, 'a hook')
  eq('ordinary output says nothing', readDenies('npm run build\n> vite build\n').length, 0)
  eq('empty says nothing', readDenies('').length, 0)
}

// A colour code between the furniture and the marker must not hide it.
{
  const coloured = `  ⎿  [31mError: BLOCKED: 6 consecutive Bash calls, each its own round trip[0m`
  eq('colour does not hide it', readDenies(coloured)[0]?.gate, 'run-guard')
}

// --- what does NOT count ----------------------------------------------------

{
  // The echo: submitted, the CLI reprints the whole thing behind its prompt marker.
  const echoed = '> BLOCKED: 3 consecutive Bash calls, each its own round trip'
  eq('an echoed refusal is not one', readDenies(echoed).length, 0)
  // Somebody talking about it.
  const quoted = '  I got BLOCKED: 3 consecutive Bash calls again, so I merged them'
  eq('a quoted refusal is not one', readDenies(quoted).length, 0)
  // A warn, not a deny: command-lessons injects context far more often than it refuses.
  const warned = '  ⎿  command-lessons: this command is usually slower than rg'
  eq('a warn is not a deny', readDenies(warned).length, 0)
}

// --- every refusal in one chunk ---------------------------------------------

{
  const chunk = [RUN_GUARD, 'some other output', COMMAND_LESSONS].join('\n')
  eq('both found in one chunk', readDenies(chunk).length, 2)
}

// --- one row per stretch ----------------------------------------------------

{
  const at = 1_700_000_000_000
  // Still being refused: nothing is written, however many there have been.
  check('a live stretch is not due', !stretchDue({ gate: 'run-guard', count: 7, at }, at + 1000))
  check(
    'a stretch that stopped is due',
    stretchDue({ gate: 'run-guard', count: 7, at }, at + STRETCH_QUIET_MS)
  )
  // One refusal says nothing about the gate. Two is the floor.
  check(
    'one refusal earns no row',
    !stretchDue({ gate: 'run-guard', count: 1, at }, at + STRETCH_QUIET_MS * 4)
  )
  eq('and the floor is what the module says', MIN_FOR_ROW, 2)
}

// --- the sentence -----------------------------------------------------------

{
  const words = denyWords('run-guard', 7)
  eq('names the gate and the count', words, '7 commands in a row, by run-guard')
  // The row's left column already carries the verb.
  check('does not repeat the row verb', !/^refused/i.test(words), words)
}


// --- the main-side half: does a stretch actually become a row -----------------
//
// Everything above is the matcher. What can still be wrong is the accounting: counting
// per pane and per gate, writing ONE row when the refusals stop, and never writing one
// while they are still coming. `src/main/hookDeny.ts` is bundled here with electron
// stubbed down to `app.getPath`, which is all `main/activity.ts` needs, so the row is
// written to a real file by the real code rather than by a mock of it.

const mainOut = join(work, 'main-hookdeny.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['scripts/stubs/hookdeny-entry.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  alias: { electron: resolve(root, 'scripts/stubs/electron-app.cjs') },
  outfile: mainOut
})
const main = createRequire(import.meta.url)(mainOut)
const { listActivity } = main

{
  main.resetHookDeny()
  main.hookDenyNames(() => '(4) clients')
  const t0 = 1_700_000_000_000
  eq('a refusal is read off the pane', main.feedHookDeny('p1', RUN_GUARD, t0), 1)
  main.feedHookDeny('p1', RUN_GUARD, t0 + 3000)
  main.feedHookDeny('p1', COMMAND_LESSONS, t0 + 4000)
  // Still being refused: nothing on the list yet.
  main.sweepHookDeny(t0 + 5000)
  eq('nothing written while it is still happening', listActivity().items.length, 0)
  // The refusals stop.
  main.sweepHookDeny(t0 + 4000 + STRETCH_QUIET_MS)
  const rows = listActivity().items
  eq('one row for the gate that fired twice', rows.length, 1)
  eq('and it counts them', rows[0].why, '2 commands in a row, by run-guard')
  eq('named the pane', rows[0].what, '(4) clients')
  eq('as a refusal', rows[0].kind, 'refused')
  // The single command-lessons refusal never earns a row of its own.
  main.sweepHookDeny(t0 + 4000 + STRETCH_QUIET_MS * 3)
  eq('a lone refusal still says nothing', listActivity().items.length, 1)
  main.resetHookDeny()
}


rmSync(work, { recursive: true, force: true })
console.log(`hookdeny: ${checks} checks passed`)
