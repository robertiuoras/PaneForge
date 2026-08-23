// The version this repo says it is, in both places that say it.
//
// `package-lock.json` carries the version twice (top level, and `packages[""]`), and the
// automatic release only ever rewrote `package.json` - so the lockfile had drifted NINE
// releases behind the tag (0.8.105 against 0.8.114) and nothing anywhere said so. That is
// the shape of defect this repo keeps meeting: not a crash, an answer that is quietly
// wrong for every tool that asks the lockfile what version it is holding.
//
// The bump is in scripts/lane.mjs now. This is the part that makes it stay true.
//
//   node scripts/version-sync-test.mjs

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (cond, what, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` - ${detail}` : ''}`)
  if (!cond) failures++
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockPath = join(root, 'package-lock.json')

ok(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'package.json has a version', pkg.version)

if (!existsSync(lockPath)) {
  console.log('ok    no package-lock.json in this checkout - nothing to keep in step')
} else {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  ok(lock.version === pkg.version, 'the lockfile agrees with the manifest', `lock ${lock.version} vs package ${pkg.version}`)
  ok(
    lock.packages?.['']?.version === pkg.version,
    "the lockfile's own root package agrees too",
    `lock packages[""] ${lock.packages?.['']?.version} vs package ${pkg.version}`
  )
}

console.log(failures ? `\n${failures} failed` : '\nall version-sync checks passed')
process.exit(failures ? 1 : 0)
