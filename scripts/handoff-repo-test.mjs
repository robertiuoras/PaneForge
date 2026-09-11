// A lane branch can be deleted on origin by the trunk-contains rule
// (26d8dc33, "delete a remote lane branch once the trunk contains it")
// between a sender's push and a receiver's fetch - measured 2026-09-11 moving
// a pane from the PC back to the Mac: `git fetch origin lane-a` failed with
// "couldn't find remote ref lane-a" even though the commit was reachable on
// origin through main. `ensureRepo` (src/main/handoff.ts) must fall back to
// fetching/cloning the sha in that case, real git against a real bare origin.

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-handoffrepo-'))
let failures = 0
let checks = 0

function ok(what, cond, detail = '') {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function bundle() {
  const entry = join(out, 'entry.ts')
  const p = (rel) => JSON.stringify(join(root, rel).replace(/\\/g, '/'))
  writeFileSync(entry, [`export { ensureRepo } from ${p('src/main/handoff.ts')}`].join('\n'), 'utf8')
  const file = join(out, 'handoffrepo.mjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    outfile: file
  })
  return file
}

async function main() {
  const { ensureRepo } = await import(pathToFileURL(bundle()).href)

  // --- Case 1: lane-a deleted on origin, but its commit is reachable through main ---
  {
    const bare = join(out, 'origin1.git')
    const senderDir = join(out, 'sender1')
    const receiverRoot = join(out, 'receiver1-root')
    // ensureRepo maps senderRoot (with no dirRel) onto `root` directly, so the
    // receiver's checkout must live AT receiverRoot, not a subfolder of it.
    const receiverDir = receiverRoot

    git(out, 'init', '--bare', bare)
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(out, 'clone', bare, senderDir)
    git(senderDir, 'config', 'user.email', 'a@a.com')
    git(senderDir, 'config', 'user.name', 'a')
    writeFileSync(join(senderDir, 'f.txt'), 'one\n')
    git(senderDir, 'add', '.')
    git(senderDir, 'commit', '-m', 'init')
    git(senderDir, 'push', 'origin', 'HEAD:main')
    git(senderDir, 'checkout', '-b', 'lane-a')
    writeFileSync(join(senderDir, 'f.txt'), 'two\n')
    git(senderDir, 'commit', '-am', 'lane work')
    const sha = git(senderDir, 'rev-parse', 'HEAD')
    git(senderDir, 'push', 'origin', 'lane-a')

    // Trunk-contains rule: merge lane-a into main, push main, then delete the
    // remote lane-a branch - the exact sequence 26d8dc33 performs.
    git(senderDir, 'checkout', 'main')
    git(senderDir, 'merge', '--ff-only', 'lane-a')
    git(senderDir, 'push', 'origin', 'main')
    git(senderDir, 'push', 'origin', '--delete', 'lane-a')

    // Receiver starts on main, standing on the checkout ensureRepo will update.
    git(out, 'clone', bare, receiverDir)
    git(receiverDir, 'config', 'user.email', 'b@b.com')
    git(receiverDir, 'config', 'user.name', 'b')

    const err = await ensureRepo({ branch: 'lane-a', sha, url: bare, dirRel: undefined }, senderDir, receiverRoot)
    ok('reachable sha: ensureRepo returns no error', err === '', err)
    const headBranch = git(receiverDir, 'rev-parse', '--abbrev-ref', 'HEAD')
    const headSha = git(receiverDir, 'rev-parse', 'HEAD')
    ok('reachable sha: receiver lands on lane-a', headBranch === 'lane-a', headBranch)
    ok('reachable sha: receiver lands on the pushed commit', headSha === sha, `${headSha} vs ${sha}`)
  }

  // --- Case 2: lane-b deleted on origin, its commit never merged anywhere - unreachable ---
  {
    const bare = join(out, 'origin2.git')
    const senderDir = join(out, 'sender2')
    const receiverRoot = join(out, 'receiver2-root')
    const receiverDir = receiverRoot

    git(out, 'init', '--bare', bare)
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(out, 'clone', bare, senderDir)
    git(senderDir, 'config', 'user.email', 'a@a.com')
    git(senderDir, 'config', 'user.name', 'a')
    writeFileSync(join(senderDir, 'f.txt'), 'one\n')
    git(senderDir, 'add', '.')
    git(senderDir, 'commit', '-m', 'init')
    git(senderDir, 'push', 'origin', 'HEAD:main')
    git(senderDir, 'checkout', '-b', 'lane-b')
    writeFileSync(join(senderDir, 'f.txt'), 'orphaned\n')
    git(senderDir, 'commit', '-am', 'never merged')
    const sha = git(senderDir, 'rev-parse', 'HEAD')
    git(senderDir, 'push', 'origin', 'lane-b')
    git(senderDir, 'push', 'origin', '--delete', 'lane-b')
    // A local filesystem remote serves any object still on disk regardless of
    // reachability, unlike GitHub's upload-pack over the wire - prune it for
    // real so this case actually exercises "the commit is truly gone".
    git(bare, 'reflog', 'expire', '--expire=now', '--all')
    git(bare, 'gc', '--prune=now')

    git(out, 'clone', bare, receiverDir)
    git(receiverDir, 'config', 'user.email', 'b@b.com')
    git(receiverDir, 'config', 'user.name', 'b')

    const err = await ensureRepo({ branch: 'lane-b', sha, url: bare, dirRel: undefined }, senderDir, receiverRoot)
    ok('unreachable sha: ensureRepo refuses', err !== '')
    ok('unreachable sha: error names the branch', err.includes('lane-b'), err)
    ok('unreachable sha: error names the commit', err.includes(sha.slice(0, 8)), err)
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  rmSync(out, { recursive: true, force: true })
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
})
