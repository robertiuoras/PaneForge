// A real Electron main-process hang in an isolated, hidden profile. Build first.
// No installed app is stopped; the PID under test is the child created here.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const name = `watchdog-proof-${process.pid}`
const evidence = join(tmpdir(), name)
const profile = join(homedir(), 'Library', 'Application Support', `claude-orchestrator-${name}`)
assert.equal(process.platform, 'darwin', 'this runtime probe verifies the macOS sample path')
mkdirSync(evidence, { recursive: true })
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ root: evidence, desktopShortcut: false,
  launchAtLogin: false, autoUpdate: false, discordPresence: false, autoLane: false,
  restoreAfterUpdate: false, phone: false }))
const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env, PANEFORGE_PROFILE: name, PANEFORGE_HEADLESS: '1',
  PANEFORGE_RESTORE: 'fresh', PF_WATCHDOG_HANG_MS: '10000', PF_WATCHDOG_TEST_HANG_MS: '60000' }
delete env.ELECTRON_RUN_AS_NODE
delete env.PF_NO_WATCHDOG
const child = spawn(electron, ['.', '--headless', `--profile=${name}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const began = Date.now()
let timeout
// Install two deliberately different desk fixtures after main has entered the drill. The
// watchdog must preserve the newer terminal snapshot when it marks the desk for restart.
const fixture = setTimeout(() => {
  const at = Date.now()
  for (const [file, title, writtenAt] of [['desk.json', 'old fixture', at], ['desk.exit.json', 'new fixture', at + 1]]) {
    writeFileSync(join(profile, file), JSON.stringify({ specs: [{ cwd: evidence, title }], at, writtenAt, reason: 'live', clean: false }))
  }
}, 7000)
try {
  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('watchdog failed to stop its test main within 40 seconds')) }, 40000)
  })
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(result))
  const log = readFileSync(join(profile, 'paneforge-errors.log'), 'utf8')
  const line = log.split('\n').find(line => line.includes(`(pid ${child.pid})`) && line.includes('no heartbeat'))
  assert(line, 'watchdog log identifies the hung process')
  const samples = readdirSync(profile).filter(file => /^main-hang-.*\.txt$/.test(file))
  assert(samples.length > 0, 'sample artifact exists')
  const sample = readFileSync(join(profile, samples[0]), 'utf8')
  assert(sample.includes(`Process:`) && sample.includes(String(child.pid)), 'sample identifies the tested main')
  const desk = JSON.parse(readFileSync(join(profile, 'desk.exit.json'), 'utf8'))
  assert.equal(desk.reason, 'update')
  assert.equal(desk.clean, true)
  assert.equal(desk.specs[0].title, 'new fixture')
  // One bounded observation after the detached relaunch delay, not a polling loop.
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2500))
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  assert(!processes.split('\n').some(line => line.includes(`--profile=${name}`)), 'unpackaged test did not relaunch')
  console.log(line)
  console.log(`sample: ${join(profile, samples[0])}`)
  console.log(`PID ${child.pid} killed; no relaunch; newest desk marked update; ${Date.now() - began}ms`)
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ pid: child.pid, result, line, samples, profile, elapsedMs: Date.now() - began }, null, 2))
} finally {
  clearTimeout(timeout)
  clearTimeout(fixture)
  writeFileSync(join(evidence, 'app.log'), output)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}
