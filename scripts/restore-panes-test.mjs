// Run the real restorePanes body with a tiny main-process harness.
//
// This holds the caller contract that the disk test cannot see: no desk is
// consumed before a pane starts, partial failures remain held, and a staggered
// handoff still has its recovery copy if the process stops between starts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8')

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `could not find ${name}`)
  let at = source.indexOf('{', start)
  let depth = 0
  for (; at < source.length; at++) {
    if (source[at] === '{') depth++
    else if (source[at] === '}' && --depth === 0) return source.slice(start, at + 1)
  }
  throw new Error(`could not close ${name}`)
}

const code = transformSync(`${functionSource('restoreStaggerMs')}\n${functionSource('restorePanes')}\nglobalThis.restorePanes = restorePanes`, {
  loader: 'ts', format: 'cjs', target: 'node20'
}).code

function run({ failures = [], stagger = false, inProgress, asleep = false, wasWorking = false, titles = ['one', 'two'] } = {}) {
  const calls = []
  const timers = []
  const sessions = []
  const requests = []
  let starts = 0
  const context = {
    restoredThisRun: false,
    process: { env: stagger ? { PF_RESTORE_STAGGER_MS: '1' } : {} },
    MAX_RESTORE: 12,
    DEFAULT_RECOVER: { enabled: false },
    getConfig: () => ({ recover: { enabled: false }, pinnedPanes: [] }),
    clashingRestores: specs => specs.map(() => false),
    resumableTranscript: () => ({ id: 'verified' }),
    rolloutTurn: () => ({ inProgress }),
    heldElsewhere: () => false,
    restoreAsleep: req => !req.wasWorking,
    basename: path => path,
    setConfig: () => {},
    send: () => {},
    setDeskHold: desk => calls.push(['hold', desk?.specs.map(s => s.title)]),
    clearDesk: recovery => calls.push(['clear', recovery?.specs.map(s => s.title)]),
    completeDeskRecovery: () => calls.push(['complete']),
    saveDesk: specs => calls.push(['save', specs.map(s => s.title)]),
    manager: {
      snapshot: () => sessions,
      start: req => {
        requests.push(req)
        calls.push(['start', req.title])
        if (failures.includes(starts++)) throw new Error('start failed')
        const session = { id: `new-${starts}`, title: req.title, resumeId: req.resumeId, scrollbackId: req.scrollbackId }
        sessions.push(session)
        return session
      },
      deliverOwed: () => {}
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length },
    Set,
    Boolean
  }
  vm.createContext(context)
  new vm.Script(code).runInContext(context)
  const specs = titles.map(title => ({ cwd: '/desk', title, agent: 'codex', resumeId: title, scrollbackId: title, wasWorking, asleep }))
  context.restorePanes(specs)
  return {
    calls: () => JSON.parse(JSON.stringify(calls)),
    timers,
    requests,
    runTimer: () => timers.shift()?.fn()
  }
}

// Every saved pane comes back; the cap is on agents STARTED. 2026-09-23 06:46: a crash
// left 13 panes and the desk offered 12 - the thirteenth was never seen again.
{
  const titles = Array.from({ length: 14 }, (_, i) => `pane-${i + 1}`)
  const many = run({ titles, wasWorking: true })
  assert.equal(many.requests.length, 14, 'every one of fourteen saved panes is started')
  assert.deepEqual(many.requests.map(r => Boolean(r.asleep)),
    [...Array(12).fill(false), true, true],
    'twelve come back running (all were mid-turn), the rest asleep rather than left out')
}

const allFailed = run({ failures: [0, 1] })
assert.deepEqual(allFailed.calls(), [
  ['hold', ['one', 'two']], ['start', 'one'], ['start', 'two'], ['hold', ['one', 'two']], ['save', []]
], 'all failures retain every requested pane without consuming the desk')

const partial = run({ failures: [1] })
assert.deepEqual(partial.calls(), [
  ['hold', ['one', 'two']], ['start', 'one'], ['clear', ['one', 'two']], ['hold', ['two']], ['save', ['one']],
  ['start', 'two'], ['hold', ['two']], ['save', ['one']]
], 'the first real pane claims the desk, while the failed row remains held')

const staggered = run({ stagger: true })
assert.deepEqual(staggered.calls(), [['hold', ['one', 'two']]], 'staggered starts hold every unstarted pane before their timer runs')
staggered.runTimer()
assert.deepEqual(staggered.calls(), [['hold', ['one', 'two']], ['start', 'one'], ['clear', ['one', 'two']], ['hold', ['two']], ['save', ['one']]],
  'an interruption after the first staggered start retains the previous desk for recovery')
