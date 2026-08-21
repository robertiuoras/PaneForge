// Reading a CLI's input box off the drawn text.
//
// Everything this file decides ends up as arrow keys in somebody's pty, and the dangerous
// direction is a FALSE POSITIVE: say a plain shell's line is part of an input box and a
// bare click may send an up-arrow, which in a shell recalls the previous command instead
// of moving. So the rows below are real screens - Claude Code's box, Codex's, a bare zsh
// prompt, a git diff, a markdown table - and the shell cases are the load-bearing ones.
//
// No terminal: it is string arithmetic. `node scripts/prompt-box-test.mjs`

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-prompt-box-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'box.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/promptBox.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { boxedRow, composerAt, frameAt, sameBox, inputStart, inputEnd, leadingBlanks, promptTop } = createRequire(import.meta.url)(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// Real rows, spaces and all.
const CC_TOP = '╭──────────────────────────────────────────────────╮'
const CC_FIRST = '│ > fix the badge on the sidebar card              │'
const CC_SECOND = '│   and then run the tests                        │'
const CC_BOTTOM = '╰──────────────────────────────────────────────────╯'
const ZSH = 'robert@mac PaneForge % npm run build'
const BASH = '$ git status'
const DIFF = '+++ b/src/shared/promptBox.ts'
const TABLE = '| command | what it covers |'
const BLANK = '   '

// --- what is a box, and what only looks like one ----------------------------------
check('a CLI input row is boxed', boxedRow(CC_FIRST))
check('its continuation row is boxed', boxedRow(CC_SECOND))
check('a zsh prompt is not', !boxedRow(ZSH))
check('a bash prompt is not', !boxedRow(BASH))
check('a diff header is not', !boxedRow(DIFF))
// The one that would be a real misfire: a markdown table on screen is not an input box,
// and an ASCII pipe is far too common to be treated as a frame.
check('a markdown table row is not', !boxedRow(TABLE))
check('a blank row is not', !boxedRow(BLANK))
// The corners are drawn with different glyphs, and they are not rows you type on.
check('the top of the frame is not a typing row', !boxedRow(CC_TOP))
check('nor the bottom', !boxedRow(CC_BOTTOM))

eq('the frame is at column 0', frameAt(CC_FIRST), 0)
eq('an unframed row answers -1', frameAt(ZSH), -1)

// --- one box, or two different things ----------------------------------------------
check('two rows of one box belong together', sameBox(CC_FIRST, CC_SECOND))
check('a box row and a shell row do not', !sameBox(CC_FIRST, ZSH))
check('two shell rows do not either', !sameBox(ZSH, BASH))
check('an indented frame is a different box', !sameBox(CC_FIRST, '  │ something else'))

// --- where the typing starts and stops ---------------------------------------------
eq('past the frame and the prompt marker', inputStart(CC_FIRST), 4)
eq('a continuation row starts after the padding', inputStart(CC_SECOND), 4)
// A shell's prompt is on the same row as what you typed, and it is not yours to select.
eq('a zsh prompt is skipped', inputStart(ZSH), 'robert@mac PaneForge % '.length)
eq('a line with no marker at all starts at 0', inputStart('just some output'), 0)
// The prompt always comes first, so a marker inside the typed text cannot win.
eq('a $ inside the text does not move the start', inputStart('bash-3.2$ echo "a $ b"'), 'bash-3.2$ '.length)
eq('a `$ ` prompt is a marker too', inputStart(BASH), 2)

eq('the end is past the last typed character', inputEnd(CC_FIRST), 4 + 'fix the badge on the sidebar card'.length)
eq('the box’s right rule is not part of what you typed', inputEnd(CC_SECOND), 4 + 'and then run the tests'.length)
eq('an unframed line ends at its last character', inputEnd(ZSH), ZSH.length)
{
  const empty = '│                    │'
  eq('an empty box row has nothing in it', inputEnd(empty) - inputStart(empty), 0)
  const marker = '│ >                  │'
  eq('nor does one drawn with a prompt marker', inputEnd(marker) - inputStart(marker), 0)
}

// The two together are what a select-all sends, so they may never cross.
for (const row of [CC_FIRST, CC_SECOND, ZSH, BASH, '│ >                  │']) {
  check(`start never runs past end (${JSON.stringify(row.slice(0, 12))})`, inputStart(row) <= inputEnd(row) || inputEnd(row) === 0)
}

