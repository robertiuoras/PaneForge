// Nothing on the main thread may write to disk synchronously in steady state.
//
// 2026-09-07: PaneForge froze completely for over 50 minutes. A sample of the main process
// put 2509 of 2509 samples on the JS thread at 0% CPU, inside
// `uv__run_timers -> RunTimers -> <JS timer callback> -> WriteFileUtf8 -> write(2)`, blocked
// in the kernel while the machine was in a system-wide disk stall. That callback was the
// transcript flush timer in `src/main/history.ts` calling `appendFileSync`. A synchronous
// write on the main thread has no timeout, so the window, every pane, and the local port
// all waited on the kernel with nothing to recover them and nothing written to any log.
//
// So the rule this checks: in the files below, every remaining `appendFileSync(` or
// `writeFileSync(` must carry a `// sync-on-purpose: <why>` comment on the line itself or
// in the three lines above it. The legitimate reasons are all the same shape - quitting,
// going to sleep, an installer about to replace this process - where there is no later turn
// for an asynchronous write to land in.
//
//   node scripts/main-sync-io-test.mjs

import { readFileSync } from 'node:fs'

/** The files converted away from synchronous writes, and kept that way. */
const FILES = [
  'src/main/history.ts',
  'src/main/restore.ts',
  'src/main/strays.ts',
  'src/main/logWrite.ts',
  'src/main/crash.ts',
  'src/main/audit.ts',
  'src/main/autoclearLog.ts',
  'src/main/interventions.ts',
  'src/main/activationLog.ts',
  'src/main/promptArchive.ts',
  'src/main/queuedPrompts.ts',
  'src/main/remoteLogin.ts',
  'src/main/updater.ts',
  'src/main/activity.ts',
  'src/main/laneTimeline.ts'
]

/** A call, not an import: `import { writeFileSync } from 'node:fs'` has no paren after it. */
const SYNC_WRITE = /\b(appendFileSync|writeFileSync)\s*\(/
const REASON = /sync-on-purpose:\s*\S/
/** How far above the call the reason may sit, for a call split across several lines. */
const LOOK_BACK = 3

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

for (const rel of FILES) {
  const lines = read(rel).split('\n')
  const bare = []
  lines.forEach((line, i) => {
    if (!SYNC_WRITE.test(line)) return
    const near = lines.slice(Math.max(0, i - LOOK_BACK), i + 1).join('\n')
    if (!REASON.test(near)) bare.push(`${rel}:${i + 1} ${line.trim().slice(0, 70)}`)
  })
  ok(
    `${rel} has no unexplained synchronous write`,
    bare.length === 0,
    bare.length ? bare.join(' / ') : ''
  )
}

// The annotations above are worth nothing if the hot paths never became asynchronous, so
// the shape of the fix is asserted too rather than only the absence of the old one.
const history = read('src/main/history.ts')
ok(
  'the transcript flush timer writes with fs/promises',
  /import \{[^}]*\bappendFile\b[^}]*\} from 'node:fs\/promises'/.test(history) &&
    /export function flush\(\): Promise<void>/.test(history)
)
ok(
  'the timer callback is the asynchronous flush, not the synchronous one',
  /setTimeout\(\(\) => void flush\(\), FLUSH_MS\)/.test(history)
)
ok(
  'one write chain per session id, so a log keeps the order it was printed in',
  /const writing = new Map<string, Promise<void>>\(\)/.test(history)
)
ok(
  'a runaway pane cannot grow one append without limit',
  /MAX_PENDING_BYTES/.test(history) && /logProblem\(/.test(history)
)
ok(
  'the quit, sleep and read-back paths still have a synchronous flush',
  /export function flushSync\(\): void/.test(history)
)

const restore = read('src/main/restore.ts')
ok(
  'the desk tick writes with fs/promises, write-then-rename kept',
  /import \{ mkdir, rename, writeFile \} from 'node:fs\/promises'/.test(restore) &&
    /await rename\(tmp, file\(\)\)/.test(restore)
)
ok(
  'only the newest desk is queued behind a write in flight',
  /let waiting: \{ desk: Desk; sig: string \} \| null = null/.test(restore) &&
    /let inflight: Promise<void> \| null = null/.test(restore)
)
ok('the quit path still writes the desk synchronously', /function writeDeskSync\(/.test(restore))

const strays = read('src/main/strays.ts')
ok(
  'the stray ledger sampler writes with fs/promises',
  /import \{ mkdir, writeFile \} from 'node:fs\/promises'/.test(strays) &&
    /async function drainLedger\(\)/.test(strays)
)
ok('the exit sweep still writes the ledger synchronously', /function writeLedgerSync\(/.test(strays))

// The five log files the incident listed, all of them written from a sweep, a keystroke or
// a pane's output, all now going through one asynchronous appender.
for (const [rel, fn] of [
  ['src/main/audit.ts', 'appendLog'],
  ['src/main/autoclearLog.ts', 'appendLog'],
  ['src/main/interventions.ts', 'appendLog'],
  ['src/main/activationLog.ts', 'appendLog'],
  ['src/main/promptArchive.ts', 'appendLog'],
  ['src/main/queuedPrompts.ts', 'appendLog'],
  ['src/main/remoteLogin.ts', 'appendLog'],
  ['src/main/updater.ts', 'appendLog'],
  ['src/main/activity.ts', 'writeLatest'],
  ['src/main/laneTimeline.ts', 'writeLatest']
]) {
  ok(`${rel} writes through logWrite.ts`, new RegExp(`\\b${fn}\\(`).test(read(rel)))
}

const index = read('src/main/index.ts')
ok(
  'going to sleep flushes transcripts synchronously, because the battery may not come back',
  /history\.flushSync\(\)/.test(index)
)

console.log(failed ? `\n${failed} failed` : '\nmain sync io: all good')
process.exit(failed ? 1 : 0)
