// A pane named off a handle takes the name the reply gives it.
//
// The fixture is the real thing: the ask typed into the clients pane on 2026-09-03 and
// the row its agent painted in answer, read back out of the pane's own history log. The
// refusals are the half worth pinning - a card renamed to a word the reply happened to
// capitalise is a card that lies.
//
//   node scripts/resolved-name-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-resolved-name-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'resolvedName.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/resolvedName.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { handleOf, resolvedName } = createRequire(import.meta.url)(out)

let n = 0
const eq = (got, want, why) => {
  n++
  assert.equal(got, want, why)
}

// --- the real ask, and the real reply row (history/s9-mtkurvmm.log, ANSI stripped) ---
const ASK =
  'working on $50 task from yesterday can you find that and also help check how many files and how big https://drive.google.com/drive/u/0/folders/1yT4mKGyS5kg9krppSPwwnPP-EgRTGNH1 we need to download for travel vlog etc.'
const REPLY =
  '⏺Calling taskdriver… (ctrl+o to expand)· Precipitating… (7s · ↓ 261 tokens)\n' +
  'Called taskdriver, Google Drive 7 times (ctrl+o to expand)⏺Bash(python3-c"     a=[12705093,10382562]\n' +
  '$50 task = Travel Video Editor, Jacob P.(boardid794,stageInprogress,\n' +
  'airtasker.com/tasks/travel-video-editor-x01m1geq4ceyjd7sf1b17s7d4yd).Norepofileforhimyet.\n' +
  'Drive folder: 141 files, 10.54 GB(9.82GiB).Allvideo,nophotos,nosubfolders.Ownerjacobpapa18@gmail.com\n'

eq(handleOf(ASK), '$50 task', 'the price is the handle')
eq(resolvedName(REPLY, handleOf(ASK)), 'Travel Video Editor', 'the reply resolves it to the task name')

// --- handles ---
eq(handleOf('can you look at the $1,200 job for me'), '$1,200 job', 'thousands')
eq(handleOf('that client from yesterday wants a quote'), 'client from yesterday', 'from yesterday')
eq(handleOf("yesterday's task, did we finish it?"), "yesterday's task", 'possessive')
eq(handleOf('reply to task #794 on airtasker'), 'task #794', 'a number')
eq(handleOf('the new client emailed'), 'the new client', 'the new one')
eq(handleOf('fix the invoice template and then look at that client'), '', 'only the first clause')
eq(handleOf('set up meta ads for pizzasrus'), '', 'an ask that names its subject has no handle')
eq(handleOf('/clear'), '', 'a slash command')
eq(handleOf('add a task to the backlog'), '', 'a task in general is not a handle')

// --- names off the reply ---
const H = '$50 task'
eq(resolvedName('$50 task is Travel Video Editor for Jacob', H), 'Travel Video Editor', '`is` links too')
eq(resolvedName('The $50 task: Travel Video Editor (Jacob P.)', H), 'Travel Video Editor', 'colon, bracket ends it')
eq(resolvedName('$50 task -> "travel video editor"', H), 'travel video editor', 'quoted names keep their case')
eq(resolvedName('$50 task = the Travel Video Editor task', H), 'Travel Video Editor', 'a trailing thing-word is dropped')
eq(resolvedName('$50task=Travel Video Editor', H), 'Travel Video Editor', 'a CLI paints without the spaces')
eq(resolvedName('Found it. $50 task = Pizzas R Us - logo refresh', H), 'Pizzas R Us', 'a dash ends the name')
eq(resolvedName('$50 task = Property Investors of Alliance, stage done', H), 'Property Investors of Alliance', 'a joiner inside a name stays')
eq(resolvedName('$50 task = A4 Advocate (Adie Bradley)', H), 'A4 Advocate', 'a name may open on a digit')

// --- refusals ---
eq(resolvedName('Looking for the $50 task now.\nSearching taskdriver…', H), '', 'a reply that never resolves it')
eq(resolvedName('$50 task = task 794', H), '', 'a number is not a name')
eq(resolvedName('$50 task = nothing found', H), '', 'nothing is not a name')
eq(resolvedName('$50 task = unknown', H), '', 'unknown is not a name')
eq(resolvedName('$50 task is done', H), '', 'a status is not a name')
eq(resolvedName('$50 task = handoff', H), '', 'a session word is not a name')
eq(resolvedName('the $50 task is still In progress on the board', H), '', 'a status sentence names nothing')
eq(resolvedName('', H), '', 'no reply')
eq(resolvedName(REPLY, ''), '', 'no handle')
eq(resolvedName('$50 task = Travel Video Editor', 'that client'), '', 'a different handle is not resolved by it')

console.log(`resolved-name-test: ${n} assertions OK`)
