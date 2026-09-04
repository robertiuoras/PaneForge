// Which folders under the projects root are projects, and which are copies of one.
//
// The launcher's list is the first thing a session touches, and on this desk half of it
// was lane worktrees: `PaneForge-a` beside `PaneForge`, `taskdriver.ai-a` and
// `taskdriver.ai-b` and `taskdriver-sessionA` beside `taskdriver.ai`. Sorted by recency
// the copies sit ABOVE the project they belong to, so the row you want is never the row
// on top.
//
// The rule being asserted here is that the fold is EVIDENCE-BASED. `-a` is a legitimate
// ending for a real project name, so hiding a repository called `service-a` because a
// `service` happens to exist next to it would be the worse bug: a project you cannot
// find at all, with nothing on screen to say why.

import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-projects-'))
let failures = 0
let checks = 0

function ok(what, cond, detail = '') {
  checks++
  if (cond) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

function bundle() {
  const entry = join(out, 'entry.ts')
  writeFileSync(
    entry,
    `export { checkoutOwners, worktreeParent } from ${JSON.stringify(
      join(root, 'src/shared/checkout.ts').replace(/\\/g, '/')
    )}\n`,
    'utf8'
  )
  const file = join(out, 'checkout.mjs')
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file })
  return file
}

const { checkoutOwners, worktreeParent } = await import(pathToFileURL(bundle()).href)

// git's own record, on both separator styles - a `.git` FILE says who owns the worktree.
ok(
  'a linked worktree names its project',
  worktreeParent('gitdir: /Users/r/Projects/PaneForge/.git/worktrees/PaneForge-a\n') === 'PaneForge'
)
ok(
  'and on Windows paths',
  worktreeParent('gitdir: C:\\Users\\Gamer\\Desktop\\Projects\\toolstash\\.git\\worktrees\\toolstash-a') === 'toolstash'
)
ok('a repository of its own names nobody', worktreeParent(null) === '')
ok('and neither does an unreadable pointer', worktreeParent('gitdir: /somewhere/else') === '')

// The real shape of this machine's Projects folder, from `ls ~/Projects` on 2026-08-13.
const owners = checkoutOwners([
  { name: 'PaneForge', isGit: true },
  { name: 'PaneForge-a', isGit: false, gitFile: 'gitdir: /Users/r/Projects/PaneForge/.git/worktrees/PaneForge-a' },
  { name: 'taskdriver.ai', isGit: true },
  // A lane whose worktree was pruned while the directory was left behind: no `.git` at
  // all, which is why the pointer alone is not enough to catch every copy.
  { name: 'taskdriver.ai-a', isGit: false },
  { name: 'taskdriver.ai-b', isGit: false, gitFile: 'gitdir: /Users/r/Projects/taskdriver.ai/.git/worktrees/x' },
  {
    name: 'taskdriver-sessionA',
    isGit: false,
    gitFile: 'gitdir: /Users/r/Projects/taskdriver.ai/.git/worktrees/taskdriver-sessionA'
  },
  { name: 'toolstash', isGit: true },
  { name: 'toolstash-a', isGit: false, gitFile: 'gitdir: /Users/r/Projects/toolstash/.git/worktrees/toolstash-a' },
  // Not a copy of anything: a repository in its own right whose name ends in `-a`.
  { name: 'service-a', isGit: true },
  { name: 'service', isGit: true },
  // Nor is a plain folder with no repository next to it.
  { name: 'videos', isGit: false },
  { name: 'work', isGit: false }
])

ok('a worktree folds under its project', owners.get('PaneForge-a') === 'PaneForge')
ok('so does one whose folder name says nothing', owners.get('taskdriver-sessionA') === 'taskdriver.ai')
ok('a pruned lane with no .git left is still caught', owners.get('taskdriver.ai-a') === 'taskdriver.ai')
ok('and a lettered one', owners.get('toolstash-a') === 'toolstash')
ok('a repository is never a copy, whatever it is called', !owners.has('service-a'), String(owners.get('service-a')))
ok('a project is not a copy of itself', !owners.has('PaneForge') && !owners.has('taskdriver.ai'))
ok('an ordinary folder is left alone', !owners.has('videos') && !owners.has('work'))
ok('nothing else was folded', owners.size === 5, [...owners.keys()].join(', '))

// A `-a` folder with no repository beside it is somebody's project, not a leftover.
const alone = checkoutOwners([
  { name: 'service-a', isGit: false },
  { name: 'notes', isGit: false }
])
ok('a suffix on its own proves nothing', alone.size === 0, [...alone.keys()].join(', '))

// The list is read from disk on every call, so the only way a project can be missing
// is the renderer never asking again. It used to ask once at startup, which means a
// repo created by an agent an hour into the session was absent from New Session until
// the app restarted - and restarting the app is the one thing that kills every pane.
// So the picker opening has to be a reason to re-read.
{
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  const m = app.match(/api\.listProjects\(\)\.then\(setProjects\)\s*\n\s*\}, \[([^\]]*)\]/)
  ok('the project list is fetched from an effect', Boolean(m), 'listProjects effect not found')
  ok(
    'and re-fetched when the picker opens, so a folder made mid-session appears',
    Boolean(m && /\bpicking\b/.test(m[1])),
    m ? `deps: [${m[1]}]` : 'no match'
  )
}

