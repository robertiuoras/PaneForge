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
const { feedDraft, newDraft, flatDraft, looksFinished, looksSplittable, composerWipe, enterContinues, LANE_OPTIONS, SLASH_OPTIONS } =
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
// --- a paste that never announced itself -----------------------------------
// One pasted web page filed 64 prompts in half a second (prompt archive,
// 2026-09-18T14:36:23Z), so that pane's rail drew 64 tags for one ask. Nobody presses
// Enter twice inside one chunk of keystrokes, so those newlines are content.
check('two lines in one chunk are ONE paste', (() => {
  const r = feed(['a\rb\r'])
  return r.submitted.length === 1 && r.submitted[0] === 'a\nb'
})())
check('a pasted page is one prompt', (() => {
  const page = ['Skip to main content', 'Private ruling application form', 'Last updated 2024']
  const r = feed([page.join('\r') + '\r'])
  return r.submitted.length === 1 && r.submitted[0] === page.join('\n')
})())
check('a paste with no trailing Enter waits for one', (() => {
  const r = feed(['one\rtwo\rthree'])
  return r.submitted.length === 0 && r.text === 'one\ntwo\nthree'
})())
check('windows newlines in a paste are one break each', (() => {
  const r = feed(['one\r\ntwo\r\n'])
  return r.submitted.length === 1 && r.submitted[0] === 'one\ntwo'
})())
check('a bracketed paste is unchanged', (() => {
  const r = feed([ESC + '[200~one\rtwo' + ESC + '[201~', '\r'])
  return r.submitted.length === 1 && r.submitted[0] === 'one\ntwo'
})())
check('an ordinary Enter still submits on its own', feed([...'hello', '\r']).submitted.length === 1)

// --- backslash + Enter: Claude Code's new line --------------------------------

// Claude Code turns a `\` typed right before Enter into a new line and sends nothing; Codex
// 0.155.1 sends the line, backslash and all. So the rule is the caller's to switch on.
const CLAUDE = { backslashNewline: true }
{
  const r = feed([...'first line \\', '\r'], CLAUDE)
  check('backslash + Enter sends nothing', r.submitted.length === 0, JSON.stringify(r.submitted))
  check('...and leaves a new line where the backslash was', r.text === 'first line \n', JSON.stringify(r.text))
  const one = feedDraft({ text: 'first line \\', certain: true, inPaste: false }, '\r', CLAUDE)
  check('...and says the Enter made a new line', one.continued === true && one.submitted.length === 0)
}
{
  const r = feed([...'first line \\', '\r', ...'second line', '\r'], CLAUDE)
  check(
    'the next plain Enter sends both lines once',
    r.submitted.length === 1 && r.submitted[0] === 'first line \nsecond line',
    JSON.stringify(r.submitted)
  )
  check('a plain Enter is not a new line', feedDraft(newDraft(), 'x\r', CLAUDE).continued === false)
  check('enterContinues reads the same rule', enterContinues({ text: 'a\\', certain: true, inPaste: false }) && !enterContinues({ text: 'a\\', certain: true, inPaste: false, folded: true }))
}
check(
  'without the option a backslash + Enter still sends (Codex)',
  (() => {
    const r = feed([...'fix it\\', '\r'])
    return r.submitted.length === 1 && r.submitted[0] === 'fix it\\'
  })()
)
// Measured on Claude Code v2.1.280: a short paste ending in `\` + Enter is a new line like a
// typed one; a paste it folds into "[Pasted text #1]" (over 800 characters, or four lines)
// sends, backslash and all.
{
  const r = feed([ESC + '[200~C:\\Users\\me\\' + ESC + '[201~', '\r'], CLAUDE)
  check('a short pasted path ending in a backslash is a new line too', r.submitted.length === 0 && r.text === 'C:\\Users\\me\n', JSON.stringify(r))
}
{
  const long = 'x'.repeat(800) + '\\'
  const r = feed([ESC + '[200~' + long + ESC + '[201~', '\r'], CLAUDE)
  check('a folded paste (801 characters) sends, its backslash untouched', r.submitted.length === 1 && r.submitted[0] === long, JSON.stringify(r.submitted.map((l) => l.length)))
  const r800 = feed([ESC + '[200~' + 'x'.repeat(799) + '\\' + ESC + '[201~', '\r'], CLAUDE)
  check('...but 800 characters is not folded', r800.submitted.length === 0)
}
{
  const four = feed([ESC + '[200~a\rb\rc\rd\\' + ESC + '[201~', '\r'], CLAUDE)
  check('a four-line paste is folded and sends', four.submitted.length === 1 && four.submitted[0] === 'a\nb\nc\nd\\', JSON.stringify(four.submitted))
  const three = feed([ESC + '[200~a\nb\nc\\' + ESC + '[201~', '\r'], CLAUDE)
  check('...a three-line one is not', three.submitted.length === 0 && three.text === 'a\nb\nc\n', JSON.stringify(three))
}
check(
  'a typed backslash after a folded paste is still a new line',
  feed([ESC + '[200~' + 'y'.repeat(900) + ESC + '[201~', ' \\', '\r'], CLAUDE).submitted.length === 0
)
check('backslash then a space sends (the backslash must be last)', feed([...'typed \\ ', '\r'], CLAUDE).submitted.length === 1)
check('after an arrow key the rule stays out of it', feed([...'abc\\', ESC + '[D', '\r'], CLAUDE).submitted.length === 1)

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

