// The dev-copy tour: turning "what changed" sentences into steps you can press through.
// No window, no git, no Electron - see src/shared/tour.ts for why that is possible.
//
//   node scripts/tour-test.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { buildSteps, makeTour, currentStep, next, previous, done, surfaceFor, tourAllowed } =
  await import(pathToFileURL(join(root, 'src/shared/tour.ts')).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

console.log('an empty list draws nothing')
{
  ok('no lines at all', makeTour([]) === null)
  ok('only blank lines', makeTour(['', '   ', '\t']) === null)
  ok('blank lines dropped from a real list', buildSteps(['', 'A real sentence', '  ']).length === 1)
}

console.log('the index clamps at both ends')
{
  const t = makeTour(['First', 'Second', 'Third'])
  ok('starts at the first step', t.index === 0)
  const atStart = previous(t)
  ok('previous at the first step stays put', atStart.index === 0)
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
  ok(
    'the sidebar is recognised',
    surfaceFor('Hiding the list gives the panes the whole window, not 42px of it') === 'sidebarHidden'
  )
  ok('workspaces is recognised', surfaceFor('A workspace launches every project again') === 'workspaces')
  const t = makeTour(['Something nobody wrote a keyword for'])
  ok('and it lands on the step as none, not a guess', currentStep(t).open === 'none')
}

console.log('the tour is refused outside a dev profile')
{
  ok('the installed app (empty profile) gets no tour', !tourAllowed(''))
  ok('a dev profile gets one', tourAllowed('dev'))
  const main = readFileSync(join(root, 'src/main/tour.ts'), 'utf8')
  ok('main/tour.ts actually checks it before reading anything', /tourAllowed\(profileName\(\)\)/.test(main))
  ok('the refusal comes before the git read', main.indexOf('tourAllowed') < main.indexOf('diffLines('))
}

console.log('it may never take the screen')
{
  const card = readFileSync(join(root, 'src/renderer/src/components/TourCard.tsx'), 'utf8')
  ok('drawn in the renderer, never a dialog', !/showMessageBox|dialog\./.test(card))
  ok('never focuses or raises anything', !/focus\(|setAlwaysOnTop|moveTop/.test(card))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('it is actually mounted', /<TourCard/.test(app))
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  ok('it is a static child of the corner stack, not its own fixed card', /corner-stack > \.tour-card/.test(css))
  ok('and it has no animation of its own', !/\.tour-card[^}]*animation:/.test(css))
}

console.log(failed ? `\n${failed} failed` : '\ntour: all good')
process.exit(failed ? 1 : 0)
