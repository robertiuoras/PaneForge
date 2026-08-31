// What a pane is allowed to rename itself to.
//
// The half of this worth testing is the REFUSALS. A pane that keeps its folder name is a
// pane exactly as useful as it was yesterday; a pane renamed to the wrong client is a card
// that lies while somebody sends an invoice off it, and nothing on screen says a machine
// guessed. So most of what is below is a client NOT being found.
//
//   node scripts/client-name-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-client-name-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'clientName.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/clientName.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const {
  clientFromPath,
  clientFromText,
  clientTitle,
  mayRename,
  nameFromHeading,
  slugFromPath,
  topicTitle,
  mayTopicName,
  repeatedTopic,
  topicKeywords,
  SHORT_TITLE,
  withAliases
} = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, `${what}\n  got: ${JSON.stringify(actual)}`)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

// The real tree on this desk, names read out of the real READMEs.
const roster = withAliases([
  { slug: 'angelo-m', name: 'Angelo M' },
  { slug: 'angie-c', name: 'Angie C.' },
  { slug: 'level-8-building', name: 'Level 8 Building' },
  { slug: 'pia-team', name: 'PIA Team' },
  { slug: 'pizza-ovens-r-us', name: 'Pizza Ovens R Us' },
  { slug: 'powerhouse-management', name: 'Powerhouse Management' },
  { slug: 'prospect-finance-group', name: 'Prospect Finance Group' },
  { slug: 'right-key-alison', name: 'Right Key Investment - Alison' },
  { slug: 'settle-ease-conveyancing', name: 'Settle Ease Conveyancing' },
  { slug: 'sonia-b', name: 'Sonia B' }
])
const found = (cwd) => clientFromPath(cwd, roster)?.slug
const said = (text) => clientFromText(text, roster)?.slug

// ---------------------------------------------------------------- the folder is evidence

is(slugFromPath('/Users/r/Projects/clients/clients/pia-team'), 'pia-team', 'the folder itself')
is(
  slugFromPath('/Users/r/Projects/clients/clients/pia-team/campaigns/creatives'),
  'pia-team',
  'a folder deep inside it'
)
is(slugFromPath('C:\\P\\clients\\clients\\angie-c\\replies'), 'angie-c', 'windows separators')
// The LAST `clients` wins, which is what gets a repository called `clients` holding a
// folder called `clients` right without knowing anything about this particular desk.
is(slugFromPath('/Users/r/Projects/clients/tools'), 'tools', 'the outer folder is read...')
is(found('/Users/r/Projects/clients/tools'), undefined, '...and the roster refuses it')
is(slugFromPath('/Users/r/Projects/clients'), undefined, 'the tree root names nobody')
is(slugFromPath('/Users/r/Projects/PaneForge/src'), undefined, 'an ordinary repo names nobody')
is(found('/Users/r/Projects/clients/clients/right-key-alison'), 'right-key-alison', 'a client')

// ------------------------------------------------------------------- names out of a README

is(nameFromHeading('# Angie C.', 'angie-c'), 'Angie C.', 'a heading that is already the name')
is(
  nameFromHeading('# PIA Team (Property Investors Alliance) - Darren F.', 'pia-team'),
  'PIA Team',
  'an expansion and a contact both come off'
)
// The contact rule is a SHAPE - a name plus an initial - so a bare first name survives,
// because that is how this client is actually referred to.
is(
  nameFromHeading('# Right Key Investment - Alison (澳洲Alison老師)', 'right-key-alison'),
  'Right Key Investment - Alison',
  'a bare first name is part of the name'
)
is(nameFromHeading('#   ', 'sonia-b'), 'Sonia B', 'an empty heading falls back to the folder')

// --------------------------------------------------------- what a prompt is allowed to say

is(said('draft the piateam replies for this week'), 'pia-team', 'the squashed slug')
is(said('pia-team campaign creatives'), 'pia-team', 'the slug as written')
is(said('new PIA Team ad set'), 'pia-team', 'the name as written')
is(said('send alison the august market update'), 'right-key-alison', 'a unique first name')
is(said('angie wants the ghl board tidied'), 'angie-c', 'another unique first name')
is(
  said('right key investment - alison monthly report'),
  'right-key-alison',
  'the whole name, punctuation and all'
)

