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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

rmSync(out, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
