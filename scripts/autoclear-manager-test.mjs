// Exercise the built SessionManager's delayed clear path with re-read handoffs.
import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-autoclear-manager-'))
mkdirSync(join(work, 'userData'), { recursive: true })
writeFileSync(join(work, 'electron.cjs'), `const p=require('node:path'); module.exports={app:{isPackaged:true,getVersion:()=> '1',getPath:()=>p.join(__dirname,'userData')},BrowserWindow:{getAllWindows:()=>[]},shell:{openPath:()=>{}},dialog:{}}`)
writeFileSync(join(work, 'pty.cjs'), `const off={dispose(){}}; module.exports={spawn:()=>({pid:1,writes:[],onData(){return off},onExit(){return off},write(v){this.writes.push(v)},kill(){},resize(){}})}`)
writeFileSync(join(work, 'handoff.cjs'), `module.exports={handoffFor:()=>global.__pfHandoff,forgetHandoff(){},clearHandoffCache(){}}`)
await build({
  absWorkingDir: root, entryPoints: ['src/main/sessions.ts'], bundle: true, format: 'cjs', platform: 'node',
  outfile: join(work, 'sessions.cjs'), logLevel: 'silent',
  alias: { electron: join(work, 'electron.cjs'), '@lydell/node-pty': join(work, 'pty.cjs') },
  plugins: [{ name: 'handoff-fixture', setup(build) { build.onResolve({ filter: /^\.\/handoffSteps$/ }, () => ({ path: join(work, 'handoff.cjs') })) } }]
})
const { SessionManager } = createRequire(join(work, 'load.cjs'))('./sessions.cjs')
const realTimers = global.setTimeout
const timers = []
global.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer }
global.clearTimeout = () => {}
const NOW = Date.now()
const valid = () => ({ path: '/memory/session-handoff.pane-pane1.md', mtimeMs: Date.now(), open: 1, steps: ['continue work'] })
const bad = {
  missing: () => ({ path: null, mtimeMs: 0, open: 0, steps: [] }),
  stale: () => ({ ...valid(), mtimeMs: Date.now() - 20 * 60_000 - 1 }),
  foreign: () => ({ ...valid(), path: '/memory/session-handoff.md' }),
  empty: () => ({ ...valid(), open: 0, steps: [] })
}
const ask = { prompt: 'continue', steps: ['continue work'], seconds: 1, command: '/new' }

