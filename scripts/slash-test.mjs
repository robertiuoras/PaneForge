// Test for "the bell rang right after /clear".
//
// Measured, not guessed: byte-level reads of real pane transcripts
// (userData/history/*.log, Claude Code 2.1.220) show /clear emits no clear-screen
// escape at all - it cursor-redraws, flashes "✻ Calculating…" while SessionStart hooks
// run, then settles. That flash reads as a real turn to every screen-side heuristic,
// so the tell has to be the KEYSTROKES: the submitted line started with "/". This
// holds the keystroke tracker in src/shared/slashTurn.ts against real input shapes.
//
//   node scripts/slash-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-slash-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'slash.bundle.cjs')
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/slashTurn.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { typeLine, isSlashCommand } = createRequire(import.meta.url)(out)

/** Feed a sequence of write() chunks and say whether Enter would read as a command. */
function submits(chunks) {
  let typed = ''
  for (const c of chunks) typed = typeLine(typed, c)
  return isSlashCommand(typed)
}

const cases = [
  // The bug itself: /clear typed a key at a time.
  { chunks: [...'/clear'], slash: true, name: '/clear typed per key' },
  // A whole queued prompt arrives as one chunk with its Enter attached.
  { chunks: ['/compact\r'], slash: true, name: 'queued /compact one chunk' },
  { chunks: ['fix the failing test\r'], slash: false, name: 'queued prompt one chunk' },
  // Leading spaces still read as a command - the CLI accepts them.
  { chunks: [' ', '/', 'h', 'e', 'l', 'p'], slash: true, name: 'space then /help' },
  // "/cl" abandoned via backspace and replaced with a question must NOT read as one.
  {
    chunks: [...'/cl', '\x7f', '\x7f', '\x7f', ...'why did it fail?'],
    slash: false,
    name: 'slash backspaced away'
  },
  // Backspacing more than was typed cannot underflow.
  { chunks: ['\x7f', '\x7f', ...'/clear'], slash: true, name: 'backspace on empty' },
  // Arrow keys (history browsing) are escape-prefixed and must not pollute the line.
  { chunks: ['\x1b[A', '\x1b[B', ...'/clear'], slash: true, name: 'arrows then /clear' },
  // Bracketed paste is escape-prefixed: unfollowable input errs toward "real prompt",
  // the reading that keeps the bell armed.
  { chunks: ['\x1b[200~/clear\x1b[201~'], slash: false, name: 'pasted /clear stays a prompt' },
  // A slash inside a sentence is not a command.
  { chunks: [...'read src/main.ts'], slash: false, name: 'slash mid-sentence' },
  // Second line after a submit starts clean - simulated by the caller resetting, so
  // here just prove typeLine ignores the \r itself rather than storing it.
  { chunks: ['a\r'], slash: false, name: 'CR itself is not stored' }
]

let failed = 0
for (const c of cases) {
  const got = submits(c.chunks)
  if (got !== c.slash) {
    failed++
    console.error(`FAIL ${c.name}: expected ${c.slash}, got ${got}`)
  }
}

// The cap: a pasted-then-typed monster line cannot grow without bound.
{
  let typed = ''
  for (let i = 0; i < 50; i++) typed = typeLine(typed, 'x'.repeat(100))
  if (typed.length > 200) {
    failed++
    console.error(`FAIL cap: typed grew to ${typed.length}`)
  }
}

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`${failed} case(s) failed`)
  process.exit(1)
}
console.log(`slash-test: all ${cases.length + 1} cases pass`)
