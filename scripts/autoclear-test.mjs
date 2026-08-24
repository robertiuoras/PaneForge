// A session that clears ITSELF: the parts that must not drift.
//
// The bug this was written after is not in any of the logic below - it is that the logic
// did not EXIST. `claude-config/pane-clear.mjs` called `autoclear:ask`, PaneForge had never
// implemented that channel, and the call failed inside a detached child with
// `stdio: 'ignore'` while the hook had already written `cleared` to its state file. Five
// clears were logged on 2026-08-23 (03:23, 03:33, 06:13, 07:13, 08:07); not one happened
// and not one could retry. So the load-bearing check here is the PARITY one: the app's
// keystrokes and the hook's are asserted equal, because two copies of one contract that
// nobody compares is exactly how this got lost.

import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync as write } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-autoclear-'))
let checks = 0
let failures = 0
const ok = (what, cond, detail = '') => {
  checks++
  if (cond) return console.log(`  ok   ${what}`)
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

const entry = join(out, 'entry.ts')
write(
  entry,
  `export * from ${JSON.stringify(join(root, 'src/shared/autoclear.ts').replace(/\\\\/g, '/'))}`,
  'utf8'
)
const file = join(out, 'ac.mjs')
buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', logLevel: 'warning', outfile: file })
const { clearChunks, clampSeconds, readAsk, dropFor, armDecision, MIN_SECONDS, MAX_SECONDS } = await import(pathToFileURL(file).href)

console.log('a busy pane WAITS, it is not refused')
{
  // The Stop hook fires inside the turn it is ending, so this is the normal case, not
  // an edge one. Refusing it is what stopped every clear on 2026-08-24.
  ok('mid-turn queues', armDecision('working') === 'queue')
  ok('idle arms', armDecision(null) === 'arm')
  ok('a pending question refuses', armDecision('asked') === 'refuse')
  ok('a closed pane refuses', armDecision('gone') === 'refuse')
  ok('typing refuses', armDecision('typed') === 'refuse')
}

console.log('keystrokes')
{
  const chunks = clearChunks('carry on')
  ok('the clear is its own chunk', chunks[0] === '/clear\r')
  // The bug: a long chunk arriving in one pty read is a PASTE to Claude Code, and a CR
  // inside a paste is a newline rather than a submit - so the resume prompt sat unsent in
  // the box after a clear that had otherwise worked.
  ok('the prompt carries no return of its own', chunks[1] === 'carry on' && !chunks[1].includes('\r'))
  ok('the submit is the third chunk, alone', chunks[2] === '\r' && chunks.length === 3)

  // PARITY. Two copies of one contract, in two repos, and nothing compared them.
  const hook = await import(pathToFileURL('/Users/robertiuoras/Projects/claude-memory/claude-config/autoclear.mjs').href).catch(() => null)
  if (!hook?.paneChunks) {
    console.log('  SKIP the hook is not on this machine - parity unchecked')
  } else {
    ok(
      'the app types exactly what the hook says it will',
      JSON.stringify(hook.paneChunks('carry on')) === JSON.stringify(chunks),
      JSON.stringify(hook.paneChunks('carry on'))
    )
  }
}

console.log('the payload, which arrives over the phone server')
{
  ok('a good ask reads', readAsk({ paneId: 's1', prompt: 'go', steps: ['a'], seconds: 45 })?.seconds === 45)
  // Clearing a session and then typing NOTHING is the one outcome worse than not
  // clearing: the context is gone and nothing says what it was doing.
  ok('no prompt is refused', readAsk({ paneId: 's1', steps: ['a'], seconds: 45 }) === null)
  ok('no pane is refused', readAsk({ prompt: 'go' }) === null)
  ok('junk is refused', readAsk('/clear') === null && readAsk(null) === null)
  ok('steps that are not strings are dropped', readAsk({ paneId: 's1', prompt: 'go', steps: [1, 'a', null] })?.steps.length === 1)
  ok('seconds are clamped, not trusted', clampSeconds(99999) === MAX_SECONDS && clampSeconds(-4) === MIN_SECONDS)
  ok('a missing seconds is a default, never zero', clampSeconds(undefined) >= MIN_SECONDS)
}

console.log('refusals - the whole point of the countdown')
{
  ok('a pane mid-turn is never cleared', dropFor({ runSince: Date.now() }) === 'working')
  // The agent asked a PERSON something. Clearing throws away the question and the
  // conversation that raised it, and every idle reading in the app says this pane is quiet.
  ok('a pane holding a question is never cleared', dropFor({ ask: { options: [] } }) === 'asked')
  ok('a pane that went away is not cleared', dropFor(null) === 'gone')
  ok('an idle pane with nothing pending is fine', dropFor({}) === null)
}

rmSync(out, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
