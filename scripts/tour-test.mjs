// The dev-copy tour: turning "what changed" commits into steps you can press through,
// each saying where it is, what to look for, what to type, and which suite proves it.
// No window, no git, no Electron - see src/shared/tour.ts for why that is possible.
//
//   node scripts/tour-test.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  buildSteps, makeTour, currentStep, next, previous, done, surfaceFor, tourAllowed,
  stepFrom, placesFor, trailersOf, firstParagraph, checkAllowed, readCheck, checkName, plainWords, howToCheck,
  dwellFor, waitsForYou, DWELL_CHECKS_MS, DWELL_PLAIN_MS, NO_SCREEN,
  stepKey, nextUnchecked, checkWords, summaryCount, checkedWords, demoFor, titleFor, checkedAll
} = await import(pathToFileURL(join(root, 'src/shared/tour.ts')).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}
// A fixture is a change in the APP unless it says otherwise: `buildSteps` drops a commit
// that touched nothing under `src/`, and every step-list test below is about something
// else. The filter has its own section further down, with its own explicit files.
const c = (subject, body = '', files = ['src/main/index.ts'], scope = '') => ({ subject, body, files, scope })

console.log('an empty list draws nothing')
{
  ok('no commits at all', makeTour([]) === null)
  ok('only blank subjects', makeTour([c(''), c('   ')]) === null)
  ok('blank subjects dropped from a real list', buildSteps([c(''), c('A real sentence'), c('  ')]).length === 1)
}

console.log('a tour only lists changes there is something to look at')
{
  // Measured on the 44 steps Robert was shown 2026-09-04: 14 of them touched nothing under
  // src/ - the test runner, the try script, the tour itself - and a step you cannot go and
  // look at is the whole reason the list read as too long to start.
  const kept = buildSteps([
    c('A change in the app', '', ['src/main/sessions.ts']),
    c('One test run, one temp folder', '', ['scripts/test-all.mjs']),
    c('A dev window says what is different', '', ['scripts/try.mjs', 'scripts/try-diff.mjs']),
    c('A note about the design', '', ['docs/design-notes.md'])
  ])
  ok('the app change is kept', kept.length === 1 && kept[0].text === 'A change in the app', String(kept.length))
  ok('a commit with no files at all is dropped', buildSteps([c('Nothing on disk', '', [])]).length === 0)
  ok('a renderer file counts', buildSteps([c('X', '', ['src/renderer/src/App.tsx'])]).length === 1)
  // A change committed in a lane and again after a merge was drawn twice, and being asked
  // to check the same sentence twice is what makes thirty read as forty.
  const twice = buildSteps([c('The same change'), c('The same change'), c('A different one')])
  ok('the same subject is drawn once', twice.length === 2, twice.map((x) => x.text).join(' | '))
}

console.log('a card carries two points, never a wall of them')
{
  const body = 'See: the first thing\nSee: the second thing\nSee: the third thing'
  ok('three See lines become two bullets', trailersOf(body).see.length === 2)
  ok('and they are the first two', trailersOf(body).see[0] === 'the first thing')
  ok('a repeated line is not a second bullet', trailersOf('See: same\nSee: same').see.length === 1)
}

console.log('the tour holds on a step long enough to read it')
{
  // 3.5s/7s/4s was too short to read the card, let alone look at what it names - Robert,
  // 2026-09-04: "start the tour doesnt work and goes by too quick".
  ok('a plain step is held long enough to read', DWELL_PLAIN_MS >= 8000, String(DWELL_PLAIN_MS))
  ok('a checked step too', DWELL_CHECKS_MS >= 8000, String(DWELL_CHECKS_MS))
  // A step with something to DO on it has no right length at all - it waits.
  ok('a step that opens a surface waits for a person', waitsForYou({ open: 'newSession' }))
  ok('a ringed control waits too', waitsForYou({ open: 'none', spot: '.pane' }))
  ok('a sentence with nothing to do does not', !waitsForYou({ open: 'none' }))
  ok('and the clock does not run on one that waits', dwellFor({ open: 'newSession', checks: [], spot: '.dialog' }, false) === null)
}

