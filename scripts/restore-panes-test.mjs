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

function run({ failures = [], stagger = false } = {}) {
  const calls = []
  const timers = []
  const sessions = []
  let starts = 0
  const context = {
    restoredThisRun: false,
    process: { env: stagger ? { PF_RESTORE_STAGGER_MS: '1' } : {} },
    MAX_RESTORE: 12,
    DEFAULT_RECOVER: { enabled: false },
    getConfig: () => ({ recover: { enabled: false }, pinnedPanes: [] }),
    clashingRestores: specs => specs.map(() => false),
    resumableTranscript: () => ({ id: 'verified' }),
    heldElsewhere: () => false,
    restoreAsleep: () => false,
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
  const specs = ['one', 'two'].map(title => ({ cwd: '/desk', title, agent: 'codex', resumeId: title, scrollbackId: title }))
  context.restorePanes(specs)
  return {
    calls: () => JSON.parse(JSON.stringify(calls)),
    timers,
    runTimer: () => timers.shift()?.fn()
  }
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
