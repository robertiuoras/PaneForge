// "Open folder" from a pane in a COPY opens the project, never the copy.
//
// A copy (`PaneForge-a`, legacy `clients-w2`) is a second checkout the app made. Its
// branch is merged back and its untracked files are swept with it, so a file dropped in
// there is a file that disappears - and nobody typed its name, so nobody can be expected
// to know which of five near-identical folders they are looking at. Both buttons on a
// pane, Explorer and editor, therefore resolve to the project first.
//
// git is the reading, and the folder name is only the fallback for when git cannot be
// asked at all - the case that used to answer "this folder", silently, which is the copy.
//
//   node scripts/project-folder-test.mjs

import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const root = join(realpathSync(tmpdir()), 'paneforge-project-folder-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

// Bundled rather than imported: projectRoot.ts reaches into src/shared, and node's own
// type stripping wants every import to carry its extension.
const bundle = join(root, 'projectRoot.mjs')
buildSync({
  entryPoints: [join(repoRoot, 'src/main/projectRoot.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'silent'
})
const { projectRoot, trunkBeside } = await import(pathToFileURL(bundle).href)

let failed = 0
const ok = (cond, name, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}
const is = (got, want, name) => ok(got === want, name, `got ${got}\n      want ${want}`)

// --- the name reading, and what it refuses -------------------------------------------

mkdirSync(join(root, 'proj', '.git'), { recursive: true })
mkdirSync(join(root, 'proj-a'), { recursive: true })
mkdirSync(join(root, 'proj-w2'), { recursive: true })
mkdirSync(join(root, 'service-a'), { recursive: true }) // a real project: no `service` repo
mkdirSync(join(root, 'notes'), { recursive: true })

is(trunkBeside(join(root, 'proj-a')), join(root, 'proj'), 'a copy names the project beside it')
is(trunkBeside(join(root, 'proj-w2')), join(root, 'proj'), 'a legacy w2 copy counts the same')
is(trunkBeside(join(root, 'service-a')), null, '`service-a` with no `service` repo is a project')
is(trunkBeside(join(root, 'proj')), null, 'the project itself is a copy of nothing')
is(trunkBeside(join(root, 'notes')), null, 'a folder with no copy suffix is never a copy')

// --- the fallback, which is the case that used to open the copy --------------------

// The fallback: a copy git cannot answer about (no registration, no repo of its own) still
// resolves, because the sibling on disk proves it. This is the case that used to open the
// copy - `read()` returns the folder it was handed for every failure it has.
is(await projectRoot(join(root, 'proj-a')), join(root, 'proj'), 'a copy git cannot see still opens the project')
is(await projectRoot(join(root, 'service-a')), join(root, 'service-a'), 'a project ending in `-a` opens itself')
is(await projectRoot(join(root, 'notes')), join(root, 'notes'), 'a plain folder opens itself')

// --- the wiring: BOTH buttons on a pane, not just the Explorer one ---------------------

const index = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
const editor = index.slice(index.indexOf("ipcMain.handle('shell:editor'"), index.indexOf("ipcMain.handle('git:info'"))
ok(/await projectRoot\(/.test(editor), 'the editor button resolves the project first')
ok(
  /const root = await projectRoot\(cwd \?\? ''\)/.test(index),
  'the Explorer button resolves the project first'
)
// A path an agent PRINTED is a path, not a pane: it opens exactly what it says.
const reveal = index.slice(index.indexOf("ipcMain.on('shell:reveal'"), index.indexOf("shell:pathKind"))
ok(!/projectRoot/.test(reveal), 'a printed path still opens exactly where it points')

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} project-folder check(s) failed` : '\nall project-folder checks passed')
process.exit(failed ? 1 : 0)
