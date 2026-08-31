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
const { topicTitle, mayTopicName } = createRequire(import.meta.url)(out)

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
console.log('      before this build: "Pizzasrus And Invoice Tem", on any folder\n')