// The refusals, which are the feature.
is(said('check the rental car booking'), undefined, 'a prompt about nobody')
is(said(''), undefined, 'nothing typed')
is(said('the team needs a new group finance report'), undefined, 'words several clients share')
is(
  said('compare powerhouse management and prospect finance group'),
  undefined,
  'two clients named is not a client'
)
is(said('pia'), undefined, 'three characters is not evidence')
ok(
  roster.every((c) => c.aliases.every((a) => a.length >= 5)),
  'no alias is shorter than five characters'
)
ok(
  !roster.some((c) => c.aliases.includes('team')),
  'a word several clients share is worth nothing'
)
ok(
  !roster.some((c) => c.aliases.includes('finance')),
  'a word only one client has can still be furniture'
)

// A roster with one client in it has no ambiguity to protect against, and that is correct
// rather than a special case - its own words really are unique.
const solo = withAliases([{ slug: 'angie-c', name: 'Angie C.' }])
is(clientFromText('angie wants a call', solo)?.slug, 'angie-c', 'one client, its own words')

// -------------------------------------------------------------- the subject of a first ask

is(topicTitle('check the rental car booking'), 'Rental Car Booking', 'the runway comes off')
is(
  topicTitle('can you please help me fix the invoice template'),
  'Fix Invoice Template',
  'politeness and articles both come off'
)
// A label may not end on the word that joined it to the half that was cut off:
// `pizzasrus and the invoice template` used to name a pane `Pizzasrus And`.
is(topicTitle('pizzasrus and the invoice template'), 'Pizzasrus And Invoice', 'never half a word')
is(topicTitle('fix the deploy script and'), 'Fix Deploy Script', 'trailing and trimmed')
is(topicTitle('rename the invoice folder with'), 'Rename Invoice Folder', 'trailing with trimmed')
is(topicTitle('pizzasrus invoice reminder emails'), 'Pizzasrus Invoice Reminder', 'a real four-word subject survives')
is(topicTitle('look at it'), '', 'nothing but joining words is not a subject')

// A pane already wearing a project's name is not renamed to a sentence: PaneForge stays
// PaneForge however the first ask is worded. Only a client tree, where every pane is
// called `clients`, has nothing to lose.
is(mayTopicName('/Users/r/Projects/PaneForge'), false, 'a repo keeps its own name')
is(mayTopicName('/Users/r/Projects/clients'), true, 'the client tree root')
is(mayTopicName('/Users/r/Projects/clients/pizzasrus/menu'), true, 'anywhere inside it')
is(mayTopicName('C:\\Users\\Gamer\\Desktop\\Projects\\clients\\angie'), true, 'either separator')
is(mayTopicName(''), false, 'no folder, no rename')

is(topicTitle('/clear'), '', 'a slash command is a command, not a subject')
is(topicTitle('ok'), '', 'too short to identify a pane')
is(topicTitle(''), '', 'nothing typed')
ok(topicTitle('rewrite the onboarding email sequence for new leads').length <= 26, 'capped')

// ------------------------------------------------------------------------- who may rename

ok(mayRename('clients', '/Users/r/Projects/clients'), 'a pane still wearing the folder name')
ok(!mayRename('Angie C.', '/Users/r/Projects/clients'), 'a pane that has already been named')
ok(!mayRename('clients', '/Users/r/Projects/clients', true), 'a pane that said no')
is(clientTitle({ slug: 'x', name: 'y'.repeat(80), aliases: [] }).length, 60, 'capped like rename')

// ------------------------------------------------- a subject several asks agree on

const say = (...asks) => repeatedTopic(asks)

is(say('the invoice reminder emails'), '', 'one ask is not a subject')
is(say('invoice reminders', 'the invoice template'), '', 'twice is not a subject either')
is(
  say('sort the invoice reminders', 'fix the invoice template', 'invoice numbering is wrong'),
  'Invoice',
  'three asks about invoices name the pane'
)
is(
  say('what did we ship', 'is the mac lagging', 'make a dev release'),
  '',
  'three unrelated asks name nothing'
)
is(
  say('invoice reminders', 'invoice template', 'deploy the site', 'the site deploy failed'),
  '',
  'a subject that has scrolled out of the window stops counting'
)
ok(
  say(
    'the onboarding email sequence needs rewriting',
    'onboarding email sequence tone',
    'onboarding email sequence timing'
  ).length <= SHORT_TITLE,
  'a repeated subject is short'
)
is(
  say('please can you check this', 'could you look at that', 'would you make it better'),
  '',
  'words every prompt uses are not a subject'
)
is(say('/clear', '/clear', '/clear'), '', 'slash commands say nothing')
is(topicKeywords('fix the invoice template').join(' '), 'invoice template', 'runway and verbs drop out')

console.log(`client-name: ${checks} checks passed`)
