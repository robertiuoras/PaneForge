// `handoffFor` is asked several times per pane inside one sweepIdle tick (the chip, the
// countdown and the clear decision each read it separately), and until now every one of
// those calls re-validated the handoff on disk with its own `statSync`, even on a cache
// hit - the same shape of bug as the 402-reads/s sweepIdle fix (memory 2026-09-06), just
// cheaper per read: N calls in one tick cost N syscalls, not one.
//
// A syscall count cannot be observed from here - Node's ESM named imports of a builtin
// are static bindings, not live getters onto a mutable export object, so `node:fs` cannot
// be monkeypatched from a second module (verified 2026-09-07: reassigning the default
// export's `statSync` never reaches a sibling module's own `import { statSync }`). The
// throttle is proven the same way the reading itself is: by its OUTPUT. A call inside the
// throttle window must serve the reading it already had even after the file on disk has
// changed under it; a call past the window must pick the change up.
//
//   node scripts/handoff-stat-throttle-test.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `src/main/handoffSteps.ts` imports its shared half without an extension, which plain
// `node` cannot resolve on its own (TS/bundler-only resolution) - the same reason
// usage-test.mjs slices its file rather than importing it directly. The import line is
// rewritten to an absolute, extensioned path in a copy; everything else is the real source.
// Anchored on this file, never process.cwd() - the suite is run from several places.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sharedPath = join(root, 'src', 'shared', 'handoffSteps.ts').replace(/\\/g, '/')
const mainSrc = readFileSync(join(root, 'src', 'main', 'handoffSteps.ts'), 'utf8').replace(
  "from '../shared/handoffSteps'",
  `from 'file://${sharedPath}'`
)
const copyPath = join(tmpdir(), 'paneforge-handoffSteps-main-copy.ts')
writeFileSync(copyPath, mainSrc, 'utf8')
const { handoffFor, clearHandoffCache } = await import('file://' + copyPath.replace(/\\/g, '/'))
const { slugFor } = await import('file://' + sharedPath)

const home = join(tmpdir(), 'paneforge-handoff-throttle-test')
rmSync(home, { recursive: true, force: true })
const cwd = join(tmpdir(), 'paneforge-throttle-project')
const memDir = join(home, 'projects', slugFor(cwd), 'memory')
mkdirSync(memDir, { recursive: true })
const handoffPath = join(memDir, 'session-handoff.md')
writeFileSync(handoffPath, '# Handoff\n\n## Next steps\n\n1. Do the thing.\n')
process.env.PF_CLAUDE_HOME = home

const paneId = 's1-throttle'
clearHandoffCache()

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

const t0 = 1_000_000
ok('a cache miss finds the handoff', handoffFor(cwd, paneId, t0).open === 1)

// Rewrite the file on disk with a real, current mtime - a caller inside the throttle
// window must not notice, because it must not have stat-ed at all.
writeFileSync(handoffPath, '# Handoff\n\n## Next steps\n\n1. One.\n2. Two.\n')
ok(
  'a call inside STAT_THROTTLE_MS serves the reading it already had, unstat-ed',
  handoffFor(cwd, paneId, t0 + 10).open === 1
)
ok(
  'a second call still inside the window agrees - the file change is still unseen',
  handoffFor(cwd, paneId, t0 + 200).open === 1
)
ok(
  'a call past the throttle window re-validates and picks the change up',
  handoffFor(cwd, paneId, t0 + 400).open === 2
)

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
rmSync(copyPath, { force: true })

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  handoff-stat-throttle-test`)
process.exit(failed === 0 ? 0 : 1)
