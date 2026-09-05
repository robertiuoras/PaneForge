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
check('and remembers what it writes, so its own echo is ignored', /pinsWritten\.current = Object\.keys\(next\)\.sort\(\)\.join\(','\)/.test(app))
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

console.log(`pin restore: ${checks} checks passed`)
