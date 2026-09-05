import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const registration = source.match(/powerMonitor\.on\('suspend', \(\) => \{[\s\S]*?\n  \}\)/)?.[0]
assert.ok(registration, 'main registers a suspend checkpoint')
const powerMonitor = new EventEmitter()
let pendingDesk = true, pendingHistory = true
const writes = []
runInNewContext(registration, {
  powerMonitor,
  noteDesk(immediate) {
    assert.equal(immediate, true, 'sleep cannot wait for the debounce timer')
    pendingDesk = false
    writes.push('desk')
  },
  history: { flush() { pendingHistory = false; writes.push('history') } },
  updateLog() { writes.push('receipt') }
})
assert.equal(pendingDesk, true, 'registering does not prematurely save the desk')
powerMonitor.emit('suspend')
assert.deepEqual(writes, ['desk', 'history', 'receipt'])
assert.equal(pendingDesk || pendingHistory, false, 'all app buffers saved synchronously before sleep')
// No process stop/restart capability is provided: touching one would fail this test.
powerMonitor.emit('suspend')
assert.equal(writes.length, 6, 'a subsequent sleep also saves')
console.log('Suspend checkpoint: immediate desk/history save, repeat sleep, no agent teardown passed')