// --- emptying the box: composerWipe ------------------------------------------
// Moved out of App's /clear button so the expand card empties the box the same way before
// its brief goes in. One round (Ctrl-K, Ctrl-U, Backspace) per line of the draft plus two,
// never fewer than four, never more than 24 - the numbers the /clear button shipped with.

const ROUND = '\x0b\x15\x7f'
const rounds = (w) => (w.length % ROUND.length === 0 && w === ROUND.repeat(w.length / ROUND.length) ? w.length / ROUND.length : -1)
check('no draft known gets the flat four rounds', rounds(composerWipe(undefined)) === 4)
check('a one-line draft gets four rounds', rounds(composerWipe({ text: 'fix the login bug', certain: true, inPaste: false })) === 4)
check(
  'a five-line draft gets a round per line and two over',
  rounds(composerWipe({ text: 'a\nb\nc\nd\ne', certain: true, inPaste: false })) === 7
)
check(
  'a draft the reconstruction lost track of gets the flat budget, not its line count',
  rounds(composerWipe({ text: 'a\nb\nc\nd\ne', certain: false, inPaste: false })) === 4
)
check(
  'a forty-line draft is capped at 24 rounds',
  rounds(composerWipe({ text: Array(40).fill('x').join('\n'), certain: true, inPaste: false })) === 24
)
{
  // The wipe is fed into the reconstruction as well as the pty. It must read as an empty,
  // certain box - and must never count as a submitted line.
  const typed = feed([...'a long rough prompt about the rail', '\x1b\r', ...'and a second line'])
  const r = feedDraft({ text: typed.text, certain: typed.certain, inPaste: false }, composerWipe(typed))
  check('the wipe empties the reconstructed draft', r.state.text === '' && r.state.certain === true, JSON.stringify(r.state))
  check('...and submits nothing', r.submitted.length === 0)
}

// A stale unsent-draft flag, checked against the screen. `certain` goes false on any arrow,
// Home/End or Alt chord and only Enter, Ctrl-C or Ctrl-U reset it, so a draft cleared any
// other way held its pane open for good: s42 on 1 Oct, finished 11:53pm Thu, the flag held
// its auto-close until Robert came back at 1:13am Fri.
{
  const { draftRecheckDue } = createRequire(import.meta.url)(out)
  const T = 1_800_000_000_000
  const pane = (over = {}) => ({ drafting: true, status: 'idle', agent: 'claude', lastKeyboard: T - 61_000, ...over })
  check('a minute-old draft flag on an idle pane is rechecked', draftRecheckDue(pane(), 0, T) === true)
  check('...not while somebody typed in the last minute', draftRecheckDue(pane({ lastKeyboard: T - 59_000 }), 0, T) === false)
  check('...not twice in 30 s', draftRecheckDue(pane(), T - 29_000, T) === false && draftRecheckDue(pane(), T - 30_000, T) === true)
  check('...not mid-turn', draftRecheckDue(pane({ runSince: T - 5000 }), 0, T) === false && draftRecheckDue(pane({ status: 'working' }), 0, T) === false)
  check('...not a shell', draftRecheckDue(pane({ agent: 'shell' }), 0, T) === false)
  check('...not without a flag', draftRecheckDue(pane({ drafting: undefined }), 0, T) === false)
}

