// The measured half of "what is this desk costing" - the arithmetic and the parsers.
//
// Worth its own test because every failure here is a number a person acts on. A tree walk
// that stops at the pty reports 190 MB for a pane holding a 1442 MB build, so the wrong
// pane gets closed. A CPU percentage differenced against nothing reports a fresh agent at
// 3000% of a core for one tick, which is the reading that makes a readout untrustworthy
// for ever. And `ps -o time=` prints four different shapes depending on how long the
// process has run, so a parser tested only against the one shape a five-second-old agent
// prints will read a day-old one as zero.
//
//   node scripts/usage-test.mjs

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// capacity-test strips the annotations with regexes, because it predates Node being able
// to run TypeScript. This one imports the real source: type stripping is on by default
// from Node 22.18, which is below the version this app already requires, and a regex that
// survives generics and an object-literal return type is a worse thing to maintain than
// nothing at all. Stripping is not checking - `npm run typecheck` is what enforces types.
const { treeOf, summarise, formatMb, formatCpu, report } = await import(
  'file://' + join(root, 'src', 'shared', 'usage.ts').replace(/\\/g, '/')
)

// The main-process half imports electron, so only its pure parsers are lifted out: the two
// that turn a platform's output into rows, plus the `ps -o time=` reader they share. Sliced
// rather than imported for that reason, and sliced by the two markers below so that adding
// a parser to the file adds it here.
const dir = join(tmpdir(), 'paneforge-usage-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mainSrc = readFileSync(join(root, 'src', 'main', 'usage.ts'), 'utf8')
const from = mainSrc.indexOf('export function parseWindows')
const to = mainSrc.indexOf('/** One process table')
if (from < 0 || to < from) {
  console.log('FAIL  the parser slice markers in src/main/usage.ts have moved')
  process.exit(1)
}
const parsers = join(dir, 'parsers.ts')
// `UsageRow` survives only in annotations, which are stripped, so the slice needs no import.
writeFileSync(parsers, mainSrc.slice(from, to), 'utf8')
const { parseWindows, parsePosix, parseCpuTime, parseTopMem, mergeFootprint, dueForFootprint, FOOTPRINT_MS } =
  await import('file://' + parsers.replace(/\\/g, '/'))

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

// ---------------------------------------------------------------- the tree is the point

const row = (pid, ppid, rssKb, cpuMs) => ({ pid, ppid, rssKb, cpuMs })

// A real pane: pty -> shell -> agent -> the build the agent started, plus an unrelated
// process at the same depth that must never be counted.
const desk = [
  row(100, 1, 4_000, 0), // the pty
  row(101, 100, 8_000, 500), // its shell
  row(102, 101, 190_000, 20_000), // the agent
  row(103, 102, 1_442_000, 120_000), // what the agent started
  row(200, 1, 999_000, 5_000) // somebody else's browser
]

const tree = treeOf(desk, 100)
ok('the pane is its whole tree, root included', tree.length === 4, `got ${tree.length}`)
ok('and nothing outside it', !tree.some((r) => r.pid === 200))
ok('a pid that has gone reports no tree', treeOf(desk, 999).length === 0)

// The reason this file exists: counting the pty alone loses the build entirely.
const first = summarise(desk, [{ id: 'a', pid: 100 }], new Map(), 0)
ok('the pane reports the build it started', first.panes.a.rssMb > 1500, `got ${first.panes.a.rssMb}`)
ok('and says how many processes that is', first.panes.a.procs === 4)
ok('a first sample has no CPU figure, not a zero', first.panes.a.cpuPct === null)

// A pid whose parent points back up its own tree (Windows reuses pids) must not loop.
const looped = [row(10, 11, 1000, 0), row(11, 10, 1000, 0)]
ok('a cycle terminates', treeOf(looped, 10).length === 2)

// ---------------------------------------------------------------- CPU is a difference

const later = [
  row(100, 1, 4_000, 0),
  row(101, 100, 8_000, 500),
  row(102, 101, 190_000, 21_000), // +1s of CPU
  row(103, 102, 1_442_000, 127_000) // +7s of CPU
]
const second = summarise(later, [{ id: 'a', pid: 100 }], first.cpuNow, 4000)
ok('CPU is the delta over the interval', second.panes.a.cpuPct === 200, `got ${second.panes.a.cpuPct}`)
ok('a pane may exceed one core', second.panes.a.cpuPct > 100)

// A process that appears mid-flight brings a whole lifetime of CPU time with it. Charging
// that to one 4s interval is the 3000% reading this cap exists to stop.
const joined = [...later, row(104, 102, 50_000, 600_000)]
const third = summarise(joined, [{ id: 'a', pid: 100 }], second.cpuNow, 4000)
ok('a newly seen process cannot spike the reading', third.panes.a.cpuPct <= 100, `got ${third.panes.a.cpuPct}`)

// A reused pid whose counter went backwards is a different process, never a negative.
const reused = [row(100, 1, 4_000, 0), row(101, 100, 8_000, 10)]
const fourth = summarise(reused, [{ id: 'a', pid: 100 }], new Map([[101, 5_000]]), 4000)
ok('a counter that went backwards never reads negative', fourth.panes.a.cpuPct >= 0, `got ${fourth.panes.a.cpuPct}`)

// A pane whose pty is gone is absent, not zeroed: "0 MB" reads as a measurement.
const gone = summarise(later, [{ id: 'a', pid: 100 }, { id: 'b', pid: 555 }], first.cpuNow, 4000)
ok('a dead pane is absent rather than zero', gone.panes.b === undefined)

// ---------------------------------------------------------------- the totals

const full = report({ a: { rssMb: 1600, cpuPct: 200, procs: 4 }, b: { rssMb: 200, cpuPct: 5, procs: 2 } }, 250, 3, 16384)
ok('panes add up', full.panesMb === 1800)
ok('the total is panes plus the app', full.totalMb === 2050)
ok('CPU adds up across panes and the app', full.cpuPct === 208, `got ${full.cpuPct}`)
const empty = report({}, 250, 2, 16384)
ok('an empty desk still costs the app', empty.totalMb === 250)

// ---------------------------------------------------------------- what a person reads

ok('MB below a gigabyte', formatMb(860) === '860 MB', formatMb(860))
ok('GB above it, to one decimal', formatMb(1434) === '1.4 GB', formatMb(1434))
ok('the switch is at 1024', formatMb(1024) === '1.0 GB' && formatMb(1023) === '1023 MB')
ok('nothing to say prints nothing', formatCpu(null) === '' && formatCpu(0) === '')
ok('below 1% is silence, not a live-looking zero', formatCpu(0.4) === '')
ok('a busy pane prints its percentage', formatCpu(203) === '203%')

// ---------------------------------------------------------------- the platform parsers

// `ps -o time=` has four shapes, and only the last two appear on a machine that has been
// up for a day. A parser that reads from the left gets three of them wrong.
ok('mm:ss.cc', parseCpuTime('0:05.12') === 5120, parseCpuTime('0:05.12'))
ok('mm:ss', parseCpuTime('12:30') === 750_000, parseCpuTime('12:30'))
ok('hh:mm:ss', parseCpuTime('2:12:30') === 7_950_000, parseCpuTime('2:12:30'))
ok('dd-hh:mm:ss', parseCpuTime('1-04:11:09') === 101_469_000, parseCpuTime('1-04:11:09'))
ok('garbage is zero, never NaN', parseCpuTime('-') === 0 && !Number.isNaN(parseCpuTime('x')))

const posix = parsePosix(
  ['  100     1  4000 0:05.12', '  101   100  8000 12:30', 'ps: something went wrong', ''].join('\n')
)
ok('posix rows parse', posix.length === 2, JSON.stringify(posix))
ok('rss comes through in KB', posix[0].rssKb === 4000)
ok('and the noise line is dropped', !posix.some((r) => !Number.isFinite(r.cpuMs)))

const win = parseWindows(['100 1 4000 5120', '101 100 8000 750000', 'not a row', ''].join('\r\n'))
ok('windows rows parse', win.length === 2, JSON.stringify(win))
ok('windows carries pre-converted KB and ms', win[1].rssKb === 8000 && win[1].cpuMs === 750_000)

// -------------------------------------------------- the macOS memory column is not RSS

// `top -l 1 -stats pid,mem` prints a unit suffix and sometimes a growth marker. Every shape
// below has been seen on this desk; a parser that reads the digits and ignores the letter
// reports a 1.2 GB renderer as 1 KB.
const mem = parseTopMem(
  [
    'Processes: 574 total, 3 running',
    'PhysMem: 15G used (3449M wired, 3703M compressor), 458M unused.',
    'PID    MEM',
    '97657  1228M',
    '60944  578M ',
    '76065  13M+',
    '76085  4096K',
    '11215  1.2G',
    '99999  -',
    ''
  ].join('\n')
)
ok('megabytes', mem.get(97657) === 1228 * 1024, mem.get(97657))
ok('a trailing growth marker is not part of the number', mem.get(76065) === 13 * 1024, mem.get(76065))
ok('kilobytes stay kilobytes', mem.get(76085) === 4096, mem.get(76085))
ok('gigabytes, fractional', mem.get(11215) === Math.round(1.2 * 1048576), mem.get(11215))
ok('a row with no reading is left out, not zeroed', !mem.has(99999))
ok('the header lines are not processes', !mem.has(574) && !mem.has(15))

const merged = mergeFootprint(
  [row(100, 1, 4_000, 0), row(102, 101, 134_832, 20_000)],
  new Map([[102, 592_000]])
)
ok('a pid with a footprint reading uses it', merged[1].rssKb === 592_000, merged[1].rssKb)
ok('a pid without one keeps its RSS rather than vanishing', merged[0].rssKb === 4_000)
ok('an empty map changes nothing', mergeFootprint(merged, new Map())[1].rssKb === 592_000)

// ---------------------------------------------------------------------------
// How often the machine pays for `top`.
//
// Measured on this desk 2026-08-27, 840 processes: `top -l 1 -stats pid,mem` real
// 0.97-1.11s of which sys 0.82-1.04s, against 0.03-0.05s for the whole `ps` table. At
// SAMPLE_MS that was about a quarter of a core in the kernel, for ever. These pin the
// rule that stopped it - and the two cases that must still pay, because a footprint
// nobody refreshes is a readout that quietly stops being one.
const seen = new Set([10, 20, 30])

ok('the first sample always pays', dueForFootprint(1_000, 0, [10], seen))
ok(
  'a sample inside the window does not',
  !dueForFootprint(5_000, 1_000, [10, 20], seen)
)
ok(
  'the window is FOOTPRINT_MS and it is measured from the last READ',
  dueForFootprint(1_000 + FOOTPRINT_MS, 1_000, [10], seen)
)
ok(
  'one second under the window still does not pay',
  !dueForFootprint(1_000 + FOOTPRINT_MS - 1, 1_000, [10], seen)
)
ok(
  'a pane that opened since the last table forces one',
  dueForFootprint(2_000, 1_000, [10, 99], seen)
)
ok(
  'a pane that CLOSED since does not - there is nothing new to measure',
  !dueForFootprint(2_000, 1_000, [10], seen)
)
ok('no panes at all asks for nothing', !dueForFootprint(2_000, 1_000, [], seen))
ok(
  'an empty cache is a failed probe, not a fresh one',
  dueForFootprint(2_000, 1_000, [10], new Set())
)
ok('20s, not 20 minutes and not 2s', FOOTPRINT_MS === 20_000, String(FOOTPRINT_MS))
ok('the rows are not mutated in place', merged !== undefined && desk[2].rssKb === 190_000)

// The control, and the reason any of this exists: on a real Mac the two numbers DISAGREE,
// and RSS is the smaller one. Without this the parser could be perfect over a fixture while
// the app kept reporting half of what the machine is holding.
if (process.platform === 'darwin') {
  const { execFileSync } = await import('node:child_process')
  const read = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    } catch {
      return ''
    }
  }
  const live = parseTopMem(read('top', ['-l', '1', '-stats', 'pid,mem']))
  const rss = parsePosix(read('ps', ['-Ao', 'pid=,ppid=,rss=,time=']))
  ok('a real top is readable', live.size > 20, `${live.size} rows`)
  const both = rss.filter((r) => live.has(r.pid) && r.rssKb > 50_000)
  const bigger = both.filter((r) => live.get(r.pid) > r.rssKb * 1.2)
  ok(
    'and its memory column is bigger than RSS on real processes',
    both.length === 0 || bigger.length > 0,
    `${bigger.length} of ${both.length} big processes read higher than their RSS`
  )
} else {
  console.log('skip  the live macOS control (not darwin)')
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
