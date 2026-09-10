// Whether a chat that cleared itself may hand its copy of the project back.
//
// Worth its own test because the expensive failure is silent: moving a pane restarts the
// CLI, so a move decided one beat too early kills a running turn and throws away the
// prompt queued behind it, leaving a pane that looks idle and green. That is what
// happened on 2026-09-10, and nothing in the suite would have caught it.
//
//   node scripts/lane-return-test.mjs

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The module is TypeScript and the only TypeScript in it is the types, so they are
// stripped and it is imported as plain ESM - the test runs against the same source the
// app does. A new type name in a signature must be added to the last replace below.
const src = readFileSync(join(here, '..', 'src', 'shared', 'laneReturn.ts'), 'utf8')
const js = src
  .replace(/^export interface [\s\S]*?^}$/gm, '')
  .replace(/^export type LaneReturn =[\s\S]*?^  \| \{ move: true \}$/gm, '')
  .replace(/: (LanePane \| undefined|LaneReturn)/g, '')
const dir = join(tmpdir(), 'paneforge-lanereturn-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'laneReturn.mjs')
writeFileSync(mod, js, 'utf8')
// A bare Windows path (`C:\\...`) is not a legal ESM specifier - it must be a file:// URL.
const { mayReturnLane, MID_TURN_WORDS } = await import(pathToFileURL(mod).href)

let checks = 0
const fails = []
function is(got, want, what) {
  checks++
  if (got !== want) fails.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

const inLane = { lane: 'a', status: 'idle', cwd: '/p/PaneForge-a' }

// A pane sitting quietly in a copy gives it back.
is(mayReturnLane(inLane, inLane).move, true, 'quiet pane in a copy moves home')

// Mid-turn, both readings of it. Either one alone must refuse.
is(mayReturnLane(inLane, { ...inLane, runSince: Date.now() }).move, false, 'a turn running refuses')
is(mayReturnLane(inLane, { ...inLane, runSince: Date.now() }).why, 'mid-turn', 'and says why')
is(mayReturnLane(inLane, { ...inLane, status: 'working' }).move, false, 'a working pane refuses')
is(mayReturnLane(inLane, { ...inLane, status: 'working' }).why, 'mid-turn', 'and says why')

// A turn that started at the epoch is still a turn: the check is presence, not truthiness
// of a clock somebody may have zeroed.
is(mayReturnLane(inLane, { ...inLane, runSince: 1 }).move, false, 'the smallest runSince still refuses')

// The pane is TOLD, in words with no machinery in them.
const said = mayReturnLane(inLane, { ...inLane, status: 'working' }).say
is(said, MID_TURN_WORDS, 'the refusal carries the sentence')
is(/lane|worktree|checkout|trunk/i.test(said), false, 'and the sentence names no machinery')

// Nothing to give back.
is(mayReturnLane({ status: 'idle', cwd: '/p/PaneForge' }, inLane).why, 'no-lane', 'a pane in no copy is not ours')
is(mayReturnLane(undefined, inLane).why, 'no-lane', 'a pane that was already gone is not ours')

// Gone between the two readings.
is(mayReturnLane(inLane, undefined).why, 'gone', 'a pane that vanished is left alone')
is(mayReturnLane(inLane, { ...inLane, status: 'exited' }).why, 'gone', 'a closed pane is left alone')
is(mayReturnLane(inLane, { ...inLane, lane: undefined }).why, 'gone', 'a pane already handed back is left alone')

// Moved by somebody else while we waited.
is(
  mayReturnLane(inLane, { ...inLane, cwd: '/p/PaneForge-b' }).why,
  'moved-already',
  'a pane that changed folder is somebody else'
)

// A refusal is never a move, whatever else it says.
for (const now of [undefined, { ...inLane, status: 'exited' }, { ...inLane, runSince: 5 }]) {
  is(mayReturnLane(inLane, now).move, false, 'every refusal is move:false')
}

if (fails.length) {
  for (const f of fails) console.error('FAIL', f)
  console.error(`lanereturn: ${fails.length} of ${checks} checks failed`)
  process.exit(1)
}
console.log(`lanereturn: ${checks} checks passed`)
