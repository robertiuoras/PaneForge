// Every script we ship must be able to load once it is installed.
//
// build.extraResources copies scripts/ into the packaged app through an
// explicit filename whitelist. That whitelist is a second place to remember,
// and on 2026-08-15 commit 3cf9302 added scripts/lane-peers.mjs, imported at the
// top of lane.mjs, without adding it to the list. The repo was fine. Every
// INSTALLED copy had a lane.mjs that threw before its first statement:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\resources\scripts\
//   lane-peers.mjs' imported from ...\resources\scripts\lane.mjs
//
// lane.mjs is what the UserPromptSubmit, PreToolUse and SessionEnd hooks run, so
// the failure was not cosmetic: it fired on every prompt, in every session, on
// every machine that had updated, and it took a handed-off session down with it.
// Two days, invisible, because nothing in the repo can reproduce it — you have to
// look at what was packaged.
//
// So: resolve the transitive relative imports of every shipped entry point and
// assert each one is shipped too.
//
// Run: node scripts/ship-imports-test.mjs   (npm run test:shipimports)

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const entry = (pkg.build?.extraResources ?? []).find((r) => r.from === 'scripts')
if (!entry) {
  console.error('FAIL: package.json build.extraResources has no { from: "scripts" } entry')
  process.exit(1)
}

const shipped = new Set(entry.filter ?? [])
if (shipped.size === 0) {
  console.error('FAIL: the scripts extraResources entry ships nothing')
  process.exit(1)
}

/** Relative import specifiers in a file, static and dynamic. */
function relativeImports(source) {
  const out = new Set()
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bcreateRequire\([^)]*\)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) out.add(m[1])
  }
  return [...out]
}

const problems = []
const seen = new Set()
const queue = [...shipped]

while (queue.length > 0) {
  const name = queue.shift()
  if (seen.has(name)) continue
  seen.add(name)

  const file = join(repo, 'scripts', name)
  if (!existsSync(file)) {
    problems.push(`${name} is in the ship list but does not exist in scripts/`)
    continue
  }

  for (const spec of relativeImports(readFileSync(file, 'utf8'))) {
    const target = basename(spec)
    // Only same-directory imports end up under resources/scripts. Anything that
    // climbs out of scripts/ would not be packaged at all.
    if (!spec.startsWith('./')) {
      problems.push(`${name} imports '${spec}', which escapes scripts/ and is not packaged`)
      continue
    }
    if (!existsSync(join(repo, 'scripts', target))) {
      problems.push(`${name} imports '${spec}', which does not exist in scripts/`)
      continue
    }
    if (!shipped.has(target)) {
      problems.push(
        `${name} imports '${spec}' but ${target} is NOT in package.json build.extraResources ` +
          `-> the installed app throws ERR_MODULE_NOT_FOUND before running a single line`,
      )
      continue
    }
    queue.push(target)
  }
}

if (problems.length > 0) {
  console.error('Shipped scripts have unshippable imports:\n')
  for (const p of problems) console.error('  - ' + p)
  console.error(`\n${problems.length} problem(s)`)
  process.exit(1)
}

console.log(`ok: ${seen.size} shipped script(s), every relative import is shipped too`)
