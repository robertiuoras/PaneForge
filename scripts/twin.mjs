// Give a second agent its own checkout of PaneForge, so two chats can work at once.
//
//   npm run twin                 create/refresh ../claude-orchestrator-twin on branch `twin`
//   npm run twin -- --name=b     ../claude-orchestrator-b on branch `b`
//   npm run twin -- --remove     delete that checkout again (branch is kept)
//
// Why this exists: profiles (src/main/profile.ts) let two PaneForge windows run side by
// side, which stopped an agent from having to close the app it lives in. They do not
// help when two agents share ONE folder: both run `npm run build`, both write `out/`,
// and whoever launches second boots a half-written app. Nothing errors - the app is
// just wrong, and neither chat knows why.
//
// A git worktree is the cheap fix: same repository and history, separate files,
// separate `out/`, separate branch. node_modules is a junction back to the main
// checkout instead of a second `npm install` - Electron alone is ~300 MB, and the
// binary works fine through a link. The cost of that shortcut: `npm install` in either
// checkout is felt by both. That is the right trade while the two are the same commit
// range apart; run a real install in the twin if the dependency lists ever diverge.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const name = (args.find((a) => a.startsWith('--name='))?.split('=')[1] ?? 'twin').trim()

if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`Bad --name=${name}. Lowercase letters, digits and dashes only.`)
  process.exit(1)
}

const target = join(dirname(root), `${basename(root)}-${name}`)

function git(...a) {
  return spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', shell: false })
}

// A worktree cannot spawn worktrees off itself here: `git worktree add` would work, but
// the node_modules junction would chain through a link and the naming would nest
// (`...-twin-twin`). Always drive this from the main checkout.
if (lstatSync(join(root, '.git')).isFile()) {
  console.error('This is already a twin. Run `npm run twin` from the main checkout.')
  process.exit(1)
}

if (remove) {
  if (!existsSync(target)) {
    console.log(`Nothing to remove - ${target} does not exist.`)
    process.exit(0)
  }
  // --force because node_modules is a junction git did not put there, and any build
  // output in out/ is disposable by definition.
  const r = git('worktree', 'remove', '--force', target)
  if (r.status !== 0) {
    console.error(r.stderr.trim())
    process.exit(1)
  }
  console.log(`Removed ${target}. Branch "${name}" is untouched - its commits are still there.`)
  process.exit(0)
}

if (existsSync(target)) {
  console.log(`${target} already exists.`)
} else {
  const known =
    git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`).status === 0
      ? [name]
      : ['-b', name]
  const r = git('worktree', 'add', ...known, target)
  if (r.status !== 0) {
    console.error(r.stderr.trim())
    process.exit(1)
  }
  console.log(`Checked out branch "${name}" at ${target}`)
}

const link = join(target, 'node_modules')
if (existsSync(link)) {
  console.log('node_modules already linked.')
} else {
  // 'junction' needs no admin rights on Windows and survives reboots; on macOS/Linux
  // symlinkSync ignores the type and makes a plain directory symlink.
  symlinkSync(join(root, 'node_modules'), link, 'junction')
  console.log('node_modules linked to the main checkout (no second install).')
}

console.log(`
Second chat works here:  ${target}

  cd ${target}
  npm run try -- --minimized      opens as profile "dev-${name}"

Its build output, branch and PaneForge profile are all its own, so it cannot collide
with the main checkout. Merge it back with a normal PR, or:  git merge ${name}
Tear it down with:  npm run twin -- --name=${name} --remove`)
