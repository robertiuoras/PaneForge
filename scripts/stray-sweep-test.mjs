// The processes a pane leaves running, and the sweep that kills them.
//
// Two halves. The first is the bookkeeping, as pure functions, checked without killing
// anything. The second spawns REAL orphans - a parent that starts a child and exits, which
// is what `npm run dev` looks like from outside - and proves both directions on them: the
// orphan dies, and a bystander that only shares its shape does not.
//
//   node scripts/stray-sweep-test.mjs
//
// Nothing here touches a process it did not start. Every victim is a `node -e` this file
// spawned, and every pid it hands to a kill came back out of its own snapshot.

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tsc = (await import('typescript')).default
const data = mkdtempSync(join(tmpdir(), 'pf-strays-'))

/** Load a main-process module with electron stubbed and everything else real. */
function load(rel, extra = {}) {
  const js = tsc.transpileModule(readFileSync(join(root, rel), 'utf8'), {
    compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
  }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', js)(
    (id) => (id === 'electron' ? { app: { getPath: () => data } } : (extra[id] ?? require(id))),
    mod,
    mod.exports
  )
  return mod.exports
}

// The REAL windowless launcher, not a stand-in. A plain `spawn(..., { detached: true })`
// of powershell is accepted and then silently never runs on this Windows build - measured
// here, and the reason consoles.ts goes through wscript + Shell.Run at all. Stubbing it
// would have tested a path the app does not use and passed while the app leaked.
const consoles = load('src/main/consoles.ts')
const mod = load('src/main/strays.ts', { './consoles': consoles })

const {
  childIndex,
  descendantsOf,
  mergeStrays,
  victims,
  deadRuns,
  reapStraysScript,
  reapStraysSh,
  parseSnapshot,
  parsePosixSnapshot,
  snapshot,
  reapDetached,
  trackStrays,
  sampleOnce,
  sweepOldStrays,
  readLedger,
  MAX_TRACKED
} = mod

const WIN = process.platform === 'win32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const table = () => new Promise((r) => snapshot(r))

// ---------------------------------------------------------------------------
// 1. The bookkeeping
// ---------------------------------------------------------------------------

// A tree the app can still see: app -> pty -> npm -> vite.
const linked = [
  { pid: 100, ppid: 1, started: 'a', name: 'PaneForge.exe' },
  { pid: 200, ppid: 100, started: 'b', name: 'claude.exe' },
  { pid: 300, ppid: 200, started: 'c', name: 'npm.exe' },
  { pid: 400, ppid: 300, started: 'd', name: 'node.exe' }
]
assert.deepEqual(
  descendantsOf(linked, [200]).map((p) => p.pid),
  [300, 400],
  'a live chain is walked to the leaf'
)
assert.equal(childIndex(linked).get(200)[0].pid, 300)

// THE reason this file exists. Take the middle process away - npm exited, or the app died
// and took the pty with it - and the leaf is no longer reachable from any root. Nothing at
// kill time can find it, which is why it has to have been written down before.
const broken = linked.filter((p) => p.pid !== 300)
assert.deepEqual(descendantsOf(broken, [200]).map((p) => p.pid), [], 'an orphan is unreachable by tree walk')
assert.deepEqual(descendantsOf(broken, [100]).map((p) => p.pid), [200], 'and stays unreachable from further up')

// So the union across samples is the thing that keeps it. Seen once while its parent was
// alive, remembered after.
const sample1 = descendantsOf(linked, [200]).map(({ pid, started, name }) => ({ pid, started, name }))
const sample2 = descendantsOf(broken, [200]).map(({ pid, started, name }) => ({ pid, started, name }))
const remembered = mergeStrays(sample1, sample2)
assert.deepEqual(remembered.map((r) => r.pid), [300, 400], 'a sample that lost sight of it does not forget it')

// Same process twice is one record; a REUSED pid is a second one, because the pair is the
// identity and only one of the two can survive the check at kill time.
assert.equal(mergeStrays(sample1, sample1).length, 2)
assert.equal(mergeStrays(sample1, [{ pid: 400, started: 'LATER', name: 'node.exe' }]).length, 3)

// Bounded, newest kept, so a week-old sampler cannot grow a file the launch has to read.
const many = Array.from({ length: MAX_TRACKED + 40 }, (_, i) => ({ pid: i + 1, started: 's', name: 'n' }))
const capped = mergeStrays([], many)
assert.equal(capped.length, MAX_TRACKED)
assert.equal(capped.at(-1).pid, MAX_TRACKED + 40)

// A ppid loop (a reused pid can close one) must not hang the sampler.
const loop = [
  { pid: 10, ppid: 11, started: 'a', name: 'a' },
  { pid: 11, ppid: 10, started: 'b', name: 'b' }
]
assert.deepEqual(descendantsOf(loop, [10]).map((p) => p.pid), [11], 'a cycle terminates')

