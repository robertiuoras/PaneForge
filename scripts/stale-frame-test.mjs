// A pane that says it is working, on a frame that has stopped moving.
//
// Reported 2026-08-30: "pane 7 was broken for long time showed still running but when I
// pressed fix it fixed". Fix is a SIGWINCH nudge (`Sessions.redraw`), so the recovery is
// something the pane can do for itself - what it needed was a reading that tells a stuck
// frame from a slow one. The load-bearing half of this test is the CONTROL: a live
// Claude Code footer, whose counter ticks every second, must never be nudged however
// long the turn runs.
//
//   node scripts/stale-frame-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-stale-frame-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const bundle = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { dueForRepaint, staleSignature, STALE_AFTER_MS, NUDGE_EVERY_MS, MAX_NUDGES } = bundle(
  'src/shared/staleFrame.ts',
  'stale.bundle.cjs'
)
const { busyEvidence } = bundle('src/shared/busy.ts', 'busy.bundle.cjs')

let bad = 0
const check = (name, got, want) => {
  if (got === want) return console.log(`ok   ${name}`)
  bad++
  console.error(`FAIL ${name}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}

// ---------------------------------------------------------------- the signature moves
//
// Verbatim frames. The whole mechanism rests on a running agent's evidence CHANGING, so
// these are the frames that must produce a different signature a second apart.
const status = '\n  ~/Projects/PaneForge |  master | ✓ synced | █░░░░░░░░░ 13% 127.7k\n'
const ticking = [
  ['✢ Smooshing… (8s · ↓ 282 tokens)', '✻ Smooshing… (9s · ↓ 291 tokens)'],
  ['some output\n  ⎿  Running…\n(esc to interrupt · 12s)', 'some output\n  ⎿  Running…\n(esc to interrupt · 13s)']
]
for (const [a, b] of ticking) {
  const sa = staleSignature(busyEvidence(a + status))
  const sb = staleSignature(busyEvidence(b + status))
  check(`moves: ${JSON.stringify(a.slice(0, 28))}`, sa !== sb && sa !== '', true)
}

// ...and a frame stranded above live output keeps ONE signature. This is the shape the
// bug had: the statusline below the working line is still being repainted (so the pane
// keeps reading, and `busyUntil` in main keeps being renewed), while the working line
// itself has not been touched since the paint that tore.
const stuck = '✢ Smooshing… (8s · ↓ 282 tokens)'
const first = staleSignature(busyEvidence(stuck + status))
const later = staleSignature(
  busyEvidence(stuck + '\n  ~/Projects/PaneForge |  master | ✓ synced | █░░░░░░░░░ 15% 152.3k\n')
)
check('stranded working line keeps its signature under moving traffic', first === later && first !== '', true)

// A frame with nothing running signs as nothing - and an empty signature must not be
// what a stale one degrades to, or every idle pane would look four minutes stuck.
check('finished turn signs empty', staleSignature(busyEvidence('✻ Baked for 7m 57s · done 3:08 PM')), '')

// ------------------------------------------------------------------------ the decision
const base = { busy: true, unchangedMs: STALE_AFTER_MS, tries: 0, sinceNudge: Infinity, allowed: true }
check('unchanged past the threshold, never nudged', dueForRepaint(base), true)

// The refusals are the feature: the expensive mistake is poking a working agent, since a
// full-screen CLI redraws its whole frame on SIGWINCH.
check('a frame not yet stale', dueForRepaint({ ...base, unchangedMs: STALE_AFTER_MS - 1 }), false)
check('a pane that does not read busy', dueForRepaint({ ...base, busy: false }), false)
check('autoFixUi off - do not poke a CLI on my behalf', dueForRepaint({ ...base, allowed: false }), false)
check('nudged a moment ago', dueForRepaint({ ...base, sinceNudge: NUDGE_EVERY_MS - 1 }), false)
check('nudged long enough ago', dueForRepaint({ ...base, sinceNudge: NUDGE_EVERY_MS, tries: 1 }), true)
check('this stretch has had its repaints', dueForRepaint({ ...base, tries: MAX_NUDGES }), false)
check('an hour stale is still capped', dueForRepaint({ ...base, unchangedMs: 3_600_000, tries: MAX_NUDGES }), false)

// The CONTROL, end to end: a real turn that runs for twenty minutes, its counter ticking
// once a second. Nothing here may ever be nudged - the signature resets every read.
let sig = ''
let since = 0
let tries = 0
let nudges = 0
for (let s = 0; s <= 1200; s++) {
  const at = s * 1000
  const now = staleSignature(busyEvidence(`✢ Smooshing… (${s}s · ↓ ${s * 30} tokens)` + status))
  if (now !== sig) {
    sig = now
    since = at
    tries = 0
  }
  if (dueForRepaint({ busy: true, unchangedMs: at - since, tries, sinceNudge: Infinity, allowed: true })) {
    tries++
    nudges++
  }
}
check('a 20-minute live turn is never nudged', nudges, 0)

// ...and the same loop over a frame that never changes asks exactly MAX_NUDGES times.
sig = ''
since = 0
tries = 0
nudges = 0
let last = 0
for (let s = 0; s <= 1200; s++) {
  const at = s * 1000
  const now = staleSignature(busyEvidence(stuck + status))
  if (now !== sig) {
    sig = now
    since = at
    tries = 0
  }
  if (
    dueForRepaint({ busy: true, unchangedMs: at - since, tries, sinceNudge: last ? at - last : Infinity, allowed: true })
  ) {
    tries++
    nudges++
    last = at
  }
}
check('a stuck frame asks for exactly the capped number of repaints', nudges, MAX_NUDGES)

// -------------------------------------------------------------------- source assertions
//
// The rule can be perfect and reach nothing: the wiring lives in a React effect no node
// test can mount, and every one of these lines is a way for it to be silently dead.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
for (const [needle, why] of [
  ['dueForRepaint({', 'the pane actually asks the rule'],
  ['api.redraw(sessionId)', 'and the answer is the SIGWINCH repaint, not a keystroke'],
  ['allowed: autoFixRef.current', 'the user switch reaches it'],
  ['if (mirrorRef.current) return', 'a mirror still judges nothing - the owning machine repairs its own pane']
]) {
  if (!pane.includes(needle)) {
    bad++
    console.error(`FAIL source: ${why} (${needle})`)
  } else console.log(`ok   source ${why}`)
}

if (bad) {
  console.error(`\n${bad} checks failed. A pane stuck on a frame nobody repaints reads`)
  console.error('as Running for ever; a pane nudged mid-turn costs the CLI a full redraw.')
  process.exit(1)
}
console.log('\nall stale-frame checks passed')
