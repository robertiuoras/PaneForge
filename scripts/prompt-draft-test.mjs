// The one draft reconstruction, held against real keystroke shapes.
//
// Three things used to reconstruct what a pane was typing - the scroll rail's feedInput,
// slashTurn.typeLine and laneWork.trackTyped - and giving one of them a new case never
// gave it to the other two. `shared/draft.ts` is now the only loop; this pins it, and
// `test:slash` / `test:lanework` / `test:rail` prove the callers still answer the same.
//
//   node scripts/prompt-draft-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-draft-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'draft.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/draft.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { feedDraft, newDraft, flatDraft, looksFinished, looksSplittable, LANE_OPTIONS, SLASH_OPTIONS } =
  createRequire(import.meta.url)(out)

const ESC = String.fromCharCode(27)
let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

/** Feed chunks through the full-draft preset and hand back the final state + submissions. */
function feed(chunks, options) {
  let state = newDraft()
  const submitted = []
  for (const c of chunks) {
    const r = feedDraft(state, c, options)
    state = r.state
    submitted.push(...r.submitted)
  }
  return { ...state, submitted }
}

// --- typing, backspacing, killing -----------------------------------------

check('a line typed a key at a time', feed([...'fix the login bug']).text === 'fix the login bug')
check('backspace erases', feed([...'abcd', '\x7f', '\x7f']).text === 'ab')
check('backspace on empty cannot underflow', feed(['\x7f', '\x7f', ...'ab']).text === 'ab')
check('Ctrl-U throws the line away', feed([...'abc', '\x15', ...'de']).text === 'de')
check('Ctrl-C throws the line away', feed([...'abc', '\x03', ...'de']).text === 'de')
check('Ctrl-W kills one word', feed([...'add a login page', '\x17']).text === 'add a login')
check('Enter submits and clears', (() => {
  const r = feed([...'hello', '\r', ...'world'])
  return r.submitted.length === 1 && r.submitted[0] === 'hello' && r.text === 'world'
})())
check('two lines in one chunk are both reported', feed(['a\rb\r']).submitted.length === 2)

// --- escapes: the case that broke this once --------------------------------

check(
  'a focus report is not typing',
  feed([ESC + '[O', ...'/clear']).text === '/clear',
  'ESC [ O once made every line after a focus change start "[O"'
)
check('a focus-in report is not typing either', feed([ESC + '[I', ...'ab']).text === 'ab')
check('focus report mid-line is ignored', feed([...'ab', ESC + '[O', ...'cd']).text === 'abcd')
check('an arrow key adds nothing', feed([...'ab', ESC + '[A']).text === 'ab')
check('an application-mode arrow adds nothing', feed([...'ab', ESC + 'OA']).text === 'ab')
check('a title sequence adds nothing', feed([ESC + ']0;a title\x07', ...'ab']).text === 'ab')
check('a bare Escape abandons the line', feed([...'abc', ESC]).text === '')

// An arrow key is history recall or a mid-line edit, and neither can be followed.
check('an arrow makes the draft uncertain', feed([...'abc', ESC + '[A']).certain === false)
check('a focus report does NOT make it uncertain', feed([...'abc', ESC + '[O']).certain === true)
check('Tab makes it uncertain (the CLI completes into the box)', feed([...'src/', '\t']).certain === false)
check('Enter makes it certain again', feed([...'a', ESC + '[A', '\r', ...'b']).certain === true)

// --- bracketed paste -------------------------------------------------------

check(
  'a paste in one chunk is captured',
  feed([ESC + '[200~pasted text' + ESC + '[201~']).text === 'pasted text'
)
check(
  'a paste split across chunks is captured',
  feed([ESC + '[200~pasted ', 'and more', ESC + '[201~']).text === 'pasted and more'
)
check(
  'newlines inside a paste do not submit',
  (() => {
    const r = feed([ESC + '[200~line one\nline two' + ESC + '[201~'])
    return r.submitted.length === 0 && r.text === 'line one\nline two'
  })()
)
check(
  'CRLF inside a paste becomes one newline',
  feed([ESC + '[200~a\r\nb' + ESC + '[201~']).text === 'a\nb'
)
check(
  'typing continues after a paste',
  feed([ESC + '[200~abc' + ESC + '[201~', ...' def']).text === 'abc def'
)
// Alt+Enter / Shift+Enter is how these CLIs put a newline in the box without sending.
check('alt-enter adds a newline instead of submitting', (() => {
  const r = feed([...'one', ESC + '\r', ...'two'])
  return r.submitted.length === 0 && r.text === 'one\ntwo'
})())

// --- caps ------------------------------------------------------------------

check('the draft cannot grow without bound', feed([...Array(200).fill('x'.repeat(100))]).text.length <= 8000)
check('the lane preset keeps only the tail', feed(['x'.repeat(5000)], LANE_OPTIONS).text.length === 32)
check(
  'the slash preset skips escape-prefixed chunks whole',
  feed([ESC + '[200~/clear' + ESC + '[201~'], SLASH_OPTIONS).text === ''
)
check(
  'the slash preset keeps the line through Enter',
  feed(['/compact\r'], SLASH_OPTIONS).text === '/compact',
  'its caller reads isSlashCommand AFTER feeding the chunk, then clears'
)

// --- flatDraft and looksFinished -------------------------------------------

check('flatDraft joins lines', flatDraft('a\n\nb') === 'a b')
check('flatDraft caps', flatDraft('x'.repeat(900), 400).length === 400)

check('a short draft is not offered', looksFinished('fix it') === false)
check(
  'a finished sentence is offered',
  looksFinished('the login form is broken on mobile, can you look at it?') === true
)
check(
  'a sentence still being typed is not offered',
  looksFinished('the login form is broken on mobile and') === false
)
check('a trailing comma is not finished', looksFinished('add a signup page, a login page,') === false)
check('a slash command is never offered', looksFinished('/clear the context and start again') === false)
check('a bang line is never offered', looksFinished('!npm run build and then tell me what broke') === false)

// --- looksSplittable --------------------------------------------------------
//
// The chip this gates opens a dialog that starts a real CLI plan, so a false yes costs a
// minute of somebody's attention. It is meant to say no to almost everything.

check(
  'one job is not a split',
  looksSplittable(
    'the login form is broken on mobile - the submit button sits under the keyboard and the ' +
      'error text is cut off, so nobody can see what went wrong on a small screen.'
  ) === false
)
check(
  'three bullets, each a job, is a split',
  looksSplittable(
    [
      'a few things for the dashboard, whenever you get to them:',
      '- add offer replies with a test',
      '- fix the avatar upload on safari',
      '- move the billing page onto the new table'
    ].join('\n')
  ) === true
)
check(
  'three bullets that are notes, not jobs, is not a split',
  looksSplittable(
    [
      'what I know about the slowness so far, before anyone starts on it:',
      '- it is slow on mobile',
      '- only on safari',
      '- since last tuesday'
    ].join('\n')
  ) === false
)
check(
  'three jobs in prose is a split',
  looksSplittable(
    'add offer replies to the dashboard and then fix the avatar upload on safari, ' +
      'plus migrate the billing page onto the new table when you get a chance.'
  ) === true
)
check('a short list is not a split', looksSplittable('add a login page and fix the header') === false)
check(
  'a draft still being typed is never a split',
  looksSplittable(
    'add offer replies to the dashboard and fix the avatar upload on safari and migrate the billing and'
  ) === false
)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failing` : '\nall good')
process.exit(failed ? 1 : 0)