// The safety property. A recorded pid is killed only while it is still the same process.
const recorded = [{ pid: 400, started: 'd', name: 'node.exe' }]
assert.deepEqual(victims(recorded, linked).map((r) => r.pid), [400], 'alive and unchanged: a victim')
assert.deepEqual(
  victims(recorded, [{ pid: 400, ppid: 1, started: 'SOMETHING ELSE', name: 'chrome.exe' }]),
  [],
  'the pid came back as another process: left alone'
)
assert.deepEqual(victims(recorded, []), [], 'already gone: nothing to do')
assert.deepEqual(victims(recorded, linked, [400]), [], 'exempt pids are never victims')

// Another copy of PaneForge is still running: its records are its own business.
const ledger = { runs: { 100: [{ pid: 1, started: 'x', name: 'y' }], 999: [] } }
assert.deepEqual(deadRuns(ledger, [100, 7]), ['999'], 'a run whose app is alive is not swept')
assert.deepEqual(deadRuns(ledger, []).sort(), ['100', '999'])

// The script re-checks the creation time itself rather than trusting the ledger, and it
// can never name our own image - a tidy-up that can close the app you are sitting in is
// the failure this whole area already had once (see consoles.ts).
const script = reapStraysScript([{ pid: 11, started: '13300000', name: 'node.exe' }], 900)
assert.match(script, /Start-Sleep -Milliseconds 900/)
assert.match(script, /'11'='13300000'/)
assert.match(script, /CreationDate\.ToFileTimeUtc\(\)/)
assert.match(script, /\$want\.ContainsKey\(\[string\]\$_\.ProcessId\)/)
assert.match(script, /Stop-Process -Id \$_\.ProcessId -Force/)
assert.doesNotMatch(script, /PaneForge|electron/i)
assert.match(reapStraysScript([{ pid: 5, started: '1' }], 12.7), /Start-Sleep -Milliseconds 13/)

// The POSIX half has to format lstart exactly the way the snapshot parser did, or every
// kill off Windows is skipped forever as a pid-reuse and nothing ever says so.
const posix = parsePosixSnapshot('  42   1 Sat Aug  2 09:15:00 2026 node\n')
assert.equal(posix[0].pid, 42)
assert.equal(posix[0].started, 'Sat_Aug_2_09:15:00_2026')
assert.match(reapStraysSh([posix[0]], 0), /\[ "\$s" = "Sat_Aug_2_09:15:00_2026" \]/)
assert.match(reapStraysSh([posix[0]], 0), /kill -9 42/)

// Junk out of a half-written table is not a pid.
assert.deepEqual(parseSnapshot('not a line\n0 0 x y\n7 7 x self-parent\n'), [])
assert.equal(parseSnapshot('7 1 133 node.exe\n')[0].name, 'node.exe')

console.log('stray-sweep-test: bookkeeping OK')

// ---------------------------------------------------------------------------
// 2. Real orphans
// ---------------------------------------------------------------------------

const alive = async (pid) => (await table()).some((p) => p.pid === pid)
const idle = 'setInterval(() => {}, 1e9)'

/** A child that outlives the parent that started it - `npm run dev`, from outside. */
function orphanMaker() {
  // The parent spawns a detached grandchild, prints its pid, and exits immediately. What
  // is left is a live process whose ParentProcessId names a pid that no longer exists.
  const code = `
    const { spawn } = require('node:child_process')
    const kid = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], {
      detached: true, stdio: 'ignore', windowsHide: true
    })
    kid.unref()
    console.log(kid.pid)
    process.exit(0)
  `
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', reject)
    p.on('exit', () => {
      const pid = Number(out.trim())
      pid > 0 ? resolve({ pid, parent: p.pid }) : reject(new Error(`no pid from the maker: ${out}`))
    })
  })
}

const orphan = await orphanMaker()
const bystander = spawn(process.execPath, ['-e', idle], { detached: true, stdio: 'ignore', windowsHide: true })
bystander.unref()
await sleep(1200)

let procs = await table()
if (!procs.length) {
  console.log('stray-sweep-test: SKIP the live half - no process table available here')
  try {
    process.kill(orphan.pid)
  } catch {}
  try {
    process.kill(bystander.pid)
  } catch {}
  process.exit(0)
}

const orphanRow = procs.find((p) => p.pid === orphan.pid)
const bystanderRow = procs.find((p) => p.pid === bystander.pid)
assert.ok(orphanRow, 'the orphan is running')
assert.ok(bystanderRow, 'the bystander is running')

// The measurement this whole feature is built on, and it is not the one that is easy to
// assume. Windows KEEPS the ParentProcessId field after the parent dies - it is a number,
// not a link - so the orphan is still listed as that dead pid's child:
assert.equal(procs.some((p) => p.pid === orphan.parent), false, 'the middle process really exited')
assert.deepEqual(
  descendantsOf(procs, [orphan.parent]).map((p) => p.pid),
  [orphan.pid],
  'the dead parent is still named by its child'
)

