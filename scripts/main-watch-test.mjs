// The main-process watchdog is deliberately arithmetic first: this proves its refusals.

import {
  BEAT_MS,
  HANG_MS,
  beat,
  decide,
  fresh,
  readVitals,
  describeVitals,
  machineBusyPct,
  describeTasklist,
  silenceLine,
  forkStoppedReason,
  STARVED_FACTOR,
  starved,
  psCpuPct,
  starvedWaitLine,
  starvedBackLine
} from '../src/shared/mainWatch.ts'
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Module from 'node:module'

let failed = 0
const ok = (what, condition) => {
  if (!condition) failed++
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${what}`)
}
let now = 1_000_000
let state = fresh()
const tick = () => {
  now += BEAT_MS
  const next = decide(state, now)
  state = next.state
  return next.action
}

ok('never acts before the first beat', Array.from({ length: 50 }, tick).every((action) => action === 'wait'))
state = beat(state)
ok('normal beats reset the consecutive miss count', (() => {
  for (let i = 0; i < 5; i++) {
    tick()
    state = beat(state)
  }
  return state.silentTicks === 0
})())
ok('38 silent ticks act after the 75 second grace', (() => {
  const actions = Array.from({ length: Math.ceil(HANG_MS / BEAT_MS) }, tick)
  return actions.slice(0, -1).every((action) => action === 'wait') && actions.at(-1) === 'act'
})())
ok('an action happens once per watchdog lifetime', tick() === 'wait')
state = beat(fresh())
tick()
now += 20 * 60 * 1000
const slept = decide(state, now)
state = slept.state
ok('a twenty-minute clock jump is sleep, not a hang', slept.action === 'wait' && state.silentTicks === 0)

// --- vitals arithmetic ---

const mark0 = { at: 1_000_000, cpuUs: 500_000 }
const r1 = readVitals(mark0, 1_002_000, { rss: 100 * 1048576, heapUsed: 40 * 1048576 }, 500_000 + 400_000, 1_001_500)
ok('readVitals lag is the gap past BEAT_MS', r1.vitals.lagMs === 0)
const r2 = readVitals(mark0, 1_005_000, { rss: 100 * 1048576, heapUsed: 40 * 1048576 }, 500_000, 0)
ok('readVitals lag is gap minus BEAT_MS when the timer fires late', r2.vitals.lagMs === 3_000)
ok('readVitals cpuPct comes from delta cpu microseconds over the gap', r1.vitals.cpuPct === 20)
ok('readVitals rendererAgoMs is null when the renderer has never answered', r2.vitals.rendererAgoMs === null)
ok('readVitals rendererAgoMs is the time since the last answer otherwise', r1.vitals.rendererAgoMs === 500)
ok('readVitals mark carries the raw cpu microseconds forward', r1.mark.cpuUs === 900_000 && r1.mark.at === 1_002_000)

const described = describeVitals(r1.vitals)
ok('describeVitals mentions memory, lag and cpu', described.includes('MB') && described.includes('ms late') && described.includes('cpu'))
ok('describeVitals says the window has not answered yet when null', describeVitals(r2.vitals).includes('has not answered yet'))

const cpuBefore = [{ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }]
const cpuAfter = [{ user: 15, nice: 0, sys: 10, idle: 75, irq: 0 }, { user: 15, nice: 0, sys: 10, idle: 75, irq: 0 }]
ok('machineBusyPct reads busy time across all cores', machineBusyPct(cpuBefore, cpuAfter) === 25)
ok('machineBusyPct refuses mismatched core counts', machineBusyPct(cpuBefore, [cpuAfter[0]]) === null)
ok('machineBusyPct refuses an empty reading', machineBusyPct([], []) === null)

const tasklistLine = '"PaneForge.exe","15976","","1","211,388 K","Running","DESKTOP-CMSUCM1\\Gamer","0:10:56","PaneForge"'
const tasklistDesc = describeTasklist(tasklistLine)
ok('describeTasklist reads the status', tasklistDesc?.includes('Running') ?? false)
ok('describeTasklist reads the cpu time', tasklistDesc?.includes('0:10:56') ?? false)
ok('describeTasklist reads the memory', tasklistDesc?.includes('211,388 K') ?? false)
ok('describeTasklist refuses garbage', describeTasklist('not a csv line at all') === null)

const line = silenceLine({
  silentS: 76,
  what: 'relaunching',
  pid: 16972,
  last: { agoS: 4, vitals: r1.vitals },
  machine: { freeMb: 512, totalMb: 16384, busyPct: 40 },
  proc: tasklistDesc
})
ok('silenceLine names the pid', line.includes('pid 16972'))
ok('silenceLine names the silent seconds', line.includes('76s'))
ok('silenceLine names the last beat', line.includes('last beat'))
ok('silenceLine names the machine reading', line.includes('machine:'))

const stoppedReason = forkStoppedReason('stopped (0)', 1_000_000, 1_094_000, 46, r1.vitals, 512, 16384)
ok('forkStoppedReason names beats sent and uptime', stoppedReason.includes('after 94s') && stoppedReason.includes('46 beats sent'))
ok('forkStoppedReason names the machine', stoppedReason.includes('machine:') && stoppedReason.includes('512MB free of 16384MB'))
ok('forkStoppedReason says main had nothing to show with no prior beat', forkStoppedReason('stopped (0)', 0, 1_000, 0, null, 1, 2).includes('no beat was sent'))

// --- a starving machine is not a frozen main (2026-10-01 08:25Z) ---

// The relaunch line from that night: pressure read separately; ps said "110:07.70 0.0 928 S".
const thatNight = { pressure: 4, freeMb: 196, totalMb: 16384, mainCpuPct: psCpuPct('110:07.70 0.0 928 S') }
ok('psCpuPct reads the %cpu column', psCpuPct('110:07.70 0.0 928 S') === 0 && psCpuPct(' 0:01.00 87.5 2048 R ') === 87.5)
ok('psCpuPct refuses garbage', psCpuPct('') === null && psCpuPct('x') === null)
ok('that night counts as starved: Mac pressure 4, main idle', starved(thatNight))
ok('Mac pressure 2 counts as short', starved({ ...thatNight, pressure: 2 }))
ok('Mac pressure 1 is not short however little is free', !starved({ ...thatNight, pressure: 1, freeMb: 50 }))
ok('a Mac whose level did not answer is not short', !starved({ ...thatNight, pressure: 0 }))
ok('main spinning at 50% cpu is frozen, not starved', !starved({ ...thatNight, mainCpuPct: 50 }))
ok('main cpu unread still counts as starved on a short machine', starved({ ...thatNight, mainCpuPct: null }))
ok('without a pressure level, under 5% free is short', starved({ pressure: null, freeMb: 1500, totalMb: 32768, mainCpuPct: null }))
ok('without a pressure level, 10% free is not short', !starved({ pressure: null, freeMb: 3300, totalMb: 32768, mainCpuPct: null }))
ok('the starved wait is four times the grace', STARVED_FACTOR === 4 && (HANG_MS * STARVED_FACTOR) / 1000 === 300)
const waitLine = starvedWaitLine(76, 300, thatNight, 70914)
ok('the wait line names the silence, the limit and the pid', waitLine.includes('76s') && waitLine.includes('up to 300s') && waitLine.includes('pid 70914'))
ok('the wait line names the reading', waitLine.includes('pressure 4') && waitLine.includes('196MB free of 16384MB') && waitLine.includes('main at 0% cpu'))
ok('the back line says no relaunch', starvedBackLine(140, 70914).includes('140s') && starvedBackLine(140, 70914).includes('no relaunch'))
// The longer limit is decide()'s own arithmetic: 150 silent ticks, not 38.
state = beat(fresh())
const longActions = Array.from({ length: Math.ceil((HANG_MS * STARVED_FACTOR) / BEAT_MS) }, () => {
  now += BEAT_MS
  const next = decide(state, now, HANG_MS * STARVED_FACTOR)
  state = next.state
  return next.action
})
ok('the starved limit acts after 150 silent ticks and not before', longActions.slice(0, -1).every((a) => a === 'wait') && longActions.at(-1) === 'act' && longActions.length === 150)

// Bundle the real module, substituting Electron and crash logging only at test time. This
// keeps the production watchdog free of a test injection surface while driving lifecycle
// failures that pure tick arithmetic cannot observe.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-main-watch-'))
const out = join(work, 'mainWatch.cjs')
await build({
  absWorkingDir: root,
  entryPoints: ['src/main/mainWatch.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['electron'],
  plugins: [{ name: 'crash-stub', setup(build) {
    build.onResolve({ filter: /^\.\/crash$/ }, () => ({ path: 'crash-stub', namespace: 'watch' }))
    build.onLoad({ filter: /^crash-stub$/, namespace: 'watch' }, () => ({ contents: 'export const logProblem = (...x) => globalThis.__watchLogs.push(x)' }))
    build.onResolve({ filter: /^\.\/profile$/ }, () => ({ path: 'profile-stub', namespace: 'watch' }))
    build.onLoad({ filter: /profile-stub/, namespace: 'watch' }, () => ({ contents: "export const profileName = () => 'named-profile'" }))
  }}]
})
const nativeLoad = Module._load
const requireOut = createRequire(import.meta.url)
const intervals = []
const timeouts = []
const oldInterval = global.setInterval
const oldTimeout = global.setTimeout
global.setInterval = (fn) => { intervals.push(fn); return { unref() {} } }
global.setTimeout = (fn) => { timeouts.push(fn); return { unref() {} } }
function lifecycle(forkImpl) {
  const events = new Map()
  const electron = { app: { isPackaged: true, getPath: () => work, getVersion: () => 'test-version', once: (name, fn) => events.set(name, fn) }, utilityProcess: { fork: forkImpl } }
  globalThis.__watchLogs = []
  Module._load = (request, parent, isMain) => request === 'electron' ? electron : nativeLoad(request, parent, isMain)
  delete requireOut.cache[requireOut.resolve(out)]
  const loaded = requireOut(out)
  return { ...loaded, events }
}
function fakeChild() {
  const listeners = new Map()
  return { killed: false, messages: [], on(name, fn) { listeners.set(name, fn); return this }, postMessage(message) { this.messages.push(message) }, kill() { this.killed = true; return true }, emit(name, ...args) { listeners.get(name)?.(...args) } }
}
try {
  let forks = 0
  const thrower = lifecycle(() => { forks++; throw new Error('no helper') })
  thrower.startMainWatch()
  ok('a fork throw schedules one retry', forks === 1 && timeouts.length === 1)
  const old = fakeChild()
  const errored = lifecycle(() => old)
  errored.startMainWatch()
  old.emit('error', 'FatalError', 'test')
  old.emit('exit', 1)
  ok('an error kills the old child and error plus exit schedule one retry', old.killed && timeouts.length === 2)
  const stoppedChild = fakeChild()
  const stoppedLifecycle = lifecycle(() => stoppedChild)
  stoppedLifecycle.startMainWatch()
  stoppedChild.emit('exit', 0)
  const stoppedLog = globalThis.__watchLogs.map((args) => args.join(' ')).join('\n')
  ok('a stopped helper logs beats sent', stoppedLog.includes('beats sent'))
  ok('a stopped helper logs the machine reading', stoppedLog.includes('machine:'))
  const named = fakeChild()
  const namedLifecycle = lifecycle(() => named)
  namedLifecycle.startMainWatch()
  named.emit('spawn')
  ok('main hello carries the resolved named profile', named.messages[0]?.profile === 'named-profile')
  const stopped = lifecycle(() => fakeChild())
  stopped.startMainWatch()
  stopped.events.get('will-quit')()
  const before = timeouts.length
  timeouts.at(-1)?.()
  ok('shutdown prevents a queued retry from forking', timeouts.length === before)

  // Compile the real child with only its message port replaced. The mark function remains
  // private in production; the source substitution exposes it only inside this test bundle.
  const childOut = join(work, 'watchdog-child.cjs')
  const childSource = readFileSync(join(root, 'src/main/watchdog-child.ts'), 'utf8')
    .replace("const port = process.parentPort", 'const port = { on() {} }')
    .replace('async function markDeskForRestart(', 'export async function markDeskForRestart(')
    .replace('function relaunch(', 'export function relaunch(')
  await build({
    stdin: { contents: childSource, resolveDir: join(root, 'src/main'), sourcefile: 'watchdog-child.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: childOut
  })
  const spawnCalls = []
  Module._load = (request, parent, isMain) => request === 'node:child_process'
    ? { execFile() {}, spawn(command, args, options) { spawnCalls.push({ command, args, options }); return { once() {}, unref() {} } } }
    : nativeLoad(request, parent, isMain)
  const { markDeskForRestart, relaunch } = requireOut(childOut)
  const hello = (userData) => ({ t: 'hello', pid: 1, exe: 'pf', appPath: 'pf', userData, platform: 'darwin', argv: [], packaged: false })
  const caseDir = (name) => mkdtempSync(join(work, `${name}-`))
  const writeDesk = (dir, name, desk) => writeFileSync(join(dir, name), JSON.stringify(desk))
  let dir = caseDir('legacy')
  writeDesk(dir, 'desk.json', { specs: [{ cwd: 'legacy' }], reason: 'live', at: 1 })
  await markDeskForRestart(hello(dir))
  let marked = JSON.parse(readFileSync(join(dir, 'desk.exit.json'), 'utf8'))
  ok('a legacy desk without writtenAt is recoverable when no clear tombstone exists', marked.specs[0].cwd === 'legacy' && marked.reason === 'update' && marked.writtenAt > 0)
  dir = caseDir('terminal')
  writeDesk(dir, 'desk.json', { specs: [{ cwd: 'live' }], writtenAt: 0 })
  writeDesk(dir, 'desk.exit.json', { specs: [{ cwd: 'exit' }], writtenAt: 3 })
  await markDeskForRestart(hello(dir))
  marked = JSON.parse(readFileSync(join(dir, 'desk.exit.json'), 'utf8'))
  ok('a newer terminal desk wins over a legacy live desk', marked.specs[0].cwd === 'exit')
  dir = caseDir('live')
  writeDesk(dir, 'desk.json', { specs: [{ cwd: 'live-new' }], writtenAt: 4 })
  writeDesk(dir, 'desk.exit.json', { specs: [{ cwd: 'exit-old' }], writtenAt: 3 })
  await markDeskForRestart(hello(dir))
  marked = JSON.parse(readFileSync(join(dir, 'desk.exit.json'), 'utf8'))
  ok('a newer live desk supersedes an older terminal desk', marked.specs[0].cwd === 'live-new')
  dir = caseDir('clear')
  writeDesk(dir, 'desk.json', { specs: [{ cwd: 'cleared' }], writtenAt: 4 })
  writeFileSync(join(dir, 'desk.clear'), '4')
  await markDeskForRestart(hello(dir))
  ok('a positive clear tombstone prevents watchdog recovery', !existsSync(join(dir, 'desk.exit.json')))

  const packaged = (platform, profile = '') => ({ t: 'hello', pid: 99, exe: '/opt/pf', appPath: '/Applications/PaneForge.app/Contents/MacOS/PaneForge', userData: '/tmp/pf', platform, profile, packaged: true })
  relaunch(packaged('darwin', 'named-profile'))
  relaunch(packaged('win32', 'named-profile'))
  relaunch(packaged('linux', 'named-profile'))
  ok('packaged mac recovery passes the exact named profile through open args', spawnCalls[0].command === 'sh' && spawnCalls[0].args[1].includes("open -n -a '/Applications/PaneForge.app' --args '--profile=named-profile'"))
  ok('packaged Windows recovery passes the exact named profile through start', spawnCalls[1].command === 'cmd' && spawnCalls[1].args[1].includes('"--profile=named-profile"'))
  ok('packaged Linux recovery passes the exact named profile to the executable', spawnCalls[2].command === 'sh' && spawnCalls[2].args[1].includes("'/opt/pf' '--profile=named-profile'"))
  relaunch(packaged('linux'))
  ok('the default profile does not add a profile argument', !spawnCalls[3].args[1].includes('--profile='))

  // Drive the real child's timer on a starving and on a healthy machine. Each load is its own
  // bundle, so each starts with its own module state; ticks are called by hand.
  async function loadChild(name, answers, platform = 'darwin') {
    const calls = []
    const held = []
    const file = join(work, `watchdog-child-${name}.cjs`)
    const source = readFileSync(join(root, 'src/main/watchdog-child.ts'), 'utf8')
      .replace('const port = process.parentPort', 'const port = { on(_, fn) { globalThis.__port = fn } }')
    await build({
      stdin: { contents: source, resolveDir: join(root, 'src/main'), sourcefile: 'watchdog-child.ts', loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: file
    })
    Module._load = (request, parent, isMain) => request === 'node:child_process'
      ? { execFile(cmd, args, opts, cb) {
          calls.push(cmd)
          const a = answers(cmd)
          // undefined = hold the answer until the test releases it
          if (a === undefined) held.push(() => cb(null, answers.later(cmd)))
          else process.nextTick(() => a === null ? cb(new Error('no')) : cb(null, a))
        }, spawn() { return { once() {}, unref() {} } } }
      : nativeLoad(request, parent, isMain)
    requireOut(file)
    const port = globalThis.__port
    const tick = intervals.at(-1)
    const dir = caseDir(`child-${name}`)
    port({ data: { t: 'hello', pid: 2147483646, exe: 'pf', appPath: 'pf', userData: dir, platform, profile: '', packaged: false } })
    port({ data: { t: 'beat' } })
    const log = () => { try { return readFileSync(join(dir, 'paneforge-errors.log'), 'utf8') } catch { return '' } }
    // The log is appended asynchronously; a loaded machine can take a while. Waits for the
    // text (up to 5s), or just lets the event loop run when there is nothing to wait for.
    const settle = async (text) => {
      for (const until = Date.now() + 5_000; Date.now() < until;) {
        await new Promise((r) => oldTimeout(r, 20))
        if (!text || (typeof text === 'function' ? text(log()) : log().includes(text))) return
      }
    }
    return { port, tick, settle, log, calls, held }
  }
  const graceTicks = Math.ceil(HANG_MS / BEAT_MS)
  const short = await loadChild('starved', (cmd) => cmd.endsWith('sysctl') ? '4\n' : cmd === 'ps' ? '110:07.70 0.0 928 S\n' : null)
  for (let i = 0; i < graceTicks; i++) short.tick()
  await short.settle('waiting up to 300s')
  ok('starving machine: the child waits instead of relaunching at 76s', short.log().includes('waiting up to 300s') && !short.log().includes('stopping it'))
  for (let i = 0; i < 100; i++) short.tick()
  await short.settle()
  ok('starving machine: still no relaunch 200s into the silence', !short.log().includes('stopping it'))
  short.port({ data: { t: 'beat' } })
  await short.settle('beating again after')
  ok('starving machine: a beat says main came back, no relaunch', short.log().includes('beating again after') && !short.log().includes('stopping it'))
  for (let i = 0; i < graceTicks + Math.ceil((HANG_MS * STARVED_FACTOR) / BEAT_MS); i++) { short.tick(); if (i === graceTicks - 1) await short.settle((l) => l.split('waiting up to 300s').length === 3) }
  await short.settle('after the longer wait for a machine short of memory')
  ok('starving machine: a silence past the longer wait still recovers', short.log().includes('after the longer wait for a machine short of memory'))
  const healthy = await loadChild('healthy', (cmd) => cmd.endsWith('sysctl') ? '1\n' : cmd === 'ps' ? '110:07.70 0.0 928 S\n' : null)
  for (let i = 0; i < graceTicks; i++) healthy.tick()
  await healthy.settle('no heartbeat for 76s - stopping it')
  ok('healthy machine: the child recovers at the ordinary grace', healthy.log().includes('no heartbeat for 76s - stopping it') && !healthy.log().includes('waiting up to'))
  const spinning = await loadChild('spinning', (cmd) => cmd.endsWith('sysctl') ? '4\n' : cmd === 'ps' ? '110:07.70 99.0 928 R\n' : null)
  for (let i = 0; i < graceTicks; i++) spinning.tick()
  await spinning.settle('no heartbeat for 76s - stopping it')
  ok('starving machine with main spinning: the child recovers at the ordinary grace', spinning.log().includes('no heartbeat for 76s - stopping it'))

  // A beat that lands while the reading is still out settles the silence: no wait, no relaunch.
  const slowAnswers = Object.assign((cmd) => (cmd.endsWith('sysctl') || cmd === 'ps' ? undefined : null), {
    later: (cmd) => (cmd.endsWith('sysctl') ? '4\n' : '110:07.70 0.0 928 S\n')
  })
  const racing = await loadChild('racing', slowAnswers)
  for (let i = 0; i < graceTicks; i++) racing.tick()
  ok('the reading is out after the grace', racing.held.length === 2)
  racing.port({ data: { t: 'beat' } })
  racing.held.splice(0).forEach((release) => release())
  for (let i = 0; i < 10; i++) racing.tick()
  await racing.settle()
  await new Promise((r) => oldTimeout(r, 200))
  ok('a beat during the reading: no starved wait and no relaunch', !racing.log().includes('waiting up to') && !racing.log().includes('stopping it'))
  for (let i = 0; i < graceTicks; i++) racing.tick()
  ok('after that beat the next silence reads the machine again', racing.held.length === 2)

  // Windows: no sysctl and no ps; the free-memory rule decides.
  const win = await loadChild('win32', () => null, 'win32')
  for (let i = 0; i < graceTicks; i++) win.tick()
  await win.settle((l) => l.includes('waiting up to') || l.includes('stopping it'))
  ok('Windows reads neither sysctl nor ps before deciding', !win.calls.some((c) => c.endsWith('sysctl') || c === 'ps'))
  ok('Windows decides without a pressure level', /waiting up to|stopping it/.test(win.log()) && !win.log().includes('pressure '))

  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const beforeQuit = index.slice(index.indexOf("app.on('before-quit'"), index.indexOf("app.on('will-quit'"))
  ok('accepted before-quit stops watchdog after its cancellation guard and before saving the desk', beforeQuit.indexOf('if (running.length)') < beforeQuit.indexOf('stopMainWatch()') && beforeQuit.indexOf('stopMainWatch()') < beforeQuit.indexOf('saveDeskOnExit('))
  const closed = index.slice(index.indexOf("app.on('window-all-closed'"), index.indexOf("app.on('before-quit'"))
  ok('last-window shutdown stops watchdog before saving the desk', closed.indexOf('stopMainWatch()') >= 0 && closed.indexOf('stopMainWatch()') < closed.indexOf('saveDeskOnExit('))
} finally {
  Module._load = nativeLoad
  global.setInterval = oldInterval
  global.setTimeout = oldTimeout
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nmain watch: all good')
process.exit(failed ? 1 : 0)