console.log('the index clamps at both ends')
{
  const t = makeTour([c('First'), c('Second'), c('Third')], '/repo')
  ok('starts at the first step', t.index === 0)
  ok('carries the checkout root the checks run in', t.root === '/repo')
  ok('previous at the first step stays put', previous(t).index === 0)
  const atEnd = next(next(next(t)))
  ok('next past the last step stops there, never wraps', atEnd.index === 2, String(atEnd.index))
  ok('done is true only at the last step', !done(t) && done(atEnd))
  ok('currentStep tracks the clamped index', currentStep(atEnd).text === 'Third')
}

console.log('a sentence with no known surface gets none')
{
  ok('an unrelated sentence', surfaceFor('The memory column reads faster now') === 'none')
  ok('new session is recognised', surfaceFor('A new session dialog opens where the work can run') === 'newSession')
  ok('settings is recognised', surfaceFor('Settings search finds the setting, not the page') === 'settings')
  ok('the sidebar is recognised', surfaceFor('Hiding the list gives the panes the whole window, not 42px of it') === 'sidebarHidden')
  ok('workspaces is recognised', surfaceFor('A workspace launches every project again') === 'workspaces')
  const t = makeTour([c('Something nobody wrote a keyword for')])
  ok('and it lands on the step as none, not a guess', currentStep(t).open === 'none')
}

console.log('where a change lives comes off the files it touched, in words')
{
  const p = placesFor(['src/renderer/src/components/NewSessionDialog.tsx', 'src/renderer/src/styles.css'])
  ok('a dialog is named and opened', p.where === "the New session dialog and the window's look" && p.open === 'newSession', p.where)
  // Robert, 2026-09-04, reading `the New session dialog, this card, the window's look,
  // inside the app, nothing to click` on one card: too long, and it says both that there
  // is a dialog to look at and that there is nothing to click.
  const many = placesFor([
    'src/renderer/src/components/NewSessionDialog.tsx',
    'src/renderer/src/components/TourCard.tsx',
    'src/renderer/src/styles.css',
    'src/main/tour.ts',
    'src/shared/tour.ts'
  ])
  ok('five places are read as the two nearest', many.where === 'the New session dialog and this card', many.where)
  ok('and a screen never shares the line with "nothing to click"', !/nothing to click/.test(many.where))
  ok('a change with no screen at all still says so', placesFor(['src/main/tour.ts', 'src/shared/tour.ts']).where === 'inside the app, nothing to click')
  ok('and ringed', p.spot === '.dialog')
  ok('a component nobody listed is still named off its own name', placesFor(['src/renderer/src/components/HandoffDialog.tsx']).where === 'the Handoff dialog')
  ok('main-process files say there is nothing to click', placesFor(['src/main/devServers.ts']).where === 'inside the app, nothing to click')
  ok('the try command is not this window', /npm run try/.test(placesFor(['scripts/try.mjs']).where))

// The dev copy exists to be COMPARED with the installed app, and `npm run try -- --show`
// places the pair itself. It lives here because this is the only suite that already knows
// about `try.mjs`, and because the failure is invisible: the placement was on a timer that
// was `unref`'d, nothing else held the loop open, so node exited first and the two windows
// were never placed at all - the copy appeared on screen and looked fine.
{
  const src = readFileSync(join(root, 'scripts/try.mjs'), 'utf8')
  // Only the placement block: the DETACHED electron spawn above it is unref'd on purpose,
  // and `.unref` with the dot so the prose explaining the trap does not match itself.
  const placing = src.slice(src.indexOf('if (!minimized) {'))
  ok('the side-by-side placement is spawned at all', /dev-layout\.mjs/.test(placing))
  ok('and its timer is not unref\'d, or node exits before it fires', !/\.unref/.test(placing))
}
  ok('a test script alone names no place', placesFor(['scripts/devlist-test.mjs']).where === '')
  ok('no file name ever reaches the screen', !/\.(tsx?|css|mjs)\b/.test(placesFor(['src/main/x.ts', 'src/renderer/src/components/Foo.tsx']).where))
  ok('a sentence-matched surface still gets a ring', stepFrom(c('Hiding the list gives the panes the whole window')).spot === '.side-reveal')
  ok('the file table outranks the sentence', stepFrom(c('Settings words in the subject', '', ['src/renderer/src/components/NewSessionDialog.tsx'])).open === 'newSession')
}