staggered.runTimer()
staggered.runTimer()
assert.deepEqual(staggered.calls().slice(-2), [['complete'], ['save', ['one', 'two']]],
  'successful completion requests a final durable snapshot before consuming recovery')

console.log('restore panes: failure, interruption, and completed recovery checks passed')

const interrupted = run({ inProgress: true })
assert.equal(interrupted.requests[1].wasWorking, true, 'native unfinished turn repairs a false saved flag')
assert.equal(interrupted.requests[1].asleep, false, 'missed working pane wakes for continuation')
assert.equal(run({ inProgress: false }).requests[1].wasWorking, false, 'finished native turn stays finished')
assert.equal(run({ inProgress: false, wasWorking: true }).requests[1].wasWorking, false, 'native completion overrides a stale working flag')
assert.equal(run({ wasWorking: true }).requests[1].wasWorking, true, 'unknown native state preserves saved recovery evidence')
assert.equal(run({ inProgress: true, asleep: true }).requests[1].asleep, true, 'explicit sleep is preserved')

// Exercise the real offer -> answer IPC path, where display rows used to discard
// wasWorking and silently turn every interrupted conversation into an idle pane.
const offerStart = source.indexOf('function makeRestoreOffer(')
const offerEnd = source.indexOf('\n/**', offerStart)
const answerStart = source.indexOf("ipcMain.on('restore:answer'")
const answerEnd = source.indexOf('\n\napp.whenReady()', answerStart)
const offered = [
  { cwd: '/one', title: 'finished', agent: 'codex', resumeId: 'done', wasWorking: false },
  { cwd: '/two', title: 'interrupted', agent: 'claude', resumeId: 'exact-thread', resumeCwd: '/original',
    wasWorking: true, openedAt: 123, lastRunMs: 456, engaged: true, scrollbackId: 'old-pane',
    lane: 'c', laneEnv: { PORT: '3002' }, arrivedFrom: 'pc', effort: { mode: 'manual', manual: 'high' } },
  { cwd: '/missing', title: 'missing', agent: 'codex', resumeId: 'missing' }
]
let answerHandler
let restored
const offerContext = {
  offeredSpecs: [], offer: null, MAX_RESTORE: 12,
  describe: (s, i) => ({ id: String(i), cwd: s.cwd, title: s.title, agent: s.agent, gone: i === 2 ? 'folder' : undefined }),
  restorePlan: () => ({ fits: 2, note: '' }), totalMb: () => 10000, readPressure: () => 0,
  manager: { list: () => [], snapshot: () => [] }, setDeskHold: () => {}, setConfig: () => {},
  updateLog: () => {}, clearDesk: () => {}, saveDesk: () => {},
  restorePanes: (specs, previous) => { restored = { specs, previous } },
  ipcMain: { on: (_channel, handler) => { answerHandler = handler } }
}
vm.createContext(offerContext)
new vm.Script(transformSync(source.slice(offerStart, offerEnd) + '\n' + source.slice(answerStart, answerEnd),
  { loader: 'ts', format: 'cjs', target: 'node20' }).code).runInContext(offerContext)
{
  const lots = Array.from({ length: 13 }, (_, i) => ({ cwd: `/p${i}`, title: `p${i}`, agent: 'codex', resumeId: `r${i}` }))
  const big = offerContext.makeRestoreOffer({ specs: lots, at: 100, clean: false })
  assert.equal(big.panes.length, 13, 'the offer lists every saved pane, not the first twelve')
  assert.equal('extra' in big, false, 'nothing is set aside as not offered')
}
offerContext.offer = offerContext.makeRestoreOffer({ specs: offered, at: 100, clean: false }, true)
answerHandler(null, { accept: true, ids: ['1', '2', 'made-up'] })
assert.deepEqual(JSON.parse(JSON.stringify(restored)), { specs: [offered[1]], previous: true },
  'selected pane retains exact launch/recovery state; missing and unknown rows cannot start')
assert.equal(offerContext.offer, null)
assert.equal(offerContext.offeredSpecs.length, 0, 'consumed selection does not leak into the next offer')
restored = undefined
answerHandler(null, { accept: true, ids: ['1'] })
assert.equal(restored, undefined, 'duplicate answer never continues the same turn twice')
console.log('restore offer: exact conversation, interrupted turn, selection and duplicate answer checks passed')
