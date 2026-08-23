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
const { typeLine, isSlashCommand, isQuietSlash, clearsConversation } =
  createRequire(import.meta.url)(out)

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

// Which commands end with nothing to read, and so are never promoted to a bell however
// long they run. The 30-second promotion is what rang over a /clear whose SessionStart
// hooks were slow - "it pings when I clear the session".
const quiet = [
  { line: '/clear', quiet: true },
  { line: '/compact', quiet: true },
  { line: '/resume', quiet: true },
  { line: ' /clear', quiet: true, name: 'leading space' },
  { line: '/clear ', quiet: true, name: 'trailing space' },
  { line: '/compact keep the test plan', quiet: true, name: 'with an argument' },
  // A longer command that merely STARTS with one of the words is a different command,
  // and one of them is real work: \b is what keeps them apart.
  { line: '/clearance', quiet: false },
  { line: '/resumes-the-thing', quiet: false },
  // Everything else keeps the existing behaviour - denied for 30s, then promoted.
  { line: '/help', quiet: false },
  { line: '/model opus', quiet: false },
  { line: '/forge build the thing', quiet: false },
  // Not a command at all.
  { line: 'clear the failing test', quiet: false },
  { line: 'read src/main.ts', quiet: false }
]
for (const c of quiet) {
  const got = isQuietSlash(c.line)
  if (got !== c.quiet) {
    failed++
    console.error(`FAIL quiet ${c.name ?? c.line}: expected ${c.quiet}, got ${got}`)
  }
}

// Which submitted line puts the pane back to Ready.
//
// The narrow half of `isQuietSlash`: /compact rewrites the conversation the pane is
// still in and /resume swaps another one in, and neither leaves a pane with nothing
// to read. Only /clear does, and only /clear un-asks the pane in sessions.ts - which
// is what stops "Ready" from being a bag of panes that merely happened never to be
// typed into.
const clears = [
  { line: '/clear', want: true },
  { line: ' /clear ', want: true, name: 'padded' },
  { line: '/CLEAR', want: true, name: 'shouted' },
  // Picked out of the CLI's own completion menu: what was typed is not what was sent.
  { line: '/cl', want: true },
  { line: '/cle', want: true },
  { line: '/clea', want: true },
  // Ambiguous prefixes are left alone - /c is also /compact, /config, /cost.
  { line: '/c', want: false },
  { line: '/co', want: false },
  // The other two quiet commands keep their conversation, so they keep the pane's state.
  { line: '/compact', want: false },
  { line: '/resume', want: false },
  // A longer word that merely starts with it is a different command.
  { line: '/clearance', want: false },
  { line: '/clean-up-the-tests', want: false },
  // Not a command at all.
  { line: 'clear the failing test', want: false },
  { line: '', want: false }
]
for (const c of clears) {
  const got = clearsConversation(c.line)
  if (got !== c.want) {
    failed++
    console.error(`FAIL clears ${c.name ?? c.line}: expected ${c.want}, got ${got}`)
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
console.log(`slash-test: all ${cases.length + quiet.length + clears.length + 1} cases pass`)