// The recheck itself: the real `recheckDraft` out of sessions.ts, on the real composer read,
// with s42's own parked-caret screen (`scripts/fixtures/claude-hint-parked-caret.bin`).
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const source = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const from = source.indexOf('  private async recheckDraft(')
  const to = source.indexOf('  private async confirmDraft(', from)
  check('sessions.ts has a recheckDraft method', from >= 0 && to > from)
  check('...and sweepIdle calls it when draftRecheckDue says so, never under a hold', /!live\.draftConfirmation && !this\.promptInFlight\(live\) && draftRecheckDue\([^)]*\)[^\n]*\n?[^\n]*this\.recheckDraft\(live\)/.test(source))
  if (from >= 0 && to > from) {
    const harness = join(work, 'recheck.ts')
    writeFileSync(harness, `
import { composerOf } from ${JSON.stringify(join(root, 'src/main/composerRead.ts'))}
import { newDraft } from ${JSON.stringify(join(root, 'src/shared/draft.ts'))}
export const logs: string[] = []
const acLog = (s: string) => { logs.push(s) }
export class Harness {
  sessions = new Map<string, any>(); emitted = 0
  emitSessions() { this.emitted++ }
  promptInFlight(live: any) { return Boolean(live.inFlight) }
${source.slice(from, to)}
}
`)
    const bundled = join(work, 'recheck.cjs')
    buildSync({ absWorkingDir: root, entryPoints: [harness], bundle: true, format: 'cjs', platform: 'node', outfile: bundled, logLevel: 'silent' })
    const { Harness, logs } = createRequire(import.meta.url)(bundled)
    const parked = readFileSync(join(root, 'scripts/fixtures/claude-hint-parked-caret.bin'), 'utf8')
    const NB = String.fromCharCode(0xa0)
    const typedBox = `${'─'.repeat(60)}\r\n❯${NB}half a prompt\r\n${'─'.repeat(60)}\r\n${ESC}[2;16H`
    const run = async (raw, during) => {
      const h = new Harness()
      const live = {
        meta: { id: 'p1', agent: 'claude', drafting: true, lastKeyboard: 1 }, typed: 'gone', paintSeq: 5,
        draft: { text: 'gone', certain: false, inPaste: false }, draftConfirmation: undefined,
        cols: raw === parked ? 134 : 60, rows: raw === parked ? 53 : 12,
        buffer: { read: () => { during?.(live); return raw } }
      }
      h.sessions.set('p1', live)
      await h.recheckDraft(live)
      return { h, live }
    }
    let r = await run(parked)
    check('s42: an empty box on screen clears the stale flag', r.live.meta.drafting === undefined && r.live.draft.certain === true && r.live.draft.text === '' && r.live.typed === '', JSON.stringify(r.live.meta))
    check('...tells the window', r.h.emitted === 1)
    check('...and says so in the autoclear log', logs.some((l) => /^p1 .*draft/.test(l)), JSON.stringify(logs))
    r = await run(typedBox)
    check('words in the box keep the flag', r.live.meta.drafting === true && r.h.emitted === 0)
    r = await run('')
    check('an unreadable box keeps the flag', r.live.meta.drafting === true)
    r = await run(parked, (l) => { l.paintSeq++ })
    check('a paint during the read keeps the flag', r.live.meta.drafting === true)
    r = await run(parked, (l) => { l.meta.lastKeyboard++ })
    check('a key during the read keeps the flag', r.live.meta.drafting === true)
    r = await run(parked, (l) => { l.draft = { text: 'new', certain: true, inPaste: false } })
    check('a draft changed during the read keeps the flag', r.live.meta.drafting === true)
    r = await run(parked, (l) => { l.draftConfirmation = { prompt: 'x', since: 1, afterPaint: 5 } })
    check('a submission hold set during the read keeps the flag', r.live.meta.drafting === true)
    r = await run(parked, (l) => { l.inFlight = true })
    check('a prompt typed during the read keeps the flag', r.live.meta.drafting === true)
    // s19-muqs9nqa, 2026-10-02 11:03Z: a queued prompt accepted and NOT yet typed waited
    // "behind you" on this very flag over an empty box, and its owed flag kept the recheck off.
    r = await run(parked, (l) => { l.meta.owedPrompt = true })
    check('a prompt owed but still waiting to be typed does not keep the flag', r.live.meta.drafting === undefined, JSON.stringify(r.live.meta))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failing` : '\nall good')
process.exit(failed ? 1 : 0)
