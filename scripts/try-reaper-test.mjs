// The reaper's decision: close a test copy whose chat is gone or idle 15+ minutes.
import assert from 'node:assert/strict'
import { decide } from './try-reaper.mjs'

const MIN = 60000
const list = (state) => `1\ts5-aaa\tworking\tOther\t/x\n2\ts23-bbb\t${state}\tMine\t/y\n`
const base = { paneId: 's23-bbb', now: 100 * MIN, lastWorkingAt: 100 * MIN, pidAlive: true }
const run = (o) => decide({ ...base, ...o })

assert.equal(run({ listText: '1\ts5-aaa\tworking\tOther\t/x\n' }).action, 'close', 'gone pane closes')
assert.equal(run({ listText: list('working'), lastWorkingAt: 0 }).action, 'keep', 'working pane keeps')
assert.equal(run({ listText: list('working'), lastWorkingAt: 0 }).lastWorkingAt, 100 * MIN, 'working resets the idle clock')
assert.equal(run({ listText: list('idle'), lastWorkingAt: 86 * MIN }).action, 'keep', 'idle 14 min keeps')
assert.equal(run({ listText: list('idle'), lastWorkingAt: 85 * MIN }).action, 'close', 'idle 15 min closes')
assert.equal(run({ listText: list('idle'), lastWorkingAt: 0 }).action, 'close', 'idle long closes')
assert.equal(run({ listText: list('working'), pidAlive: false }).action, 'exit', 'copy gone exits')
assert.equal(run({ paneId: '2', listText: list('idle'), lastWorkingAt: 99 * MIN }).action, 'keep', 'pane number matches')
console.log('try-reaper: all decisions pass')
