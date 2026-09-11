/**
 * A sleep says why it happened, and the log can be read a day later.
 *
 * 2026-09-11: three panes slept at 13:10:47Z and every one of them wrote
 * `reason:"unknown" source:"renderer"`. Nothing in `reclaim.log` could tell an automatic
 * sleep from a hand on the keyboard, so "something slept my session while it was still
 * running" could only be answered by inference. The cause was two hand-written copies of
 * the valid reasons, in `sessions.ts` and in the `sessions:sleep` handler: neither listed
 * `restored` or `handoff`, and the handler rewrote every reason that was not exactly
 * `manual` to `unknown`.
 *
 * This is a SOURCE test, not a behaviour one: the defect is a list drifting from the type,
 * which no amount of exercising one call path catches. It pins that both places read the
 * shared list, that the handler passes a caller's reason through, and that a sleep records
 * how long ago the pane last printed - the number "was it running" is actually asked in.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const types = read('src/shared/types.ts')
const sessions = read('src/main/sessions.ts')
const index = read('src/main/index.ts')

let failed = 0
const ok = (what, cond) => {
  if (!cond) failed++
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`)
}

// The list itself.
const reasons = types.match(/export const SLEEP_REASONS = \[([\s\S]*?)\] as const/)
ok('SLEEP_REASONS is exported from shared/types.ts', Boolean(reasons))
const names = [...(reasons?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
for (const r of ['manual', 'idle', 'pressure', 'queued', 'restored', 'unknown', 'continuation', 'tour', 'handoff']) {
  ok(`a pane can sleep because: ${r}`, names.includes(r))
}
ok('SleepReason is derived from the list, so the two cannot drift', /export type SleepReason = \(typeof SLEEP_REASONS\)\[number\]/.test(types))
ok('SLEEP_SOURCES is exported too', /export const SLEEP_SOURCES = \[/.test(types))
ok('SleepEvidence.source is derived from that list', /source: \(typeof SLEEP_SOURCES\)\[number\]/.test(types))

// No hand-written copy left anywhere. This is the actual defect.
ok(
  'sessions.ts checks the reason against the shared list',
  /\(SLEEP_REASONS as readonly string\[\]\)\.includes\(reason\)/.test(sessions)
)
ok(
  'sessions.ts checks the source against the shared list',
  /\(SLEEP_SOURCES as readonly string\[\]\)\.includes\(evidence\?\.source/.test(sessions)
)
ok(
  'no hand-written reason list is left in sessions.ts',
  !/\['manual', 'idle', 'pressure'/.test(sessions)
)
ok(
  'no hand-written source list is left in sessions.ts',
  !/\['renderer-idle-sweep', 'tour', 'continuation'/.test(sessions)
)

// A reason with no caller behind it is a call site that never had to think.
ok(
  'sleep() has no default reason',
  /sleep\(id: string, reason: SleepReason, evidence\?/.test(sessions)
)

// The handler.
ok(
  'the sleep handler passes a reason the window owns straight through',
  /if \(reason && windowOwns\.includes\(reason\)\)/.test(index)
)
ok(
  'a window may claim idle and pressure, which is what was being lost',
  /const windowOwns = \['manual', 'idle', 'pressure', 'queued'\]/.test(index)
)
ok(
  "...and may not claim main's own words",
  !/windowOwns = \[[^\]]*'continuation'/.test(index) && !/windowOwns = \[[^\]]*'handoff'/.test(index)
)
// The handler is sliced out and run on its own by sleep-cause-test.mjs.
ok('the list lives inside the handler, where that slice can see it', /windowOwns/.test(index.slice(index.indexOf("ipcMain.handle('sessions:sleep'"))))
ok(
  'the handler no longer rewrites everything that is not manual',
  !/reason === 'manual' \? 'manual' : 'unknown'/.test(index)
)
ok(
  'a claim the window does not own still lands as unknown',
  /return manager\.sleep\(id, 'unknown', \{ source: 'renderer' \}\)/.test(index)
)

// What the log has to carry for the next time this question is asked.
ok('a sleep records how long ago the pane printed', /outputAgoMs: live\.meta\.lastOutput/.test(sessions))
ok('and how long ago it was typed into', /keyboardAgoMs: live\.meta\.lastKeyboard/.test(sessions))

// An update takes the whole desk; it must name what it interrupted.
ok(
  'installing an update names the panes it caught mid-turn',
  /const midTurn = manager\.list\(\)\.filter/.test(index) && /mid-turn/.test(index)
)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