// --- where the composer starts, walking up from the cursor -------------------------
//
// Rows as they really were on screen at submit time, read straight out of live panes over
// CDP (Codex v0.146.0, Claude Code v2.1.232). rows[0] is the cursor's own row and rows[N]
// is N rows above it.
{
  // Claude Code: the composer IS a rule directly above what you typed.
  const claude = [
    '❯ say the word blue',
    '──────────────────────────────────────────────────',
    '',
    '',
    '▘▘ ▝▝    ~/Projects/PaneForge'
  ]
  eq('Claude Code’s composer is one row up', promptTop(claude), 1)

  // A prompt long enough to wrap onto several rows still tags its FIRST row.
  const long = [
    '  and then run the tests',
    '❯ fix the badge on the sidebar card',
    '──────────────────────────────────────────────────',
    'some earlier output'
  ]
  eq('a multi-row draft tags the top of itself', promptTop(long), 2)

  // Codex draws no rule above its prompt at all. The nearest box-drawing line is the
  // BOTTOM of the startup banner, six rows up with a tip and two blanks in between -
  // anchoring there put the tag on the banner, and on line 0 it was dropped outright.
  const codex = [
    '› say the word blue',
    '',
    '',
    'inference with increased plan usage.',
    'Tip: New Use /fast to enable our fastest',
    '',
    '╰────────────────────────────────────────────────╯',
    '│ permissions: YOLO mode                         │',
    '│ directory:   ~/Projects/PaneForge              │',
    '╭────────────────────────────────────────────────╮'
  ]
  eq('Codex tags the row the prompt is on', promptTop(codex), 0)

  // Each half of that refusal on its own, so a change that drops one still fails.
  eq(
    'a closed box above the composer stops the walk',
    promptTop(['› typed', '╰──────────────────╯', '╭──────────────────╮']),
    0
  )
  eq('two blank rows are the gap below the transcript', promptTop(['› typed', '', '', '─────────────────────']), 0)
  eq('a shell, which draws no composer at all', promptTop([BASH, 'total 24', 'drwxr-xr-x  4 robert']), 0)
  // The bound the caller passes is the last prompt's line: a tag can never be anchored
  // above the prompt that was sent before it.
  eq('the walk is bounded by the caller', promptTop(claude, 0), 0)
}

// --- the composer a CLI draws with no frame at all --------------------------------
//
// Every row here is off a live Claude Code 2.1.x pane at 157 columns (the same capture
// the numbers in `InputRow` came from). It draws a rule, `❯ what you typed` with each
// further row indented two spaces, then another rule - no vertical rules anywhere, and
// xterm calls neither row wrapped. So both tests the pane had said "these rows are
// unrelated", and a selection across them deleted one character.
{
  const RULE = '\u2500'.repeat(157)
  const rows = [
    'somewhere in the transcript',
    '',
    RULE,
    '\u276f alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike',
    '  november oscar papa quebec romeo sierra tango uniform victor whiskey xray',
    RULE,
    '  [CAVEMAN] \u25c6 Opus 5 | probe-repo'
  ]
  const read = (r) => rows[r] ?? ''
  const found = composerAt(read, 4)
  check('the frameless composer is found from its last row', !!found)
  eq('and it starts on the row carrying the marker', found?.top, 3)
  eq('and ends on the row above the closing rule', found?.bottom, 4)
  eq('and its width is the rule it is drawn between', found?.width, 157)
  eq('the same answer from the first row of it', composerAt(read, 3)?.bottom, 4)

  // The refusals, which are the half worth pinning: this decides whether a burst of
  // backspaces is sent, so anything it claims wrongly is somebody's typing destroyed.
  const no = (what, list, at) => check(what, composerAt((r) => list[r] ?? '', at) === null)
  no('a paragraph between two rules is not a composer - it carries no prompt marker',
    [RULE, 'a sentence of an answer, sitting between two rules', RULE], 1)
  no('a closing corner above means the box belongs to something else',
    ['\u2570' + '\u2500'.repeat(20) + '\u256f', '\u276f typed', RULE], 1)
  no('two blank rows are the gap below the transcript', ['', '', '\u276f typed', RULE], 2)
  no('a rule of another width below closes something else',
    [RULE, '\u276f typed', '\u2500'.repeat(40)], 1)
  no('nothing below at all - the composer has no bottom', [RULE, '\u276f typed'], 1)
  no('a shell, which draws no composer at all', [BASH, 'total 24', 'drwxr-xr-x 4 robert'], 1)

  // THE character that broke this, kept as its own case: Claude Code draws its marker
  // followed by U+00A0, not by a space. It is drawn identically, it prints identically in
  // any log, and testing for `' '` alone made `inputStart` answer 0 on the prompt row -
  // which highlighted the CLI's own marker on a select-all and made the composer
  // unfindable, so every multi-row delete was refused. Rows copied off a live pane.
  const NB = '\u00a0'
  const real = [RULE, '\u276f' + NB + 'alpha bravo charlie', '  yankee zulu one two', RULE]
  const readReal = (r) => real[r] ?? ''
  eq('the marker is followed by a non-breaking space, and still starts the text at 2', inputStart(real[1]), 2)
  eq('a composer drawn that way is found', composerAt(readReal, 2)?.top, 1)
  eq('and it ends above its closing rule', composerAt(readReal, 2)?.bottom, 2)
  eq('the indent of a continuation row is measured the same way', leadingBlanks(real[2]), 2)
  eq('a non-breaking space at the end of a row is trailing blank too', inputEnd('typed' + NB + NB), 5)

  // A framed CLI still answers through `sameBox`, unchanged.
  const boxed = ['\u256d' + '\u2500'.repeat(20) + '\u256e', '\u2502 > first line       \u2502', '\u2502   second line      \u2502', '\u2570' + '\u2500'.repeat(20) + '\u256f']
  const box = composerAt((r) => boxed[r] ?? '', 2)
  eq('a framed composer starts at its first framed row', box?.top, 1)
  eq('and ends at its last', box?.bottom, 2)
}

console.log(`prompt box: ${checks} checks passed`)
