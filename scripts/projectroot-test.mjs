// What "open the folder" resolves to for a pane, against REAL git checkouts.
//
// The load-bearing half is the negatives: a plain checkout, a folder with no git in it
// and a project whose real name ends in `-a` must every one come back unchanged. A name
// rule passes the worktree case and fails all three, which is why this is read from git.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'pf-projroot-'))
// Bundled rather than imported: projectRoot.ts reads the copy shapes out of src/shared,
// and node's own type stripping wants every import to carry its extension.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleOut = join(root, 'projectRoot.mjs')
buildSync({
  entryPoints: [join(repoRoot, 'src/main/projectRoot.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundleOut,
  logLevel: 'silent'
})
const { projectRoot } = await import(pathToFileURL(bundleOut).href)
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim()

let failed = 0
// macOS hands back /var and git answers /private/var: the same folder, spelled twice.
const real = (p) => {
  try {
    return realpathSync(String(p))
  } catch {
    return resolve(String(p))
  }
}
const eq = (name, got, want) => {
  const ok = real(got) === real(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${got}\n     want ${want}`}`)
}

try {
  // A trunk checkout with one worktree beside it, exactly as a lane is made.
  const trunk = join(root, 'demo')
  mkdirSync(trunk)
  git(trunk, 'init', '-q', '-b', 'main')
  git(trunk, 'config', 'user.email', 't@t')
  git(trunk, 'config', 'user.name', 't')
  writeFileSync(join(trunk, 'a.txt'), 'x')
  git(trunk, 'add', '-A')
  git(trunk, 'commit', '-qm', 'first')

  const lane = join(root, 'demo-a')
  git(trunk, 'worktree', 'add', '-q', '-b', 'lane-a', lane)

  eq('a lane opens its trunk', await projectRoot(lane), trunk)
  eq('the trunk opens itself', await projectRoot(trunk), trunk)

  // A worktree whose folder name says nothing - the case a name rule cannot see at all.
  const slug = join(root, 'worktree-feature-x')
  git(trunk, 'worktree', 'add', '-q', '-b', 'wt-slug', slug)
  eq('a worktree named nothing like the repo still opens its trunk', await projectRoot(slug), trunk)

  // NEGATIVES.
  const plain = join(root, 'service-a')
  mkdirSync(plain)
  git(plain, 'init', '-q', '-b', 'main')
  git(plain, 'config', 'user.email', 't@t')
  git(plain, 'config', 'user.name', 't')
  writeFileSync(join(plain, 'a.txt'), 'x')
  git(plain, 'add', '-A')
  git(plain, 'commit', '-qm', 'first')
  eq('a project really called -a is left alone', await projectRoot(plain), plain)
  // ...even with a repo by the un-suffixed name beside it, which is the one shape the
  // name fallback would get wrong. git answers here, so the name never gets a say.
  const sibling = join(root, 'service')
  mkdirSync(sibling)
  git(sibling, 'init', '-q', '-b', 'main')
  eq('and still left alone with a `service` repo beside it', await projectRoot(plain), plain)

  const bare = join(root, 'notes')
  mkdirSync(bare)
  eq('a folder with no git in it is left alone', await projectRoot(bare), bare)

  eq('a folder that is not there is left alone', await projectRoot(join(root, 'gone')), join(root, 'gone'))
  eq('an empty path is handed back', await projectRoot(''), '')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
