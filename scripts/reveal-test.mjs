// What "open this project" opens - `src/shared/reveal.ts`.
//
// The load-bearing half is the negatives: `title` is a user-typed rename, so every shape
// that could point the OS at a folder outside the pane's own tree has to fall through to
// the answer this button gave before any of it (the control below).
import { revealTarget, nameable, within } from '../src/shared/reveal.ts'

let pass = 0
const fails = []
const is = (got, want, what) => {
  if (got === want) pass++
  else fails.push(`${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
}

const ROOT = '/Users/r/Projects/clients'
const subs = ['sonia', 'Maria', 'node_modules', '.git']

// --- the ask ---------------------------------------------------------------
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'Sonia', subdirs: subs }),
  `${ROOT}/sonia`,
  'a pane named after a folder in the repo opens that folder'
)
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'maria', subdirs: subs }),
  `${ROOT}/Maria`,
  'matching is case-insensitive both ways'
)
is(
  revealTarget({ root: ROOT, cwd: `${ROOT}/sonia`, title: 'anything', subdirs: [] }),
  `${ROOT}/sonia`,
  "the pane's own cwd beats its name - a rename may not move the button off the work"
)
is(
  revealTarget({ root: ROOT, cwd: `${ROOT}/sonia`, title: 'Sonia', subdirs: [] }),
  `${ROOT}/sonia`,
  'a pane already in the folder it is named after opens it once, not twice'
)

// --- the client a pane is named after ------------------------------------
// A client pane is named out of a README heading, and the folder is a slug two levels
// down, so the name match above finds nothing. Main hands the folder over instead.
const CROOT = `${ROOT}/clients`
is(
  revealTarget({
    root: ROOT,
    cwd: ROOT,
    title: 'Adie Bradley',
    subdirs: ['clients', 'data', 'tools'],
    clientDir: `${CROOT}/a4-advocate`
  }),
  `${CROOT}/a4-advocate`,
  "a client pane opens the client's own folder, which its title does not name"
)
is(
  revealTarget({
    root: ROOT,
    cwd: `${CROOT}/a4-advocate/site`,
    title: 'Adie Bradley',
    subdirs: [],
    clientDir: `${CROOT}/a4-advocate`
  }),
  `${CROOT}/a4-advocate/site`,
  'a pane already deeper than the client folder is not dragged back up to it'
)
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'Sonia', subdirs: subs, clientDir: `${CROOT}/a4-advocate` }),
  `${ROOT}/sonia`,
  'a title that does name a real folder still wins - it is the one fact a person typed'
)
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'Adie Bradley', subdirs: [], clientDir: '/Users/r/elsewhere/a4' }),
  ROOT,
  'a client folder outside the project is refused, like every other path this button is handed'
)
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'Adie Bradley', subdirs: [] }),
  ROOT,
  'no client found is the answer it always gave'
)

// --- the control: everything below must answer exactly what it always did ---
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'PaneForge', subdirs: subs }),
  ROOT,
  'CONTROL: a name matching no folder on disk is a label, not a path'
)
is(revealTarget({ root: ROOT, cwd: ROOT, subdirs: subs }), ROOT, 'CONTROL: no title at all')
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: 'sonia' }),
  ROOT,
  'CONTROL: nobody read the directory - absent is not "there are none"'
)
is(
  revealTarget({ root: ROOT, cwd: ROOT, title: '  ', subdirs: subs }),
  ROOT,
  'CONTROL: a blank title'
)
for (const bad of ['..', '../..', '/etc', 'a/b', 'a\\b', 'C:', '.', 'sonia/../..']) {
  is(
    revealTarget({ root: ROOT, cwd: ROOT, title: bad, subdirs: [...subs, bad] }),
    ROOT,
    `CONTROL: ${JSON.stringify(bad)} is never grafted onto the path`
  )
}
is(
  revealTarget({ root: ROOT, cwd: '/somewhere/else', title: 'sonia', subdirs: subs }),
  `${ROOT}/sonia`,
  'a cwd outside the root is not the base - the root is'
)

// --- the pieces ------------------------------------------------------------
is(nameable('sonia'), true, 'a plain name is nameable')
is(nameable('..'), false, 'dot-dot is not')
is(nameable(undefined), false, 'nothing is not')
is(within(ROOT, `${ROOT}/sonia`), true, 'a child is within')
is(within(ROOT, `${ROOT}-b/sonia`), false, 'a SIBLING whose name starts the same is not')
is(within(ROOT, ROOT), true, 'a folder is within itself')

// --- Windows ---------------------------------------------------------------
is(
  revealTarget({
    root: 'C:\\Projects\\clients',
    cwd: 'C:\\Projects\\clients',
    title: 'Sonia',
    subdirs: ['sonia'],
    sep: '\\'
  }),
  'C:\\Projects\\clients\\sonia',
  'the separator is the platform\u2019s'
)

if (fails.length) {
  console.error(`reveal: ${fails.length} FAILED, ${pass} passed`)
  for (const f of fails) console.error('  ' + f)
  process.exit(1)
}
console.log(`reveal: ${pass} checks passed`)