// A client is a row of its own, a level deeper than every other row in the list.
//
// `clients` is one folder under the projects root, so the launcher offered ONE row for
// the whole roster and picking it opened a pane in the parent of everybody's work.
// Robert, 2026-09-04: "i can make a clients session called alison and then when i click
// new session alison | clients would popup so i know that its part of clients".
{
  const stub = join(out, 'electron-stub.mjs')
  writeFileSync(stub, 'export const app = { getPath: () => "/tmp", isPackaged: false }\nexport default { app }\n', 'utf8')
  const file = join(out, 'projects.mjs')
  let built = true
  try {
    buildSync({
      absWorkingDir: root,
      entryPoints: [join(root, 'src/main/projects.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { electron: stub },
      outfile: file
    })
  } catch (e) {
    built = false
    ok('the project list builds without a window', false, String(e).slice(0, 200))
  }
  if (built) {
    const { listProjects } = await import(pathToFileURL(file).href)
    const desk = mkdtempSync(join(tmpdir(), 'pf-desk-'))
    mkdirSync(join(desk, 'PaneForge'), { recursive: true })
    mkdirSync(join(desk, 'clients', 'alison'), { recursive: true })
    mkdirSync(join(desk, 'clients', 'pia-team'), { recursive: true })
    writeFileSync(join(desk, 'clients', 'alison', 'README.md'), '# A4 Advocate (Adie Bradley)\n', 'utf8')
    writeFileSync(join(desk, 'clients', 'pia-team', 'README.md'), '# PIA Team\n', 'utf8')
    const rows = listProjects(desk)
    const alison = rows.find((r) => r.path === join(desk, 'clients', 'alison'))
    ok('a client on the roster is its own row', Boolean(alison), rows.map((r) => r.name).join(', '))
    ok('...named so the list says who it is AND where it lives', alison?.name === 'Adie Bradley | clients', alison?.name)
    ok('...and marked a client, so the launcher can go back to their pane', alison?.client === 'Adie Bradley', String(alison?.client))
    ok('every client gets a row, not just the first', rows.filter((r) => r.client).length === 2, String(rows.filter((r) => r.client).length))
    ok('an ordinary project is untouched', rows.some((r) => r.name === 'PaneForge' && !r.client))
    // The real shape on this desk: the client work is a repository of its own, and the
    // roster is the `clients` folder inside it - `Projects/clients/clients/<who>`.
    const nested = mkdtempSync(join(tmpdir(), 'pf-nested-'))
    mkdirSync(join(nested, 'clients', 'clients', 'a4-advocate'), { recursive: true })
    writeFileSync(join(nested, 'clients', 'clients', 'a4-advocate', 'README.md'), '# A4 Advocate\n', 'utf8')
    const deep = listProjects(nested).find((r) => r.client)
    ok('a roster one folder further in is found too', deep?.name === 'A4 Advocate | clients', deep?.name)
    // ...but a lane worktree of that repository carries the same roster, and listing it
    // too offered every client four times, all four rows reading the same words. 68 rows
    // for 17 people, in a real window, 2026-09-04.
    for (const lane of ['clients-a', 'clients-b']) {
      mkdirSync(join(nested, lane, 'clients', 'a4-advocate'), { recursive: true })
      writeFileSync(join(nested, lane, '.git'), 'gitdir: ../clients/.git/worktrees/' + lane, 'utf8')
      writeFileSync(join(nested, lane, 'clients', 'a4-advocate', 'README.md'), '# A4 Advocate\n', 'utf8')
    }
    mkdirSync(join(nested, 'clients', '.git'), { recursive: true })
    ok('a copy of that repository lists nobody twice', listProjects(nested).filter((r) => r.client).length === 1, String(listProjects(nested).filter((r) => r.client).length))
    rmSync(nested, { recursive: true, force: true })
    // A desk that does no client work must look exactly as it did.
    const plain = mkdtempSync(join(tmpdir(), 'pf-plain-'))
    mkdirSync(join(plain, 'Toolstash'), { recursive: true })
    ok('a root with no roster grows no rows', listProjects(plain).every((r) => !r.client))
    rmSync(desk, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
}

// ...and picking that row goes BACK to the pane already open in that folder, rather than
// opening a second one beside it.
{
  const dialog = readFileSync(join(root, 'src/renderer/src/components/NewSessionDialog.tsx'), 'utf8')
  ok('a client row asks to reuse the pane that is open', /reuse: proj\?\.client \? true : undefined/.test(dialog))
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  ok('...and main answers with the live pane in that folder', /if \(req\.reuse\)/.test(main) && /status !== 'exited'/.test(main))
}

rmSync(out, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
