// What a pane would be called, run through the SHIPPED rule rather than described.
//
//   node scripts/title-demo.mjs
//
// The naming change is the one thing in this build that cannot be pointed at on screen
// without opening real agent panes and typing at them, so it is shown the other way: the
// same file the app runs, given the prompt that produced the bad card, printing what it
// answers now.

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-title-demo')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'clientName.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/clientName.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const outPlace = join(work, 'place.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/place.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: outPlace
})
const { topicTitle, mayTopicName } = createRequire(import.meta.url)(out)
const { projectTag } = createRequire(import.meta.url)(outPlace)

const cases = [
  ['/Users/robertiuoras/Projects/PaneForge', 'pizzasrus and the invoice template'],
  ['/Users/robertiuoras/Projects/PaneForge', 'fix the history search'],
  ['/Users/robertiuoras/Projects/clients', 'pizzasrus and the invoice template'],
  ['/Users/robertiuoras/Projects/clients', 'fix the deploy script and'],
  ['/Users/robertiuoras/Projects/clients/pizzasrus', 'chase the outstanding invoices with']
]

console.log('\n      folder                     first ask                              card says')
for (const [cwd, ask] of cases) {
  const folder = cwd.split('/').pop()
  const named = mayTopicName(cwd) ? topicTitle(ask) : ''
  console.log(
    `      ${folder.padEnd(26)} ${('"' + ask + '"').padEnd(38)} ${named || folder + '   (folder name kept)'}`
  )
}
console.log('      before this build: "Pizzasrus And Invoice Tem", on any folder')

// docs/brief-session-naming-2026-09-04.md - four cards read off this session's own asks,
// each a defect in the rule rather than in the app: an opener that ate the budget, a name
// that dangled on a filler word, two trailing fillers in a row, and two verbs where the
// card had room for one.
const fixed = [
  ['whenever you open the dev window it will say whats different', 'Whenever You Open Dev'],
  ['can you measure right now why im lagging?', 'Measure Right Now Why'],
  ['we need to tune the naming of session as well, broken like this', 'Tune Naming Of As'],
  ['when pressing on sidebar icon everything breaks', 'Fixing Pressing On Sidebar']
]
console.log('\n      the four defects Robert was shown, before and after this build')
console.log('      first ask                                                    before this build       ->  now')
for (const [ask, before] of fixed) {
  console.log(`      ${('"' + ask + '"').padEnd(60)} ${before.padEnd(24)} ->  ${topicTitle(ask)}`)
}

// The addition: a name says WHICH PROJECT it belongs to, appended after the subject.
console.log('\n      subject                       project      tag        card reads')
for (const [subject, project] of [
  ['Dev Window Testing', 'PaneForge'],
  ['Sort Invoice Reminders', 'taskdriver.ai'],
  ['Chasing Invoices', 'Cars']
]) {
  const tag = projectTag(project)
  console.log(
    `      ${subject.padEnd(29)} ${project.padEnd(12)} ${tag.padEnd(10)} ${subject} · ${tag}`
  )
}
console.log('')
