// Test for "the turn clock stopped ticking mid-turn".
//
// Measured, not guessed. A test copy was driven through a real Claude Code turn over
// CDP (scripts/probe.mjs) and the bottom of the frame was sampled every five seconds.
// Claude Code 2.1.220 never prints "esc to interrupt" any more - its working line is
// "✢ Smooshing… (8s · ↓ 282 tokens)". The old footer regex matched none of it, so no
// pane ever reported busy: 33 of 33 raises in attention-audit.log say sawFooter:false,
// the run clock stopped 4s after the last frame (IDLE_AFTER_MS), and the sidebar sat on
// a frozen "last turn" number while the agent was still working.
//
// Every frame below is a verbatim capture. Add one whenever a CLI changes its footer.
//
//   node scripts/busy-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-busy-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'busy.bundle.cjs')
// esbuild's JS shim, not `npx esbuild`: Node 24 refuses to spawn a .cmd without a shell.
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/shared/busy.ts',
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${out}`
  ],
  { cwd: root, stdio: 'pipe' }
)
const { readsBusy } = createRequire(import.meta.url)(out)

/** The statusline and input box that sit BELOW the working line on this machine. */
const CHROME = [
  '────────────────────────────────────────────────────────────',
  '❯',
  '────────────────────────────────────────────────────────────',
  '  [CAVEMAN] ◆ Opus 5 (1M context) | claude-orchestrator-c |  lane-c | ⟳ 68↑ | ░░░░░░░░░░ 0% | +0/-0',
  '  5h 48% · wk 69% · Fable 10%',
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents'
].join('\n')

const cases = [
  // Claude Code 2.1.220, mid-turn. Both shapes were on screen during the same turn.
  ['claude 2.1 spinner with counter', '✢ Smooshing… (8s · ↓ 282 tokens)\n' + CHROME, true],
  ['claude 2.1 spinner, no counter yet', '✶ Cultivating…\n' + CHROME, true],
  ['claude 2.1 spinner under tool output', '● Bash(sleep 25; echo done)\n⎿  Running in the background (↓ to manage)\n✻ Herding…\n' + CHROME, true],
  // Older Claude Code and Codex, which still say how to stop themselves.
  ['legacy esc-to-interrupt', '✻ Thinking… (esc to interrupt)\n' + CHROME, true],
  ['codex footer', 'Esc to interrupt · 12s\n' + CHROME, true],
  // The same line in the past tense is how Claude Code reports a turn that ENDED.
  ['finished turn summary', '✻ Sautéed for 10s · 1 shell still running\n' + CHROME, false],
  ['idle pane', '▝▜█████▛▘  Opus 5 (1M context) with high effort · Claude Max\n' + CHROME, false],
  // A markdown list in an answer sits in exactly these rows.
  ['bullet list in an answer', '* one of the things we tried…\n- and another…\n' + CHROME, false],
  // A question outranks a spinner: the CLI is mid-turn but nothing moves until you answer.
  ['permission prompt over a spinner', '✢ Smooshing… (8s · ↓ 282 tokens)\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n', false]
]

let bad = 0
for (const [name, frame, want] of cases) {
  const got = readsBusy(frame)
  if (got !== want) {
    bad++
    console.error(`FAIL ${name}: readsBusy = ${got}, expected ${want}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

if (bad) {
  console.error(`\n${bad} of ${cases.length} frames read wrong. A pane that cannot see its`)
  console.error('agent working freezes the turn clock and rings the bell mid-turn.')
  process.exit(1)
}
console.log(`\nall ${cases.length} frames read correctly`)
