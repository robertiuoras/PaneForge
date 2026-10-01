// The main-process watchdog is deliberately arithmetic first: this proves its refusals.

import {
  BEAT_MS,
  HANG_MS,
  STARVED_HANG_FACTOR,
  beat,
  decide,
  fresh,
  readVitals,
  describeVitals,
  machineBusyPct,
  describeTasklist,
  silenceLine,
  forkStoppedReason
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

// 2026-10-01 6:25:54pm: `main: no heartbeat for 76s - relaunching ... machine: 196MB free of
// 16384MB`. The kill -9 ended 18 chats mid-turn for a stall that was the machine's.
const starvedRun = (ticks) => {
  let s = beat(fresh())
  let t = 5_000_000
  const actions = []
  for (let i = 0; i < ticks; i++) {
    t += BEAT_MS
    const next = decide(s, t, HANG_MS, true)
    s = next.state
    actions.push(next.action)
  }
  return actions
}
ok('starved: ten minutes is the factor that was chosen', HANG_MS * STARVED_HANG_FACTOR === 600_000)
ok('starved: 76 s of silence waits', starvedRun(38).every((action) => action === 'wait'))
ok('starved: 600 s of silence acts, and not a tick before', (() => {
  const actions = starvedRun(600_000 / BEAT_MS)
  return actions.slice(0, -1).every((action) => action === 'wait') && actions.at(-1) === 'act'
})())
ok('not starved: the same 76 s still acts', (() => {
  let s = beat(fresh())
  let t = 5_000_000
  let last = 'wait'
  for (let i = 0; i < 38; i++) { t += BEAT_MS; const next = decide(s, t, HANG_MS, false); s = next.state; last = next.action }
  return last === 'act'
})())

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
    .replace("const port = process.parentPort", 'const port = { on(_name, fn) { globalThis.__childOnMessage = fn } }')
    .replace("import { readPressure } from './memory'", "const readPressure = () => { globalThis.__pressureReads = (globalThis.__pressureReads ?? 0) + 1; return globalThis.__pressure ?? 'normal' }")
    .replace('async function markDeskForRestart(', 'export async function markDeskForRestart(')
    .replace('function relaunch(', 'export function relaunch(')
  await build({
    stdin: { contents: childSource, resolveDir: join(root, 'src/main'), sourcefile: 'watchdog-child.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: childOut
  })
  const spawnCalls = []
  const execCalls = []
  // The machine as the child saw it at 6:25:54pm: 196 MB free of 16384 MB.
  const osAtCrash = { ...nativeLoad('node:os', null, false), freemem: () => 196 * 1048576, totalmem: () => 16384 * 1048576 }
  Module._load = (request, parent, isMain) => request === 'node:child_process'
    ? { execFile(command) { execCalls.push(command) }, spawn(command, args, options) { spawnCalls.push({ command, args, options }); return { once() {}, unref() {} } } }
    : request === 'node:os' ? osAtCrash
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

  // Replay of 6:25:54pm through the real child: silence while the machine is short of memory
  // waits and says so, a beat afterwards says every pane was kept, and only ten minutes of
  // silence acts. execFile('ps') is the first thing act() runs, so it marks an act.
  const settle = async (file, text) => {
    for (let i = 0; i < 5000; i++) {
      if (existsSync(file) && readFileSync(file, 'utf8').includes(text)) return true
      await new Promise((r) => setImmediate(r))
    }
    return false
  }
  const loadChild = (pressure) => {
    globalThis.__pressure = pressure
    globalThis.__pressureReads = 0
    delete requireOut.cache[requireOut.resolve(childOut)]
    requireOut(childOut)
    const userData = caseDir(`starved-${pressure}`)
    const send = globalThis.__childOnMessage
    // A pid that cannot exist, so no path through relaunch() can ever reach a real process.
    send({ data: { t: 'hello', pid: 2147483646, exe: 'pf', appPath: 'pf', userData, platform: 'darwin', profile: '', packaged: false } })
    return { tick: intervals.at(-1), send, log: join(userData, 'paneforge-errors.log') }
  }
  const acts = () => execCalls.filter((command) => command === 'ps').length
  let child = loadChild('warn')
  child.send({ data: { t: 'beat' } })
  for (let i = 0; i < 4; i++) { child.tick(); child.send({ data: { t: 'beat' } }) }
  ok('a beating main never asks the machine about memory', globalThis.__pressureReads === 0)
  let actsBefore = acts()
  for (let i = 0; i < 38; i++) child.tick()
  ok('starved child: 76 s of silence at 196MB free does not relaunch', acts() === actsBefore)
  ok('starved child: says why it is waiting, with the machine reading', await settle(child.log, 'main: no heartbeat for 76s, but the machine is short of memory (196MB free of 16384MB) - waiting up to 10 min instead of relaunching'))
  child.send({ data: { t: 'beat' } })
  ok('starved child: a beat afterwards says every pane was kept', await settle(child.log, 'main: beating again after 76s of silence while memory was short - not relaunched, every pane kept'))
  for (let i = 0; i < 299; i++) child.tick()
  ok('starved child: 598 s of silence still waits', acts() === actsBefore)
  child.tick()
  ok('starved child: 600 s of silence relaunches', acts() === actsBefore + 1)
  child = loadChild('normal')
  child.send({ data: { t: 'beat' } })
  actsBefore = acts()
  for (let i = 0; i < 37; i++) child.tick()
  const waitedNormal = acts() === actsBefore
  child.tick()
  ok('memory fine: 76 s of silence still relaunches as before', waitedNormal && acts() === actsBefore + 1)

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