console.log('what to look for and what to type come from the commit, never invented')
{
  const body = 'Long story.\n\nSee: the reveal button is 30px\nSee: Save workspace carries a bookmark\nTry: run rm on a scratch file\nTry: ignored second\nCo-Authored-By: x'
  const t = trailersOf(body)
  ok('every See line kept in order', t.see.length === 2 && t.see[1] === 'Save workspace carries a bookmark')
  ok('a Try line is not read at all any more', t.try === undefined)
  const s = stepFrom(c('Subject', body))
  ok('a step carries the See lines and nothing to press', s.see.length === 2 && s.try === undefined)
  const plain = stepFrom(c('Subject', 'First paragraph says why.\nStill first.\n\nSecond paragraph.'))
  ok('no See lines: the first paragraph stands in', plain.see.length === 1 && plain.see[0] === 'First paragraph says why. Still first.', plain.see[0])
  ok('and a step never carries a prompt for a pane', plain.try === undefined)
  ok('an empty body gives an empty list, not a guess', stepFrom(c('Subject')).see.length === 0)
  ok('a first paragraph is capped on a word', firstParagraph('word '.repeat(200)).length <= 320 && /…$/.test(firstParagraph('word '.repeat(200))))
  ok('trailers are not the paragraph', firstParagraph('See: a\nCo-Authored-By: b') === '')
}

console.log('the card speaks to somebody who has never coded')
{
  const p = plainWords('Pane chip: `pushing the repo 0:12` with a clock, instead of a bare `moving` (Session.handoffStage/handoffSince); every step lands in handoff.log under userData, where before it went to console.info and was lost.')
  ok('a sentence that was mostly code says nothing rather than holes', p === '', p)
  ok('code spans and parentheses are gone from a mostly-plain sentence', plainWords('The list is hidden now and the `reveal` button (30px) brings it back to the same place it was.') === 'The list is hidden now and the button brings it back to the same place it was.', plainWords('The list is hidden now and the `reveal` button (30px) brings it back to the same place it was.'))
  ok('camelCase identifiers are gone', !/[a-z][A-Z]/.test(plainWords('the askRef refuses a bare click')))
  ok('a first sentence stands alone', plainWords('Short one here that is long enough. Second sentence.') === 'Short one here that is long enough.')
  ok('New session says the window is open', /New session window is open/.test(howToCheck({ open: 'newSession', checks: [] })))
  ok('a hidden list points at the ringed button', /ringed button/.test(howToCheck({ open: 'sidebarHidden', checks: [] })))
  ok('nothing to click says the app checks it below', /the app checks this one below/.test(howToCheck({ open: 'none', checks: ['scripts/x-test.mjs'] })))
  ok('nothing ever tells anybody to open a pane', !/pane/i.test(howToCheck({ open: 'none', checks: [] })))
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('Done or dismiss folds to a pill, never to nothing', /tour-pill/.test(card) && /setGone\(false\)/.test(card))
  // CRLF on a Windows checkout: the assertion below looks for a literal newline.
  const dlg = readFileSync(join(root, 'src/renderer/src/components/NewSessionDialog.tsx'), 'utf8').replace(/\r\n/g, '\n')
  ok('Let the app decide is the first pick and the default', dlg.indexOf("['auto', 'Let the app decide']") < dlg.indexOf("['local', 'This machine'],\n") && /useState<'auto' \| 'local' \| 'remote'>\('auto'\)/.test(dlg))
}

console.log('a change with nothing on screen is still checked')
{
  const s = stepFrom(c('Deep fix', '', ['src/main/devServers.ts', 'scripts/devlist-test.mjs', 'scripts/ask-render-test.mjs']))
  ok('its own suites are the checks', s.checks.length === 1 && s.checks[0] === 'scripts/devlist-test.mjs')
  ok('a suite that needs a window is named, not run', s.byHand.length === 1 && s.byHand[0] === 'npm run test:askrender', s.byHand[0])
  ok('the check is named the way package.json names it', checkName('scripts/devlist-test.mjs') === 'test:devlist')
  ok('only a test script the repo carries may run', checkAllowed('scripts/devlist-test.mjs') && !checkAllowed('scripts/try.mjs') && !checkAllowed('../x-test.mjs') && !checkAllowed('scripts/../a-test.mjs'))
  const good = readCheck('scripts/x-test.mjs', 0, 'ok   one\nok   two\n\nx: all good')
  ok('a green run counts its ok lines', good.ok && good.passed === 2 && good.failed === 0)
  const bad = readCheck('scripts/x-test.mjs', 1, 'ok   one\nFAIL two - was 3\n\n1 failed')
  ok('a red run is red with its tail', !bad.ok && bad.failed === 1 && /was 3/.test(bad.tail))
  ok('exit 0 with a FAIL line is still red', !readCheck('s', 0, 'FAIL x').ok)
}

