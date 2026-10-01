// "Keep this pane open" has to survive the restart it exists for.
//
// A restored pane is a NEW session with a new id, so `restorePanes` rewrites
// `config.pinnedPanes` through each pane's `scrollbackId`. Two things made that rewrite
// invisible, and between them a pin never once survived a restart:
//
//  - it is written with `setConfig`, which writes the file and broadcasts NOTHING. Only
//    the `config:set` IPC handler sends `config:changed`. So no window heard it.
//  - the window read the list ONCE, latched on the first config to arrive - and on the
//    ask-after-restart path the restore does not begin until somebody answers a dialog,
//    long after that. The window held the ids of the panes that had just been replaced.
//
// A restored pane comes back ASLEEP, and a sleeping pane is exactly what the idle CLOSE
// clock takes (`ReclaimPane.asleep`) - `pinned` is its only refusal. So the visible bug
// is Robert's, 2026-09-05: "why paneforge trying to close asleep sessions while they had
// kept open enabled".
//
// A third one was latent: `nowPinned` is filled inside `open`, and `open` runs on a timer
// whenever the restore is staggered - so read synchronously it is EMPTY and the list is
// rewritten to nothing by the very code that carries it across.
//
//   node scripts/pin-restore-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const from = index.indexOf('function restorePanes(')
check('restorePanes is still there', from > 0)
const restore = index.slice(from, index.indexOf('\n}\n', from))

