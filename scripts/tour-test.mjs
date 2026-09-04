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
  stepFrom, placesFor, trailersOf, firstParagraph, checkAllowed, readCheck, checkName, plainWords, howToCheck
} = await import(pathToFileURL(join(root, 'src/shared/tour.ts')).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}
const c = (subject, body = '', files = []) => ({ subject, body, files })

console.log('an empty list draws nothing')
{
  ok('no commits at all', makeTour([]) === null)
  ok('only blank subjects', makeTour([c(''), c('   ')]) === null)
  ok('blank subjects dropped from a real list', buildSteps([c(''), c('A real sentence'), c('  ')]).length === 1)
}

console.log('the index clamps at both ends')
{
  const t = makeTour([c('First'), c('Second'), c('Third')], '/repo')
  ok('starts at the first step', t.index === 0)
  ok('carries the checkout root for Try it and the checks', t.root === '/repo')
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
  ok('a dialog is named and opened', p.where === "the New session dialog, the window's look" && p.open === 'newSession', p.where)
  ok('and ringed', p.spot === '.dialog')
  ok('a component nobody listed is still named off its own name', placesFor(['src/renderer/src/components/HandoffDialog.tsx']).where === 'the Handoff dialog')
  ok('main-process files say there is nothing to click', placesFor(['src/main/devServers.ts']).where === 'inside the app, nothing to click')
  ok('the try command is not this window', /npm run try/.test(placesFor(['scripts/try.mjs']).where))
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
  ok('the first Try line wins', t.try === 'run rm on a scratch file')
  const s = stepFrom(c('Subject', body))
  ok('a step carries them', s.see.length === 2 && s.try === 'run rm on a scratch file')
  const plain = stepFrom(c('Subject', 'First paragraph says why.\nStill first.\n\nSecond paragraph.'))
  ok('no See lines: the first paragraph stands in', plain.see.length === 1 && plain.see[0] === 'First paragraph says why. Still first.', plain.see[0])
  ok('and no Try is invented', plain.try === undefined)
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
  ok('New session says the window is open', /New session window is open/.test(howToCheck({ open: 'newSession', checks: [], try: undefined })))
  ok('a hidden list points at the ringed button', /ringed button/.test(howToCheck({ open: 'sidebarHidden', checks: [], try: undefined })))
  ok('nothing to click says the app checked it', /checked it for you/.test(howToCheck({ open: 'none', checks: ['scripts/x-test.mjs'], try: undefined })))
  ok('a Try prompt says to press it', /Try it in a pane/.test(howToCheck({ open: 'none', checks: [], try: 'do x' })))
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('Done or dismiss folds to a pill, never to nothing', /tour-pill/.test(card) && /setGone\(false\)/.test(card))
  const dlg = readFileSync(join(root, 'src/renderer/src/components/NewSessionDialog.tsx'), 'utf8')
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

console.log('the installed app never gets a tour')
{
  ok("the installed app's profile is refused", tourAllowed('') === false)
  ok('a named dev profile is allowed', tourAllowed('dev-a') === true)
  const main = readFileSync(join(root, 'src/main/tour.ts'), 'utf8')
  ok('main checks tourAllowed before reading anything', main.indexOf('tourAllowed(profileName())') < main.indexOf('diffCommits('))
  ok('and before running anything', /export function tourCheck[\s\S]*?tourAllowed\(profileName\(\)\)[\s\S]*?checkAllowed\(script\)[\s\S]*?execFile\(/.test(main))
  ok('checks run on the node npm test uses, never Electron', /which\('node'\)/.test(main) && !/execFile\(\s*process\.execPath/.test(main))
}

console.log('it may never take the screen')
{
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('drawn in the renderer, never a dialog', !/showMessageBox|dialog\./.test(card))
  ok('never focuses or raises anything', !/focus\(|setAlwaysOnTop|moveTop/.test(card))
  ok('Try it opens a pane with the change\'s own prompt', /startSessions\(\[\{[^}]*prompt: step\.try/.test(card))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('it is actually mounted', /<TourCard/.test(app))
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  ok('it is a static child of the corner stack, not its own fixed card', /corner-stack > \.tour-card/.test(css))
  ok('and it has no animation of its own', !/\.tour-card[^}]*animation:/.test(css) && !/\.tour-spot[^}]*animation:/.test(css))
  ok('the ring takes no clicks', /\.tour-spot\s*\{[^}]*pointer-events:\s*none/.test(css))
}

console.log(failed ? `\n${failed} failed` : '\ntour: all good')
process.exit(failed ? 1 : 0)
