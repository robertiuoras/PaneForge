// What a driven lane is allowed to do, and that the app says so.
//
// K4. Every agent the app can drive is started with its permission prompt turned off, and
// until this the only place that fact existed was a comment above `HEADLESS`. The words on
// the card are DERIVED from the arguments the run actually carries, and that derivation is
// the thing worth pinning: a posture made stricter later must make the disclosure fall
// silent rather than leave a chip claiming something untrue.
//
// So the load-bearing assertion here is not the wording. It is that every drivable agent is
// accounted for - a new CLI added to `HEADLESS` with a permission flag this file has never
// heard of fails here rather than shipping a board that says nothing about it.
//
//   node scripts/unattended-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-unattended-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'agentic.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/agentic.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { HEADLESS, driveRefusal, drivable, headlessArgs, unattended, unattendedLine } =
  createRequire(import.meta.url)(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}

// --- every drivable agent is accounted for ----------------------------------------------
// The point of the feature. An agent whose posture cannot be described is an agent whose
// posture is invisible on the board, which is the defect K4 exists to close.
for (const id of Object.keys(HEADLESS)) {
  const u = unattended(id)
  ok(u, `${id}: HEADLESS carries a permission flag this file can name (add it to POSTURE)`)
  ok(u.says.length > 10, `${id}: says something in words`)
  // Derived, not restated: the flag named on screen is a substring of what we really pass.
  ok(
    headlessArgs(id).join(' ').includes(u.flag),
    `${id}: the flag on the card is in the arguments the run carries`
  )
  ok(unattendedLine(id).includes(u.flag), `${id}: the sentence names the flag`)
}

// The four the app ships with, by name, so a silent removal is a failure too.
for (const id of ['claude', 'codex', 'gemini', 'qwen']) ok(unattended(id), `${id} is drivable`)
is(unattended('claude').flag, '--permission-mode bypassPermissions', 'claude posture')
is(unattended('codex').flag, '--full-auto', 'codex posture')
is(unattended('gemini').flag, '--yolo', 'gemini posture')

// --- an agent with no headless mode discloses nothing, and refuses nothing ----------------
// A shell pane has nothing to drive, so silence is the right answer at every level: no
// chip, no sentence, and no refusal to explain either.
is(unattended('shell'), null, 'a pane with no headless mode has no posture')
is(unattendedLine('shell'), '', 'and says nothing rather than inventing a flag')
is(drivable('shell'), false, 'and is not drivable in the first place')
is(driveRefusal('shell', false), '', 'refusing unattended runs does not block what cannot run')

// --- the refusal ------------------------------------------------------------------------
is(driveRefusal('claude', true), '', 'allowed: nothing to say')
const why = driveRefusal('claude', false)
ok(why.includes('--permission-mode bypassPermissions'), 'refusal names the flag it refused')
ok(why.includes('Settings'), 'refusal says where to change it')
ok(driveRefusal('codex', false).includes('--full-auto'), 'refusal is per agent, not a constant')

// --- a stricter posture must silence the claim, not keep it ------------------------------
// The reason this is derived. Swap the arguments for a mode that stops to ask, and both the
// chip and the refusal disappear by themselves - no card is left asserting a fact that
// stopped being true.
const kept = HEADLESS.claude.args
HEADLESS.claude = { ...HEADLESS.claude, args: ['-p', '--output-format', 'stream-json', '--verbose'] }
is(unattended('claude'), null, 'a stricter posture disclaims nothing')
is(unattendedLine('claude'), '', 'and the sentence goes with it')
is(driveRefusal('claude', false), '', 'and there is nothing left to refuse')
HEADLESS.claude = { ...HEADLESS.claude, args: kept }
ok(unattended('claude'), 'restored')

console.log(`unattended: ${checks} checks passed`)
