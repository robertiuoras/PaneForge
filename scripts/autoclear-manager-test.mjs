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
writeFileSync(join(work, 'pty.cjs'), `const off={dispose(){}}; module.exports={spawn:()=>({pid:1,writes:[],onData(cb){this.data=cb;return off},onExit(){return off},write(v){this.writes.push(v)},kill(){},resize(){}})}`)
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
// "The pane last printed `ms` ago", for the stamp the quiet floor reads (`contentAt`) and the
// raw one every other reading keeps (`meta.lastOutput`).
const printedAgo = (live, ms) => { live.meta.lastOutput = Date.now() - ms; live.contentAt = live.meta.lastOutput }
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
    printedAgo(live, 10_000)
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
  printedAgo(live, 10_000)
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
    printedAgo(live, 10_000)
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

    printedAgo(live, 31)
    const start = timers.length
    assert.match(manager.armAutoClear(id, ask15).reason ?? '', /settle/, 'a pane that printed 31ms ago is held, not armed')
    const hold = timers.slice(start).find((t) => t.ms > 9_000 && t.ms <= 9_969)
    assert.ok(hold, 'the settle hold is ~9969ms')
    assert.equal(owed(), true, 'list() says owedPrompt during the settle hold')

    printedAgo(live, 12_000)
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
  // The pty's own data events, end to end. s72 (2026-10-02 3:44-4:05am): a finished pane whose
  // idle footer carried a background agent row repainted its timer every second, `lastOutput`
  // was never 10s old, and the clear was held 115 times in 20 minutes. The chunks are the real
  // shape out of that pane's log: a cursor hop, the title glyph, one digit.
  {
    global.__pfHandoff = valid()
    const manager = new SessionManager()
    const { id } = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(id)
    live.meta.runSince = undefined
    live.turnPending = false
    live.meta.status = 'idle'
    const ESC = '\x1b'
    const tick = (d) => `${ESC}[2C${ESC}[8A${ESC}[?25h${ESC}]0;\u25d1 Taskdriver handoff continuation\x07${ESC}[?25l${ESC}[2D${ESC}[8B\r${ESC}[101C${ESC}[1A${ESC}[38;2;153;153;153m${d}${ESC}[39m\r\r\n`
    const ask15 = { prompt: 'continue', steps: ['continue work'], seconds: 15 }
    const verdict = () => { manager.cancelAutoClear(id, 'cancelled'); return manager.armAutoClear(id, ask15).reason ?? '' }

    printedAgo(live, 30_000)
    for (let d = 1; d <= 5; d++) live.proc.data(tick(d))
    assert.ok(Date.now() - live.meta.lastOutput < 1000, 'the ticks are output: the raw stamp every other reading keeps still moves')
    assert.ok(Date.now() - live.contentAt >= 29_000, 'but they are not what the quiet floor waits on')
    assert.doesNotMatch(verdict(), /settle/, 'a finished pane with only a ticking footer is armed, not held for ever')
    assert.ok(live.meta.autoClearAt, 'and the countdown is on screen')

    manager.cancelAutoClear(id, 'cancelled')
    printedAgo(live, 30_000)
    live.proc.data(`${ESC}[1m  Checking the second thing now, the fix is in.${ESC}[22m\r\n`)
    live.proc.data(tick(6))
    assert.match(verdict(), /settle/, 'a reply printed a moment ago still holds the clear, ticks or not')
    assert.equal(live.meta.autoClearAt, undefined, 'and no countdown is drawn over it')
  }
  console.log('autoclear manager: delayed handoff and draft guards behaved')
} finally {
  global.setTimeout = realTimers
}
