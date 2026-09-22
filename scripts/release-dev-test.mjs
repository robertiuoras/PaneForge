// Pure-logic checks for scripts/release-dev.mjs: the refusal predicates and the pass-line
// parser. No network, no git, no spawned child - see release-dev.mjs's header for why the
// parser distrusts the job runner's own "status" string.
import { strict as assert } from 'node:assert'
import { extractJobId, masterIsBehind, suitePassed, treeIsDirty } from './release-dev.mjs'

let failed = 0
const ok = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}

ok('clean tree is not dirty', !treeIsDirty(''))
ok('clean tree is not dirty (trailing newline only)', !treeIsDirty('\n'))
ok('a modified file is dirty', treeIsDirty(' M scripts/foo.mjs\n'))
ok('an untracked file is dirty', treeIsDirty('?? scripts/new.mjs\n'))

ok('0 behind is not behind', !masterIsBehind('0\n'))
ok('3 behind is behind', masterIsBehind('3\n'))
ok('unparsable count is not behind', !masterIsBehind('\n'))

ok('extracts a queued job id', extractJobId('{"id":"abc123","status":"queued"}') === 'abc123')
ok('extracts the last id when several objects appear', extractJobId('{"id":"first"}\nnoise\n{"id":"second","status":"queued"}') === 'second')
ok('no id when nothing matches', extractJobId('plain text, no json here') === null)

ok('exit 0 with pass line passes', suitePassed(0, 'ok  gate 1.0s\n254 tests passed in 90.0s\n'))
ok('exit 0 without a pass line fails', !suitePassed(0, 'ok  gate 1.0s\n'))
ok('exit 1 fails even with a pass-shaped line', !suitePassed(1, '254 tests passed in 90.0s\n'))
ok('a FAIL line fails the run even at exit 0', !suitePassed(0, 'FAIL  gate 1.0s\n\n  assertion text\n\n1 of 254 failed in 90.0s: gate\n'))
ok(
  'a runner status of "failed" is irrelevant - only exit code and the pass line count',
  suitePassed(0, '{"status":"failed: Root process exited while descendants remained"}\n254 tests passed in 90.0s\n')
)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nrelease-dev checks passed')
