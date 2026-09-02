// A copy of a project is out of Finder, and nothing else is.
//
// The rule is one line - `chflags hidden` on `<repo>-a` - and the whole risk is in the
// refusals: a folder called `service-a` is somebody's actual project, and hiding it would
// be an app quietly making a person's work disappear from the only place they look for it.
// So the flag is only ever set where a sibling by the un-suffixed name is a git repository.
//
// Run against real `chflags` on a real temp folder, read back with `ls -lO` - the flag is
// not in `fs.stat`, so a test that stubbed the call would prove nothing about the folder.
//
//   node scripts/lane-hidden-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const root = join(realpathSync(tmpdir()), 'paneforge-lane-hidden-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (cond, name, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const out = join(root, 'hideCopy.mjs')
buildSync({
  entryPoints: [join(repoRoot, 'src/main/hideCopy.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'silent'
})
const { hideCopyFolder, trunkBeside } = await import(pathToFileURL(out).href)

// --- the reading, on every platform -----------------------------------------------

mkdirSync(join(root, 'proj', '.git'), { recursive: true })
mkdirSync(join(root, 'proj-a'), { recursive: true })
mkdirSync(join(root, 'proj-w2'), { recursive: true })
mkdirSync(join(root, 'service-a'), { recursive: true }) // a real project, no sibling repo
mkdirSync(join(root, 'notes'), { recursive: true })

ok(
  trunkBeside(join(root, 'proj-a')) === join(root, 'proj'),
  'a copy beside a git repository is a copy of it'
)
ok(trunkBeside(join(root, 'proj-w2')) === join(root, 'proj'), 'a legacy w2 copy counts too')
ok(trunkBeside(join(root, 'service-a')) === null, '`service-a` with no `service` repo is a project')
ok(trunkBeside(join(root, 'proj')) === null, 'the project itself is never a copy of anything')
ok(trunkBeside(join(root, 'notes')) === null, 'a folder with no copy suffix is never a copy')

// --- the flag, where there is one ---------------------------------------------------

const flags = (dir) =>
  execFileSync('ls', ['-ldO', dir], { encoding: 'utf8' })
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
const hidden = (dir) => flags(dir).includes('hidden')

if (process.platform !== 'darwin') {
  console.log('SKIP  the hidden flag is macOS only - nothing on this platform to set')
} else {
  hideCopyFolder(join(root, 'proj-a'))
  hideCopyFolder(join(root, 'service-a'))
  hideCopyFolder(join(root, 'proj'))
  // execFile is fire-and-forget on purpose (a folder button may not wait on chflags), so
  // the flag arrives a moment later.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !hidden(join(root, 'proj-a'))) {
    execFileSync('sleep', ['0.05'])
  }
  ok(hidden(join(root, 'proj-a')), 'a copy is hidden from Finder', flags(join(root, 'proj-a')))
  ok(
    !hidden(join(root, 'service-a')),
    'a project that merely ends in `-a` is left alone',
    flags(join(root, 'service-a'))
  )
  ok(!hidden(join(root, 'proj')), 'the project itself is never hidden', flags(join(root, 'proj')))
  // Twice is a no-op, which is what lets `status` do this on every call.
  hideCopyFolder(join(root, 'proj-a'))
  ok(hidden(join(root, 'proj-a')), 'setting the flag again leaves it set')
}

// --- the wiring, so the rule keeps being applied where copies are made ---------------

const lanes = readFileSync(join(repoRoot, 'src/main/lanes.ts'), 'utf8')
ok(
  (lanes.match(/hideCopyFolder\(/g) ?? []).length >= 3,
  'every path in lanes.ts that hands back a lane folder hides it'
)
const mjs = readFileSync(join(repoRoot, 'scripts/lane.mjs'), 'utf8')
ok(/function hideLane\(id\)/.test(mjs), 'scripts/lane.mjs hides a lane of its own')
ok(
  /excludeModules\(dir\)\s*\n\s*hideLane\(id\)/.test(mjs),
  'a lane the script creates or repairs is hidden before it is handed back'
)
ok(
  /lanes: POOL\.map\(\(id\) => \{[\s\S]{0,400}?hideLane\(id\)/.test(mjs),
  'status hides every existing copy, so ones made earlier catch up'
)
ok(
  /id === 'main'/.test(mjs.slice(mjs.indexOf('function hideLane'), mjs.indexOf('function hideLane') + 600)),
  'the project`s own checkout is refused by name'
)

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} hidden-copy check(s) failed` : '\nall hidden-copy checks passed')
process.exit(failed ? 1 : 0)
