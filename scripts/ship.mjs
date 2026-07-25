// One command to put a new build in everyone's hands:
//   npm run ship            -> 0.2.0 becomes 0.2.1
//   npm run ship minor      -> 0.2.1 becomes 0.3.0
//
// Bumps the version, commits, tags, pushes. GitHub Actions then builds Windows
// and macOS and publishes both to a Release, which is the same feed the running
// app polls - so everyone (including whoever you shared it with) is offered the
// update within half an hour, with no manual step.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

const kind = (process.argv[2] ?? 'patch').toLowerCase()
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error(`Unknown bump "${kind}". Use patch, minor or major.`)
  process.exit(1)
}

// A dirty tree would be committed wholesale by the bump commit below, which is
// almost never what you want when you meant to ship one feature.
const dirty = git('status', '--porcelain')
if (dirty) {
  console.error('Commit or stash your changes first:\n' + dirty)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [maj, min, pat] = pkg.version.split('.').map(Number)
const next =
  kind === 'major' ? `${maj + 1}.0.0` : kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

git('add', 'package.json')
git('commit', '-m', `release: v${next}`)
git('tag', `v${next}`)
git('push')
git('push', 'origin', `v${next}`)

const repo = pkg.build?.publish?.[0]
const url = repo ? `https://github.com/${repo.owner}/${repo.repo}/actions` : ''
console.log(`\nShipped v${next}. GitHub is building Windows and macOS now.`)
if (url) console.log(`Watch it: ${url}`)
console.log('Running copies will offer the update within 30 minutes.')
