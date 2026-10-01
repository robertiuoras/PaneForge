// npm run test:pressurelog
//
// pressure.log's pure half, fed REAL output captured on this Mac (2026-10-01, 21 leaked
// `caffeinate -i -w 70914` children under PaneForge pid 70914): scripts/fixtures/pressure-ps.txt
// is a cut of `ps -Ao pid=,ppid=,rss=,pcpu=,comm=`, pressure-swap.txt is `sysctl vm.swapusage`.
import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pressurelog-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'p.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/pressureLog.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const { parsePsTable, parseSwapUsedMb, buildPressureLine, PS_ARGS, pressureLogRuns } = createRequire(import.meta.url)(outfile)
const fx = (n) => readFileSync(join(root, 'scripts/fixtures', n), 'utf8')

const rows = parsePsTable(fx('pressure-ps.txt'))
const raw = fx('pressure-ps.txt').split('\n').filter((l) => l.trim()).length
assert.equal(rows.length, raw, 'every real ps row parses, including paths with spaces')
assert.deepEqual(PS_ARGS, ['-Ao', 'pid=,ppid=,rss=,pcpu=,comm='])
assert.equal(pressureLogRuns('win32'), false, 'Windows has no ps: the sampler never starts there')
assert.equal(pressureLogRuns('darwin'), true)
assert.equal(pressureLogRuns('linux'), true)
// and the sampler really asks before its first ps
const sampler = readFileSync(join(root, 'src/main/pressureLog.ts'), 'utf8')
assert.ok(/startPressureLog[^{]*\{\s*if \(!pressureLogRuns\(platform\(\)\)\) return/.test(sampler), 'startPressureLog returns a no-op on Windows first')
const launchd = rows.find((r) => r.pid === 1)
assert.equal(launchd.comm, '/sbin/launchd')
assert.ok(rows.some((r) => / /.test(r.comm)), 'the fixture really has a command with a space in it')

assert.equal(parseSwapUsedMb(fx('pressure-swap.txt')), 7266)
assert.equal(parseSwapUsedMb('vm.swapusage: total = 2.00G  used = 1.50G  free = 0.50G'), 1536)
assert.equal(parseSwapUsedMb(''), null)

const line = buildPressureLine({
  at: Date.UTC(2026, 9, 1, 7, 30),
  kernel: 'warn',
  compressor: 'normal',
  loadavg1: 8.7,
  cores: 10,
  compressorMb: 6470,
  swapUsedMb: 7266,
  ownPid: 70914,
  panes: [
    { id: 's1', pid: 14102, status: 'working' },
    { id: 's2', pid: 17238, status: 'idle' },
    { id: 's3', pid: 999999, status: 'exited' }
  ],
  rows
})
assert.equal(line.ts, '2026-10-01T07:30:00.000Z')
assert.deepEqual(line.pressure, { kernel: 'warn', compressor: 'normal' })
assert.equal(line.loadPerCore, 0.87)
assert.equal(line.swapUsedMb, 7266)
assert.equal(line.compressorMb, 6470)
const s1 = line.panes[0]
// pid 14102 (227792 KB) plus its own caffeinate child 4127 (320 KB) = 228112 KB = 223 MB
assert.equal(s1.rssMb, 223)
assert.equal(s1.status, 'working')
assert.equal(line.panes[2].alive, false, 'a pane whose pid is not in the table says so')
// the 21 leaked caffeinate children of the app itself, but NOT the one inside pane 14102's tree
const leaked = rows.filter((r) => r.ppid === 70914 && /caffeinate$/.test(r.comm)).length
assert.ok(leaked >= 20, `fixture holds the real leak (${leaked})`)
assert.equal(line.caffeinateChildren, leaked)
assert.equal(line.top.length, 5)
assert.ok(!line.top.some((t) => t.pid === 14102 || t.pid === 17238), 'pane processes are not in the non-pane top 5')
assert.ok(line.top.every((t, i, a) => i === 0 || a[i - 1].rssMb >= t.rssMb), 'sorted by memory')
JSON.parse(JSON.stringify(line))
console.log('pressurelog: ok')
