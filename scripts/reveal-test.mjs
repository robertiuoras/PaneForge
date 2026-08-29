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