// What breaks is the WALK. This test process is the root - the pty, in the real thing -
// and the middle process is gone from the table, so there is no row joining the root to
// the leaf and a tree walk from the root stops short. This is `npm run dev` exactly: npm
// exits, vite keeps going, and `taskkill /F /T <ptyPid>` never reaches it.
const fromRoot = descendantsOf(procs, [process.pid]).map((p) => p.pid)
assert.equal(fromRoot.includes(orphan.pid), false, 'a real orphan is unreachable from the live root')
assert.equal(await alive(orphan.pid), true, 'while being very much alive')

// And the dead middle pid is no use as a kill root either, however well the table
// remembers it: taskkill needs the process to exist before it will walk anything.
if (WIN) {
  const rc = await new Promise((r) => {
    const t = spawn('taskkill', ['/F', '/T', '/PID', String(orphan.parent)], { windowsHide: true, stdio: 'ignore' })
    t.on('exit', r)
    t.on('error', () => r(-1))
  })
  assert.notEqual(rc, 0, 'taskkill refuses a pid that no longer exists')
  assert.equal(await alive(orphan.pid), true, 'so the orphan survives the only kill the app had')
}

// Now the sweep, from what was written down. The bystander is in the list too, with the
// creation time of a process that no longer exists - the pid-reuse case, and the one that
// must survive.
reapDetached(
  [
    { pid: orphanRow.pid, started: orphanRow.started, name: orphanRow.name },
    { pid: bystanderRow.pid, started: WIN ? '1' : 'Not_A_Real_Start_Time', name: bystanderRow.name }
  ],
  0
)

let gone = false
for (let i = 0; i < 40 && !gone; i++) {
  await sleep(500)
  gone = !(await alive(orphan.pid))
}
assert.equal(gone, true, 'the orphan was killed by the recorded sweep')
assert.equal(await alive(bystander.pid), true, 'a pid whose creation time moved was left alone')

try {
  process.kill(bystander.pid)
} catch {
  /* already gone */
}

console.log('stray-sweep-test: the recorded sweep OK')

// ---------------------------------------------------------------------------
// 3. The sampler, and the crash it exists for
// ---------------------------------------------------------------------------

// A pane, as far as this file is concerned, is a pid with children. This one stands in for
// the pty: it holds a child the way a pane holds a dev server.
const pane = spawn(
  process.execPath,
  ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); ${idle}`],
  { detached: true, stdio: 'ignore', windowsHide: true }
)
pane.unref()
await sleep(1500)

trackStrays(() => [{ id: 'pane-1', pid: pane.pid }])
await new Promise((r) => sampleOnce(r))

const written = readLedger().runs[String(process.pid)] ?? []
assert.ok(written.length >= 1, 'the sampler wrote the pane\'s children to the ledger')
const child = written[0]
assert.ok((await table()).some((p) => p.pid === child.pid), 'and it is a real running pid')

// Now the case the whole feature is for: the app dies without killing anything. Its run is
// gone from the process table, so the NEXT launch owns those records. The live run beside
// it in the same file is another copy of PaneForge and must be left completely alone.
const survivor = spawn(process.execPath, ['-e', idle], { detached: true, stdio: 'ignore', windowsHide: true })
survivor.unref()
await sleep(1200)
const survivorRow = (await table()).find((p) => p.pid === survivor.pid)
assert.ok(survivorRow, 'the other copy\'s process is running')

const deadRun = String(orphan.parent) // a pid this test proved is gone
writeFileSync(
  join(data, 'strays.json'),
  JSON.stringify({
    runs: {
      [deadRun]: [child],
      [String(process.pid)]: [{ pid: survivorRow.pid, started: survivorRow.started, name: survivorRow.name }]
    }
  })
)

// The sweep's timer is unref'd - a launch must never be held open by a tidy-up - so the
// test holds the loop itself rather than the app being changed to suit it.
const keepAlive = setInterval(() => {}, 500)
const killed = await new Promise((r) => sweepOldStrays(r, 200))
clearInterval(keepAlive)
assert.equal(killed, 1, 'exactly the dead run\'s record was swept')

let childGone = false
for (let i = 0; i < 40 && !childGone; i++) {
  await sleep(500)
  childGone = !(await alive(child.pid))
}
assert.equal(childGone, true, 'a crashed run\'s leftover was killed by the next launch')
assert.equal(await alive(survivor.pid), true, 'a live copy of PaneForge kept its own processes')
assert.deepEqual(Object.keys(readLedger().runs), [String(process.pid)], 'the swept run was dropped from the ledger')

for (const pid of [pane.pid, survivor.pid]) {
  try {
    process.kill(pid)
  } catch {
    /* already gone */
  }
}

console.log('stray-sweep-test: OK')
