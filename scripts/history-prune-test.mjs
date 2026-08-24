// What transcripts are allowed to cost.
//
// The age cutoff was the only bound there had ever been, and it is not a bound on SIZE:
// how much 30 days weighs is entirely a question of how much the panes printed. Measured
// on a Mac 2026-08-07 - 139 transcripts, 155 MB, every one inside the window and so every
// one untouched. Deleting somebody's transcripts is not a thing to get wrong in either
// direction, so both rules are pinned here: what age removes, what size removes, and that
// the newest is never the one that goes.
//
//   node scripts/history-prune-test.mjs

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-history-prune-test-'))
const userData = join(work, 'userData')
const dir = join(userData, 'history')
mkdirSync(dir, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')}}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/history.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'history.bundle.cjs'),
  alias: { electron: join(work, 'electron-stub.cjs') }
})

const h = createRequire(join(work, 'x.cjs'))('./history.bundle.cjs')

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}

const MB = 1024 * 1024
const DAY = 86_400_000

/** One transcript: the meta the list reads, and a log of the size it claims. */
function make(id, ageDays, mb) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, startedAt: Date.now() - ageDays * DAY, title: id }))
  writeFileSync(join(dir, `${id}.log`), Buffer.alloc(mb * MB, 1))
}
const ids = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()

// --- age ---------------------------------------------------------------------------
make('young', 1, 1)
make('old', 40, 1)
h.prune(30)
ok(ids().join() === 'young', 'a transcript past the age cutoff goes', ids().join())

// --- size, with the age rule satisfied by every one of them -------------------------
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
// 700 MB of transcripts, none of them old enough for `days` to touch: 7 x 100 MB, newest
// first. The cap is 512 MB, so five fit (500) and the sixth would cross it.
for (let i = 0; i < 7; i++) make(`s${i}`, i, 100)
h.prune(30)
ok(ids().join() === 's0,s1,s2,s3,s4', 'the oldest go until the total is under the cap', ids().join())
ok(ids().includes('s0'), 'and the newest is never the one deleted', ids().join())

// --- "keep forever" is an answer about AGE ------------------------------------------
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
make('ancient', 4000, 1)
make('yesterday', 1, 1)
h.prune(0)
ok(ids().join() === 'ancient,yesterday', 'days = 0 keeps a transcript of any age', ids().join())

// ...but it is not an answer about size. Same setting, now past the cap.
for (let i = 0; i < 7; i++) make(`k${i}`, i + 1, 100)
h.prune(0)
ok(!ids().includes('ancient'), 'and the size cap still applies with it set', ids().join())

// --- a row whose folder is gone says so ---------------------------------------------
// "Open again" on such a row did nothing at all: main's start loop catches a missing
// folder per request, so the row was silently not started. Most of this list on a real
// desk is temp folders from tests and swept lane worktrees, so this is the COMMON case.
// Computed on every read, never stored - a folder can come back.
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const here = join(work, 'a-real-folder')
mkdirSync(here, { recursive: true })
writeFileSync(
  join(dir, 'live.json'),
  JSON.stringify({ id: 'live', startedAt: Date.now(), title: 'live', cwd: here })
)
writeFileSync(
  join(dir, 'dead.json'),
  JSON.stringify({ id: 'dead', startedAt: Date.now() - 1000, title: 'dead', cwd: join(work, 'deleted-lane') })
)
const rows = h.list()
const row = (id) => rows.find((r) => r.id === id)
ok(row('live') && row('live').gone === false, 'a folder that is still there is openable', JSON.stringify(row('live')))
ok(row('dead') && row('dead').gone === true, 'a folder that has been deleted is marked gone', JSON.stringify(row('dead')))
// The transcript is still the reason to keep the row, so nothing is hidden or pruned for
// being unopenable - only the button changes.
ok(rows.length === 2, 'and the row itself is kept - its output is still readable', rows.length)

// --- a row written with the whole agent SPEC where its id belongs -------------------
// Two of these are on this machine (a `shell` spec, 2026-08-23). Every later reader
// expects a string: `agents.find((a) => a.id === e.agent)` misses, and the logo's
// `(spec?.label ?? id).replace(...)` threw a TypeError that unmounted the whole renderer,
// so History would not open at all. Repaired on the way out of `list()`.
writeFileSync(
  join(dir, 'spec.json'),
  JSON.stringify({
    id: 'spec',
    startedAt: Date.now(),
    title: 'spec',
    cwd: here,
    agent: { id: 'shell', label: 'Shell', bin: 'bash' }
  })
)
const fixed = h.list().find((r) => r.id === 'spec')
ok(typeof fixed?.agent === 'string', 'an agent stored as an object is read back as its id', JSON.stringify(fixed?.agent))
ok(fixed?.agent === 'shell', 'and it is the id, not a stringified object', fixed?.agent)

// The renderer half of the same defect: a mark is decoration and may never be the thing
// that takes the window down, whatever a persisted record holds.
const logo = readFileSync(join(root, 'src/renderer/src/components/AgentLogo.tsx'), 'utf8')
ok(
  !/\(spec\?\.label \?\? id\)\.replace/.test(logo),
  'AgentLogo does not call .replace on a value it has not proved is a string'
)

rmSync(work, { recursive: true, force: true })
console.log(fail.length ? `\n${fail.length} failed` : '\nall passed')
process.exit(fail.length ? 1 : 0)
