// The main-process watchdog is deliberately arithmetic first: this proves its refusals.

import { BEAT_MS, HANG_MS, beat, decide, fresh } from '../src/shared/mainWatch.ts'
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
  const electron = { app: { isPackaged: true, getPath: () => '/tmp/pf', once: (name, fn) => events.set(name, fn) }, utilityProcess: { fork: forkImpl } }
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