check('the pin is still carried across the new ids', /wasPinned\.has\(req\.scrollbackId\)/.test(restore))
check(
  'the rewrite is announced, not only written',
  /setConfig\(\{ pinnedPanes: mergedPins \}\)[\s\S]{0,600}?send\('config:changed'/.test(restore),
  'setConfig writes the file and broadcasts nothing'
)
check(
  'the bookkeeping waits for the panes it is counting',
  /const settle = \(done: \(\) => void\): void => \{[\s\S]*?if \(gap\) setTimeout\(done, gap \* opening\.length/.test(restore)
)
check(
  'and the rewrite happens inside that wait',
  restore.indexOf('settle(') < restore.indexOf('setConfig({ pinnedPanes: mergedPins })'),
  'a synchronous read of nowPinned during a staggered restore is empty'
)
check(
  'pins made while restore waits survive the old-id translation',
  /const current = getConfig\(\)\.pinnedPanes \?\? \[\][\s\S]*?current\.filter\(\(id\) => !restoredOldIds\.has\(id\)\)[\s\S]*?nowPinned/.test(restore)
)

// `setConfig` is the half that cannot be relied on to tell anybody. If that ever changes
// the `send` above becomes harmless duplication rather than a bug - but the assertion is
// worth keeping either way, because it is the reason the send is there.
const cfg = readFileSync(join(root, 'src/main/config.ts'), 'utf8')
const setCfg = cfg.slice(cfg.indexOf('export function setConfig('))
check(
  'setConfig itself still tells no window',
  !/config:changed/.test(setCfg.slice(0, setCfg.indexOf('\n}\n'))),
  'if this fails the explicit send is now duplication'
)

const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
check(
  'the window no longer latches on the first config it sees',
  !/pinnedLoaded/.test(app),
  'a reading taken before the restore is the wrong one'
)
check(
  'it adopts a saved list that is not the one it wrote',
  /if \(key === pinsWritten\.current\) return/.test(app)
)
check('and remembers what it writes, so its own echo is ignored', /pinsWritten\.current = \[\.\.\.\(saved\.pinnedPanes \?\? \[\]\)\]\.sort\(\)\.join\(','\)/.test(app))
check(
  'the comparison is order-independent',
  /\[\.\.\.saved\]\.sort\(\)\.join\(','\)/.test(app),
  'config.json holds a list, and the order it comes back in is not promised'
)

// The whole point of the pin, and the reason losing it is not cosmetic.
const reclaim = readFileSync(join(root, 'src/shared/reclaim.ts'), 'utf8')
const keepable = reclaim.slice(reclaim.indexOf('function keepable('))
check('a pinned pane is refused by the close clock', /!p\.pinned/.test(keepable.slice(0, keepable.indexOf('\n}'))))
check(
  'and a sleeping one is not - which is why the pin has to survive',
  !/!p\.asleep/.test(keepable.slice(0, keepable.indexOf('\n}')))
)

// The wake timing, the other half of the same report ("laggy to open again").
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
check('a wake is stamped', /live\.wokeAt = Date\.now\(\)/.test(sessions))
check('and the gap to the first byte is written down', /action: 'wake-printed'/.test(sessions))
check(
  'measured to the FIRST byte, not to every one of them',
  /if \(firstByte && live\.wokeAt\)/.test(sessions)
)
check('and the stamp is cleared, so it is one line per wake', /live\.wokeAt = 0/.test(sessions))

// Execute the real callback against a mixed desk, including a filtered-out local pane.
const { transformSync } = await import('esbuild')
const callbackStart = app.indexOf('async (ids: string[], keep: boolean) => {', app.indexOf('const savePins ='))
const callbackEnd = app.indexOf(', [sessions, flash])', callbackStart)
const callback = transformSync(`const save = ${app.slice(callbackStart, callbackEnd)}`, { loader: 'ts', format: 'cjs' }).code
let savedPins = ['existing']
const remoteCalls = [], errors = []
const savingStates = []
let remoteOK = true
let configGate
const ref = { current: false }
const desk = [{ id: 'visible' }, { id: 'filtered-out' }, { id: '@pc/one', remote: { name: 'PC' } }]
const api = {
  getConfig: async () => { if (configGate) await configGate; return { pinnedPanes: savedPins } },
  setConfig: async patch => { savedPins = patch.pinnedPanes; return patch },
  setRemoteKeepOpen: async (id, keep) => { remoteCalls.push([id, keep]); return remoteOK }
}
const save = new Function('api', 'sessions', 'savingPinsRef', 'setSavingPins', 'pinsWritten', 'setPinned', 'setConfigState', 'setCloseSoons', 'flash', callback + '; return save')(
  api, desk, ref, value => savingStates.push(value), { current: '' }, () => {}, () => {}, () => {}, e => errors.push(e))
await save(desk.map(s => s.id), true)
assert.deepEqual(savedPins, ['existing', 'visible', 'filtered-out'])
assert.deepEqual(remoteCalls, [['@pc/one', true]])
await save(['visible'], false)
assert.deepEqual(savedPins, ['existing', 'filtered-out'], 'unchecking one session preserves every other selection')
await save(desk.map(s => s.id), false)
assert.deepEqual(savedPins, ['existing'])
remoteOK = false
await save(['@pc/one'], true)
assert.match(errors[0], /Could not save on PC/)
assert.equal(ref.current, false, 'failed remote write releases the save lock')
check('select-all persists hidden local panes, uses the remote owner, and reports failure', true)
let resumeConfig
configGate = new Promise(resolve => { resumeConfig = resolve })
const pending = save(['visible'], true)
assert.equal(savingStates.at(-1), true, 'controls disable while the saved preference is pending')
await save(['filtered-out'], true)
resumeConfig()
await pending
assert.deepEqual(savedPins, ['existing', 'visible'], 'a second press cannot race the pending selection')
assert.equal(savingStates.at(-1), false, 'controls enable after the write finishes')

// A renderer timer queued before the pin was saved cannot close the now-kept pane.
const closeStart = index.indexOf("ipcMain.handle('sessions:closeIntoReview'")
const closeEnd = index.indexOf("ipcMain.handle('sessions:clearFinished'", closeStart)
const closeCode = transformSync(index.slice(closeStart, closeEnd), { loader: 'ts' }).code
let closeHandler, keep = true, closed = 0, owedFlag = false, owedRows = 0
const refused = []
new Function('ipcMain', 'keptOpen', 'remote', 'closePane', 'manager', 'owedCount', 'logReclaim', closeCode)(
  { handle(_name, fn) { closeHandler = fn } }, () => keep, { owns: () => true }, () => { closed++ },
  { list: () => [{ id: 'pane', owedPrompt: owedFlag }] }, () => owedRows, (row) => refused.push(row))
closeHandler({}, 'pane', 'timer expired')
assert.equal(closed, 0, 'saved keep-open wins over an already-dispatched close')
keep = false
// 2026-10-02 18:44Z: the countdown closed six crash-restored panes still owed their
// "continue" (queued-prompts.log LOST x6). Owed work, by flag or by ledger row, refuses.
owedFlag = true
closeHandler({}, 'pane', 'timer expired')
assert.equal(closed, 0, 'a pane flagged as owed a prompt is not closed by the countdown')
owedFlag = false
owedRows = 1
closeHandler({}, 'pane', 'timer expired')
assert.equal(closed, 0, 'a pane with an owed ledger row is not closed by the countdown')
assert.deepEqual(refused.map((r) => r.reason), ['owed-prompt', 'owed-prompt'], 'each refusal is logged')
owedRows = 0
closeHandler({}, 'pane', 'timer expired')
assert.equal(closed, 1, 'unkept panes can still close normally')

console.log(`pin restore: ${checks} checks passed`)