console.log('the tour plays itself')
{
  const looking = { text: 'x', open: 'settings', where: 'Settings', see: [], checks: [], byHand: [] }
  const checked = { text: 'x', open: 'none', where: NO_SCREEN, see: [], checks: ['scripts/x-test.mjs'], byHand: [] }
  const plain = { text: 'x', open: 'none', where: NO_SCREEN, see: [], checks: [], byHand: [] }
  ok('a check in flight holds the tour where it is', dwellFor(checked, true) === null)
  ok('and it moves on once the result is on the card', dwellFor(checked, false) === DWELL_CHECKS_MS)
  // A step with something on screen has something to DO on it - a dialog to open, a box to
  // type in - so the clock does not run there at all: it waits for a person.
  ok('something on screen waits, never counts down', dwellFor(looking, false) === null)
  ok('a ring alone waits too', dwellFor({ ...plain, spot: '.pane' }, false) === null)
  ok('a sentence with nothing to do moves on by itself', dwellFor(plain, false) === DWELL_PLAIN_MS)
  ok('the card says so while it waits', /data-testid="tour-wait"/.test(readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')))
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('the card waits to be started, and takes no turn nobody asked for', /const \[playing, setPlaying\] = useState\(false\)/.test(card))
  // A TOUR RUNS ITS OWN CHECKS (Robert, 2026-09-04: "if we doing tour then it should do
  // everything itself so we wont need the run test:cloudwork"), reversing the earlier
  // per-step approval. Starting the tour IS the approval - the card still runs nothing on
  // its own before that press, and a step reached by hand still has a button.
  ok('starting the tour runs each step\'s checks', /if \(!state \|\| gone \|\| !started\) return\s+const step = currentStep\(state\)\s+if \(!step\.checks\.length[^\n]*\) return\s+runChecks\(\)/.test(card))
  // "why is there button checking this change? is it even needed" (Robert, 2026-09-04).
  // It is not: once the tour is started nothing on the card asks a second time.
  ok('no button asks to run a check', !/data-testid="tour-run"/.test(card))
  // Keyed on `started`, not `playing` - a step reached by Next, or sat on while paused, is
  // still a step in a tour that was started, and its checks run there too.
  ok('a paused or hand-steered step still runs its checks', /const \[started, setStarted\] = useState\(false\)/.test(card) && /\[index, gone, started, saved\]/.test(card))
  ok('nothing runs before the tour is started', /const \[playing, setPlaying\] = useState\(false\)/.test(card))
  ok('and the card says so instead of offering a button', /when you start the tour/.test(card))
  // `test:cloudwork` is the name of a file in this repository and has no business on a
  // card - Robert, 2026-09-04: "why is there another button calld run test:cloudwork? its
  // wrong". The card asks `checkWords`; `checkName` stays for logs and nothing else.
  ok('no npm script name reaches the card', !/checkName/.test(card))
  ok('the check speaks plainly', /Checking this change/.test(String(checkWords(1))))
  ok('and says how many when there is more than one', /2 checks/.test(String(checkWords(2))))
  // What it is doing THIS second, straight off the suite's own output.
  ok('a running check shows its live output', /data-testid="tour-check-live"/.test(card))
  ok('main streams a line at a time, never a buffer at the end', /onLine\?\.\(\{ script, passed, failed, line \}\)/.test(readFileSync(join(root, 'src/main/tour.ts'), 'utf8')))
  // A number nobody can see is a tour that looks stuck.
  ok('a counting step shows the seconds left', /next in \$\{Math\.ceil\(left \/ 1000\)\}s/.test(card))
  ok('the countdown never decides the move itself', /setLeft\(Math\.max\(0, until - Date\.now\(\)\)\)/.test(card) && /setTimeout\(\(\) => \{/.test(card))
  ok('it advances on its own', /setTimeout\(\(\) => \{[\s\S]{0,600}?next\(s\)[\s\S]{0,200}?\}, wait\)/.test(card))
  // The counter read `0 of 44` however long it ran, so the one number saying how far
  // through you are said nothing (Robert, 2026-09-04). A step the tour has SHOWN is ticked
  // on the way out - and by a write that does NOT jump the index, or the play loop and the
  // tick would fight over where to go next.
  ok('a step it has shown is ticked off', /tickDone\(currentStep\(state\)\)/.test(card))
  ok('the automatic tick moves nothing by itself', /const tickDone = \(s: TourStep\): void => \{[\s\S]{0,400}?saveMap/.test(card))
  ok('and it never re-writes a step already ticked', /if \(was\[k\]\) return was/.test(card))
  ok('a hold draws no timer at all', /if \(wait === null\) \{\s+setLeft\(null\)\s+return\s+\}/.test(card))
  // Next and Previous are STEERING, not stopping (Robert, 2026-09-04: "it should still
  // continue with tour if i press next, its just to go to the next thing"). Only Pause and
  // the end of the list clear `playing`; the two arrows write nothing but the index.
  ok('the arrows only move, they do not stop the tour', (card.match(/setPlaying\(false\)/g) ?? []).length === 1)
  ok('Previous just moves', /disabled=\{state\.index === 0\}\s+onClick=\{\(\) => setState\(\(s\) => \(s \? previous\(s\) : s\)\)\}/.test(card))
  // Next now ticks the step it is leaving off (a started tour marks its own progress) and
  // then moves - what it must still not do is stop the tour, which the count above pins.
  ok('Next ticks and moves, and stops nothing', /if \(started\) tickDone\(step\)\s*\n\s*setState\(\(s\) => \(s \? next\(s\) : s\)\)/.test(card))
  // The only moving thing on the card, and the only sign a suite is alive between lines.
  ok('a running check has a live pulse', /tour-check-dots/.test(card) && /@keyframes tourDot/.test(readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')))
  ok('and it is discrete, so it composites on the step not the frame', /animation: tourDot 1\.2s steps\(1, end\) infinite/.test(readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')))
  // "Checked - 0 things proved" over a suite that had just proved 829 things (Robert,
  // 2026-09-04, screenshot). `scripts/sound-test.mjs` prints ONE sentence about itself and
  // no line per assertion, so counting `ok` lines answered nothing.
  ok('a suite that prints one summary line still has a count', summaryCount('sounds: 829 checks passed (26 sounds in the catalogue)') === 829)
  ok('and the npm-test shape too', summaryCount('176 tests passed in 40.9s') === 176)
  ok('the LAST number wins, never a heading', summaryCount('3 checks passed\n\n829 checks passed') === 829)
  ok('nothing to count is 0, never NaN', summaryCount('all good') === 0)
  ok('a per-assertion suite is read from its ok lines', readCheck('scripts/x-test.mjs', 0, 'ok one\nok two\n').passed === 2)
  ok('and a summary-only suite from its sentence', readCheck('scripts/x-test.mjs', 0, 'sounds: 829 checks passed').passed === 829)
  // A number nobody measured is worse than no number.
  ok('a checked step with no count says just Checked', checkedWords({ ok: true, passed: 0, failed: 0 }) === 'Checked')
  ok('and with one says how many', /829 things proved/.test(checkedWords({ ok: true, passed: 829, failed: 0 })))
  ok('a failure still counts both sides', /2 of 5 failed/.test(checkedWords({ ok: false, passed: 3, failed: 2 })))
  ok('the card asks for those words rather than writing its own', /checkedWords\(all\)/.test(card))

  // THE TOUR DOES THE THING. A step about a sound plays the sound.
  const heard = (t) => demoFor({ text: t, see: [] })
  ok('a step about a sound plays one', heard('The countdown is heard whatever sound it was pointed at')?.kind === 'sound')
  ok('a countdown gets the bowl', heard('the close countdown is heard')?.sound === 'bowl')
  ok('a question gets the knock', heard('a question a pane asks now makes a sound')?.sound === 'knock')
  ok('anything else that makes a noise gets the chime', heard('the finished turn plays a note')?.sound === 'chime')
  // The refusal is the load-bearing half: a card that played a sound on every step would
  // be noise, not a demonstration.
  ok('a step about nothing audible plays nothing', heard('The sessions list groups both machines') === null)
  ok('and neither does a silent layout change', heard('The dialog fits on a short window') === null)
  ok('the card plays it on arrival, on the same one press as the checks', /if \(!state \|\| gone \|\| !started \|\| !demo \|\| played\[index\]\) return/.test(card))
  ok('and offers it again by hand', /data-testid="tour-demo-again"/.test(card))

  // One segment per step, lit as it is ticked off.
  ok('the bar is a segment per step', /state\.steps\.map\(\(s, i\) => \(\s*<span/.test(card))
  ok('a ticked segment is lit', /doneMap\[stepKey\(s\)\] \? 'lit' : ''/.test(card))
  ok('and the one you are on is marked', /i === state\.index \? ' here' : ''/.test(card))
  {
    const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
    ok('the bar is drawn as segments, not one filled strip', /\.tour-bar \{ display: flex;/.test(css) && /\.tour-bar > span\.lit \{ background: var\(--accent\)/.test(css))
  }

  // PROGRESS IS KEPT ACROSS A REOPEN. Finding a broken thing halfway means closing the dev
  // copy, fixing it, and opening it again - and re-running twenty suites to get back to
  // where you were is what made that cost a whole second pass (Robert, 2026-09-04).
  ok('verdicts are written to disk, not just ticks', /const CHECKS_KEY = 'tour\.checks'/.test(card))
  ok('and written the moment one lands', /localStorage\.setItem\(CHECKS_KEY, JSON\.stringify\(upd\)\)/.test(card))
  ok('a step that already answered is not run again', /if \(!step\.checks\.length \|\| checks\[index\] \|\| saved\[stepKey\(step\)\]\) return/.test(card))
  ok('a kept verdict is drawn like a fresh one', /saved\[stepKey\(currentStep\(state\)\)\] \? \{ state: 'done', results:/.test(card))
  ok('and says it is kept, so it is not mistaken for this run', /kept from an earlier run/.test(card))
  ok('a kept verdict can be re-run by hand', /data-testid="tour-check-again"/.test(card) && /runChecks\(true\)/.test(card))
  ok('the ticks survive too', /localStorage\.setItem/.test(card) && /const DONE_KEY = 'tour\.done'/.test(card))

  ok('and the last step is where it stops', /if \(done\(state\)\) \{[\s\S]*?setPlaying\(false\)/.test(card))
}

console.log('the installed app never gets a tour')
{
  ok("the installed app's profile is refused", tourAllowed('') === false)
  ok('a named dev profile is allowed', tourAllowed('dev-a') === true)
  const main = readFileSync(join(root, 'src/main/tour.ts'), 'utf8')
  ok('main checks tourAllowed before reading anything', main.indexOf('tourAllowed(profileName())') < main.indexOf('diffCommits('))
  ok('and before running anything', /export function tourCheck[\s\S]*?tourAllowed\(profileName\(\)\)[\s\S]*?checkAllowed\(script\)[\s\S]*?spawn\(/.test(main))
  ok('checks run on the node npm test uses, never Electron', /which\('node'\)/.test(main) && !/execFile\(\s*process\.execPath/.test(main))
}

console.log('it may never take the screen')
{
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('drawn in the renderer, never a dialog', !/showMessageBox|dialog\./.test(card))
  ok('never focuses or raises anything', !/focus\(|setAlwaysOnTop|moveTop/.test(card))
  ok('and it opens no pane and types no prompt of its own', !/startSessions/.test(card))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('it is actually mounted', /<TourCard/.test(app))
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  ok('it is a static child of the corner stack, not its own fixed card', /corner-stack > \.tour-card/.test(css))
  ok('and it has no animation of its own', !/\.tour-card[^}]*animation:/.test(css) && !/\.tour-spot[^}]*animation:/.test(css))
  ok('the ring takes no clicks', /\.tour-spot\s*\{[^}]*pointer-events:\s*none/.test(css))
}

console.log('a ticked step is skipped, in order')
{
  const steps = buildSteps([c('First'), c('Second'), c('Third')])
  ok('stepKey is the commit\'s own subject', stepKey(steps[0]) === 'First')
  ok('nobody ticked: starts at the first', nextUnchecked(steps, {}) === 0)
  ok('first ticked: lands on the second', nextUnchecked(steps, { First: true }) === 1)
  ok('every one ticked: -1, never a guess', nextUnchecked(steps, { First: true, Second: true, Third: true }) === -1)
}

console.log('the card ticks steps off and remembers')
{
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('remembers ticked steps in localStorage', /localStorage/.test(card) && /tour\.done/.test(card))
  ok('opens on the next unchecked step when the tour loads', /nextUnchecked/.test(card))
  ok('a Done tick exists per step', /data-testid="tour-step-done"/.test(card) && /type="checkbox"/.test(card))
  ok('the header counts what is checked', /of \{state\.steps\.length\} checked/.test(card))
  ok('offers Close once every step is ticked', /Every step is checked off/.test(card))
  // The tick is a record of what was looked at, not another way to make the app act: it
  // must not resurrect the pane-opening helper Robert had removed.
  ok('and ticking still opens no pane', !/startSessions/.test(card))
}


console.log('a step is named after the thing on screen, not the commit subject')
{
  // The real one Robert was looking at: a header fix whose only source file is under
  // src/shared, so the file table alone said "nothing to click" about a change to the
  // icons in every pane header.
  const header = stepFrom(
    c('Ask the row whether it fits, instead of adding its widths up', '', ['src/shared/headerFit.ts', 'src/renderer/src/headerFit.ts'], 'header')
  )
  ok('the scope names the place', header.where === "a session's header")
  ok('the title is the place, not the subject', header.title === "A session's header")
  ok('and it opens a session to show it', header.open === 'pane')
  ok('ringing the icons, not the whole pane', header.spot === '.pt-actions')
  ok('the subject is still carried, under the name', header.text.startsWith('Ask the row'))
  ok('a change with no screen says so plainly', titleFor(NO_SCREEN) === 'Inside the app')
  ok('and a place nobody could name says the same', titleFor('') === 'Inside the app')
  ok('a scope this app cannot show falls through to the files', stepFrom(c('X', '', ['src/main/index.ts'], 'promptlib')).where === NO_SCREEN)
  ok('a pane surface tells you what to look at', /ring/i.test(howToCheck({ open: 'pane', checks: [] })))
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('the card draws the name', /data-testid="tour-title"/.test(card))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('the app opens a session for a pane step', /surface === 'pane'/.test(app))
  ok('a shell, never an agent CLI', /agent: 'shell'/.test(app))
  // A pane that comes straight back when it is closed is a pane nobody can get rid of.
  ok('one shell for the whole tour, never a second', /tourPaneOpened\.current = true/.test(app) && /!tourPaneOpened\.current/.test(app))
  // Every other step gives the sessions list back: a hidden sidebar leaves no way to
  // reach a pane's own close button, and a collapsed one wears the ring as a line.
  ok('the list comes back unless the step is about hiding it', /setSideHidden\(surface === 'sidebarHidden'\)/.test(app))
}

console.log('every suite a step ran is ONE line')
{
  const two = [
    { script: 'scripts/a-test.mjs', ok: true, passed: 34, failed: 0, tail: '' },
    { script: 'scripts/b-test.mjs', ok: true, passed: 38, failed: 0, tail: '' }
  ]
  const all = checkedAll(two)
  ok('the counts are added up', all.passed === 72 && all.failed === 0 && all.ok)
  ok('and read as one sentence', checkedWords(all) === 'Checked - 72 things proved')
  const bad = checkedAll([two[0], { script: 'scripts/c-test.mjs', ok: false, passed: 1, failed: 2, tail: 'FAIL' }])
  ok('one failing suite fails the step', !bad.ok && bad.failed === 2)
  ok('nothing at all is still an answer, not a crash', checkedAll([]).ok && checkedAll([]).passed === 0)
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('the card draws one verdict row', /data-testid="tour-check-done"/.test(card) && /checkedAll\(check\.results\)/.test(card))
  ok('and never maps the results into a row each', !/check\.results\.map\(/.test(card))
}

console.log('a started tour ticks its own steps off')
{
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('Next ticks the step it leaves, once started', /if \(started\) tickDone\(step\)/.test(card))
  // Previous is steering backwards - it must not tick anything off on the way.
  const prev = card.slice(card.indexOf('Previous') - 400, card.indexOf('Previous'))
  ok('Previous ticks nothing', !/tickDone/.test(prev))
}

console.log(failed ? `\n${failed} failed` : '\ntour: all good')
process.exit(failed ? 1 : 0)
