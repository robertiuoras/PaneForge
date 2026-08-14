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
const { boxedRow, frameAt, sameBox, inputStart, inputEnd, promptTop } = createRequire(import.meta.url)(outfile)

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

console.log(`prompt box: ${checks} checks passed`)