try {
  for (const [label, changed] of Object.entries(bad)) {
    timers.length = 0
    global.__pfHandoff = valid()
    const manager = new SessionManager()
    const started = manager.start({ cwd: root, agent: 'codex' })
    const live = manager.sessions.get(started.id)
    live.meta.id = 'pane1'
    manager.sessions.delete(started.id)
    manager.sessions.set('pane1', live)
    live.meta.lastOutput = NOW - 10_000
    live.meta.runSince = undefined
    const armed = manager.armAutoClear('pane1', ask)
    assert.equal(armed.ok, true, `${label}: valid handoff first arms a countdown`)
    global.__pfHandoff = changed()
    const countdown = timers.find((t) => t.ms === 1000)
    assert.ok(countdown, `${label}: countdown timer exists`)
    countdown.fn()
    assert.equal(live.proc.writes.some((text) => text.includes('/new')), false, `${label}: changed handoff blocks the delayed /new`)
  }

  // A history recall carries a real but unreconstructable line. The legacy typed shadow
  // is empty; meta.drafting is the conservative signal arm and queuePrompt must honour.
  global.__pfHandoff = valid()
  const manager = new SessionManager()
  const started = manager.start({ cwd: root, agent: 'codex' })
  const live = manager.sessions.get(started.id)
  live.meta.id = 'pane1'
  manager.sessions.delete(started.id)
  manager.sessions.set('pane1', live)
  live.meta.lastOutput = NOW - 10_000
  live.meta.runSince = undefined
  manager.write('pane1', '\x1b[A', 'desk')
  assert.equal(live.typed, '', 'history recall leaves the legacy typed shadow empty')
  assert.equal(live.meta.drafting, true, 'history recall records conservative drafting')
  const queued = manager.armAutoClear('pane1', ask)
  assert.match(queued.reason, /queued/, 'conservative draft queues instead of arming over history')

  // A draft can arrive after expiry but before the 120ms render-preservation lead fires.
  live.meta.drafting = undefined
  live.draft = { text: '', certain: true, inPaste: false }
  const timerStart = timers.length
  const armed = manager.armAutoClear('pane1', ask)
  assert.equal(armed.ok, true, 'clean pane arms before the late-draft race')
  timers.slice(timerStart).find((t) => t.ms === 1000).fn()
  manager.write('pane1', '\x1b[A', 'desk')
  timers.slice(timerStart).find((t) => t.ms === 120).fn()
  assert.equal(live.proc.writes.some((text) => text.includes('/new')), false, 'a draft during the arm lead blocks the clear write')

  for (const [label, mutate, clears = false] of [
    ['a submitted turn', (pane) => { pane.meta.drafting = undefined; pane.meta.runSince = Date.now() }],
    ['a live question', (pane) => { pane.meta.drafting = undefined; pane.meta.ask = { question: 'choose' } }],
    ['Keep pressed', (_pane, manager) => manager.cancelAutoClear('pane1', 'cancelled')],
    ['pane restart', (_pane, manager) => manager.restart('pane1')],
    ['handoff removed', () => { global.__pfHandoff = bad.missing() }],
    ['unchanged valid pane', () => {}, true]
  ]) {
    const manager = new SessionManager()
    const started = manager.start({ cwd: root, agent: 'codex' })
    const live = manager.sessions.get(started.id)
    live.meta.id = 'pane1'
    manager.sessions.delete(started.id)
    manager.sessions.set('pane1', live)
    live.meta.lastOutput = NOW - 10_000
    live.meta.runSince = undefined
    global.__pfHandoff = valid()
    const start = timers.length
    manager.armAutoClear('pane1', ask)
    timers.slice(start).find((t) => t.ms === 1000).fn()
    mutate(live, manager)
    timers.slice(start).find((t) => t.ms === 120).fn()
    assert.equal(live.proc.writes.some((text) => text.includes('/new')), clears, `${label} during the arm lead has the expected clear result`)
  }
  // A `\` + Enter in Claude Code is a new line in its box: nothing was sent, so nothing is
  // filed, no turn starts, and the line keeps growing until the Enter that does send it.
  {
    const manager = new SessionManager()
    const started = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(started.id)
    live.meta.runSince = undefined
    live.turnPending = false
    const sent = []
    manager.on('submitted', (_id, line) => sent.push(line))
    manager.write(started.id, 'first line \\', 'desk')
    manager.write(started.id, '\r', 'desk')
    assert.deepEqual(sent, [], 'backslash + Enter files no submitted line')
    assert.equal(live.turnPending, false, 'backslash + Enter starts no turn')
    assert.equal(live.typed, 'first line \n', 'the typed line keeps the break, not the backslash')
    manager.write(started.id, 'second', 'desk')
    manager.write(started.id, '\r', 'desk')
    assert.deepEqual(sent, ['first line \nsecond'], 'the next Enter sends both lines once')
    assert.equal(live.turnPending, true, 'and that Enter starts the turn')
  }
  // An automatic clear on its way in is a prompt the app owes the pane, from the ask to the
  // moment /clear is typed, or a move carries the conversation away un-cleared. The shape
  // of s60-mulljm2l (Mac 0.8.230, 2026-09-28 19:01Z): it printed 31ms before the ask, was
  // held 9969ms, then counted down 15s - and a move to the PC fired inside the countdown.
  {
    global.__pfHandoff = valid()
    const manager = new SessionManager()
    const { id } = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(id)
    live.meta.runSince = undefined
    live.turnPending = false
    const ask15 = { prompt: 'continue', steps: ['continue work'], seconds: 15 }
    const owed = () => manager.list().find((s) => s.id === id)?.owedPrompt === true
    assert.equal(owed(), false, 'an idle pane with nothing on its way is owed nothing')

    live.meta.lastOutput = Date.now() - 31
    const start = timers.length
    assert.match(manager.armAutoClear(id, ask15).reason ?? '', /settle/, 'a pane that printed 31ms ago is held, not armed')
    const hold = timers.slice(start).find((t) => t.ms > 9_000 && t.ms <= 9_969)
    assert.ok(hold, 'the settle hold is ~9969ms')
    assert.equal(owed(), true, 'list() says owedPrompt during the settle hold')

    live.meta.lastOutput = Date.now() - 12_000
    hold.fn()
    assert.ok(live.meta.autoClearAt, 'the hold ends in an armed countdown')
    assert.ok(timers.slice(start).some((t) => t.ms === 15_000), 'the countdown is 15s')
    assert.equal(owed(), true, 'list() says owedPrompt during the countdown')
    assert.equal(manager.sleep(id, 'pressure'), null, 'sleep() reads it the same way and refuses mid-countdown')

    manager.cancelAutoClear(id, 'cancelled')
    assert.equal(owed(), false, 'Keep stands the clear down and the pane is owed nothing again')

    // The ask that arrives mid-turn and waits for it to end is owed too.
    live.meta.runSince = Date.now()
    assert.match(manager.armAutoClear(id, ask15).reason ?? '', /queued/, 'a mid-turn ask waits for the turn')
    assert.equal(owed(), true, 'list() says owedPrompt while the ask waits for the turn')
    manager.cancelAutoClear(id, 'cancelled')
    assert.equal(owed(), false, 'and not once that ask is dropped')
  }
  console.log('autoclear manager: delayed handoff and draft guards behaved')
} finally {
  global.setTimeout = realTimers
}
