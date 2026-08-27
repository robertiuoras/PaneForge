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
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync as write
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensure as ensureBridge } from './antigravity-bridge.mjs'

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
const { clearChunks, clampSeconds, readAsk, dropFor, armDecision, clearCommandFor,
  watchDecision, expiryDecision, dropWords, writeCancels,
  WATCH_COOLDOWN_MS, DEFAULT_AUTOCLEAR, MIN_SECONDS, MAX_SECONDS } =
  await import(pathToFileURL(file).href)

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

console.log('a click is not typing')
{
  const ESC = '\x1b'
  // The bug: clicking the pane to READ what was about to be cleared took the card away.
  // `cursorMove.ts` turns a bare click into the arrows that reach the same cell, and they
  // go out through the same `pty:write` a person typing uses.
  ok('an arrow does not cancel', writeCancels(ESC + '[C') === false)
  ok('a run of arrows does not cancel', writeCancels(ESC + '[D' + ESC + '[D' + ESC + '[D') === false)
  ok('application-mode arrows do not cancel', writeCancels(ESC + 'OB') === false)
  ok('an SGR mouse report does not cancel', writeCancels(ESC + '[<0;40;12M') === false)
  ok('an X10 mouse report does not cancel', writeCancels(ESC + '[M' + ' !!') === false)
  ok('nothing at all does not cancel', writeCancels('') === false)
  // The controls: content still stands the countdown down, or a session somebody has gone
  // back to work in is cleared under them.
  ok('a character cancels', writeCancels('h') === true)
  ok('a return cancels', writeCancels('\r') === true)
  ok('a backspace cancels', writeCancels('\x7f') === true)
  ok('a paste cancels', writeCancels('carry on with the plan') === true)
  ok('an arrow with a character after it cancels', writeCancels(ESC + '[Cx') === true)
  // A tab or an escape on its own is not a caret move we generate - it is a keystroke.
  ok('a bare escape cancels', writeCancels(ESC) === true)
  ok('a tab cancels', writeCancels('\t') === true)

  // Source assertion: the rule is worthless if the one caller stops asking it. This is
  // exactly how the feature was dead for a day the first time.
  const idx = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  ok(
    'writePane guards the cancel with it',
    /if \(writeCancels\(data\)\) manager\.cancelAutoClear\(id, 'typed'\)/.test(idx)
  )
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

  // A clear for cost alone: nothing is open, so nothing is typed after it. Typing a resume
  // prompt at a session with no next step burns a turn producing nothing.
  ok('an empty prompt types only the clear', JSON.stringify(clearChunks('')) === JSON.stringify(['/clear\r']))
  ok('a blank prompt is an empty one', JSON.stringify(clearChunks('  \n ')) === JSON.stringify(['/clear\r']))
  // Codex has no /clear at all - `/new` starts the fresh conversation. Same three chunks,
  // same split, different first word.
  ok('the command is the CLI\'s own', JSON.stringify(clearChunks('carry on', '/new')) === JSON.stringify(['/new\r', 'carry on', '\r']))
  ok('a promptless codex clear is one chunk', JSON.stringify(clearChunks('', '/new')) === JSON.stringify(['/new\r']))

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
    // The promptless path is the NEW half and the one that could drift silently: the hook
    // changed first, and nothing on this side would have noticed.
    ok(
      'the promptless clear matches the hook too',
      JSON.stringify(hook.paneChunks('')) === JSON.stringify(clearChunks('')),
      JSON.stringify(hook.paneChunks(''))
    )
  }
}

console.log('which CLI, and what it calls starting again')
{
  ok('claude clears', clearCommandFor('claude') === '/clear')
  // Claude Code with two environment variables changed. Same binary, same slash commands,
  // so a new re-skin of it must not have to be added here by hand.
  ok('a claude re-skin clears', clearCommandFor('openrouter') === '/clear' && clearCommandFor('glm') === '/clear')
  ok('codex starts a new conversation', clearCommandFor('codex') === '/new')
  ok('antigravity clears', clearCommandFor('antigravity') === '/clear')
  // The invariant the whole watcher rests on: a CLI we cannot name is never typed into,
  // because `/clear` in something that has no such command is a PROMPT sent to a model.
  ok('an unknown CLI is left alone', clearCommandFor('aider') === null && clearCommandFor('goose') === null)
  ok('a shell pane is left alone', clearCommandFor('shell') === null)
  ok('nothing at all is left alone', clearCommandFor(null) === null && clearCommandFor('') === null && clearCommandFor(undefined) === null)
}

console.log('the pane-side watcher, which drives the CLIs with no Stop hook')
{
  const base = { agent: 'codex', status: 'idle', tokens: 200_000, threshold: 150_000, now: 1_000_000 }
  ok('an oversized idle codex pane is cleared', watchDecision(base) === 'arm')
  ok('an unknown CLI is never typed into', watchDecision({ ...base, agent: 'aider' }) === 'unknown-cli')
  ok('a pane mid-turn is left alone', watchDecision({ ...base, status: 'working' }) === 'busy')
  // Unlike the hook path there is nothing to queue against here - no turn is ending - so a
  // pane that is starting or has exited is simply looked at again next minute.
  ok('a starting pane is left alone', watchDecision({ ...base, status: 'starting' }) === 'busy')
  ok('an exited pane is never typed into', watchDecision({ ...base, status: 'exited' }) === 'busy')
  ok('under the line, nothing happens', watchDecision({ ...base, tokens: 149_999 }) === 'under')
  ok('an unreadable size is not a size of zero', watchDecision({ ...base, tokens: 0 }) === 'under')
  // The CLI writes its token file when it feels like it, so a pane that was just cleared
  // still reads as oversized for a minute. Without this it is cleared again, and again.
  ok('one arm per half hour', watchDecision({ ...base, lastArmMs: base.now - 60_000 }) === 'recent')
  ok('and then it may arm again', watchDecision({ ...base, lastArmMs: base.now - WATCH_COOLDOWN_MS - 1 }) === 'arm')
  ok('the default line is 150k', DEFAULT_AUTOCLEAR.tokens === 150_000 && DEFAULT_AUTOCLEAR.watchNonClaude === true)
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

  // The one waiver of "no prompt, no clear", and it has to be SAID. Measured 2026-08-26:
  // `no_open_steps` was the dominant line in the hook's log and those sessions sat at
  // 185-235k tokens with nothing left to do, paying to re-read a context nobody wanted.
  ok('a cost clear with nothing to carry reads', readAsk({ paneId: 's1', noResume: true })?.noResume === true)
  ok('and it carries an empty prompt', readAsk({ paneId: 's1', noResume: true })?.prompt === '')
  // Nothing to resume means nothing to list, or the card promises work it will not do.
  ok('steps sent with it are dropped', readAsk({ paneId: 's1', noResume: true, steps: ['a', 'b'] })?.steps.length === 0)
  ok('a prompt sent with it is dropped', readAsk({ paneId: 's1', noResume: true, prompt: 'go' })?.prompt === '')
  // `=== true`, never truthiness: this arrives over the phone server, and a payload that
  // merely looks affirmative must land on the old rule rather than on a promptless clear.
  ok('a truthy noResume is not a noResume', readAsk({ paneId: 's1', noResume: 1 }) === null)
  ok('the string "true" is not a noResume', readAsk({ paneId: 's1', noResume: 'true' }) === null)
  ok('noResume false still needs a prompt', readAsk({ paneId: 's1', noResume: false }) === null)
  ok('and it still needs a pane', readAsk({ noResume: true }) === null)
  ok('an ordinary ask is not a noResume', readAsk({ paneId: 's1', prompt: 'go' })?.noResume === false)
}

console.log('refusals - the whole point of the countdown')
{
  ok('a pane mid-turn is never cleared', dropFor({ runSince: Date.now() }) === 'working')
  // The agent asked a PERSON something. Clearing throws away the question and the
  // conversation that raised it, and every idle reading in the app says this pane is quiet.
  ok('a pane holding a question is never cleared', dropFor({ ask: { options: [] } }) === 'asked')
  ok('a pane that went away is not cleared', dropFor(null) === 'gone')
  ok('an idle pane with nothing pending is fine', dropFor({}) === null)
  // 2026-08-25: a message being typed was destroyed by a countdown that armed after the
  // keystrokes stopped. `/clear` is typed into the same pty, so it lands on the end of the
  // draft line - `their words/clear` runs and the draft is gone.
  ok('a pane holding an unsent draft is never cleared', dropFor({ typed: 'half a message' }) === 'drafting')
  ok('an empty draft is not a draft', dropFor({ typed: '   ' }) === null)
  // Queued, not refused: the draft is sent or abandoned within the turn, and the session is
  // still oversized afterwards.
  ok('a draft queues the clear rather than throwing it away', armDecision('drafting') === 'queue')
  ok('a question still refuses outright', armDecision('asked') === 'refuse')
  ok('a mid-turn pane still queues', armDecision('working') === 'queue')
  ok('nothing wrong still arms', armDecision(null) === 'arm')
}

console.log('what the timer does when it finally fires - the s2 incident (ADDENDUM 2026-08-27)')
{
  // Pane s2's countdown reached zero and typed nothing, and the old timer body had three
  // silent exits so the branch taken could not be proven afterwards. Every branch is now
  // a named verdict; these pin each one.
  const base = { exists: true, metaAt: 5000, armedAt: 5000, now: 5000, drop: null }
  // (b) a clean pane fires - and what it types is the FROZEN chunks, whose exact content
  // the keystroke checks above already pin against the hook.
  ok('a clean pane fires', expiryDecision(base) === 'fire')
  ok('mid-turn still fires - the pty queues it to the turn boundary', expiryDecision({ ...base, drop: 'working' }) === 'fire')
  // (c) a draft at expiry stands down, with a reason a person can read in the log.
  ok('a draft at expiry stands down', expiryDecision({ ...base, drop: 'drafting' }) === 'drafting')
  ok('and the reason has words', dropWords('drafting').includes('unsent'))
  ok('a question at expiry stands down', expiryDecision({ ...base, drop: 'asked' }) === 'asked')
  ok('a vanished pane does nothing at all', expiryDecision({ ...base, exists: false, metaAt: undefined, drop: 'gone' }) === 'vanished')
  // A LATER arm owns the meta: its own timer is live, this one must not touch it.
  ok('a newer countdown is left alone', expiryDecision({ ...base, metaAt: 9000 }) === 'foreign')
  // (a) the guard-mismatch path: meta that no live countdown owns is cleaned up rather
  // than left to hold the toast at 0:00 forever - which is exactly what Robert watched.
  ok('stale meta is cleaned up, not skipped', expiryDecision({ ...base, metaAt: 1000 }) === 'stale')
  ok('missing meta reads as stale too', expiryDecision({ ...base, metaAt: undefined }) === 'stale')
}

console.log('the antigravity statusline tee - somebody else\'s file, on their machine')
{
  // Never the real `~/.gemini/antigravity-cli/statusline.sh`: this is the script that draws
  // Robert's prompt, and a test that edits it is a test that can break it. Copies only.
  const home = join(out, 'agy')
  mkdirSync(home, { recursive: true })
  const sl = join(home, 'statusline.sh')
  write(sl, '#!/usr/bin/env bash\nread -r line\nprintf "model | %s\\n" "${#line}"\n', 'utf8')
  chmodSync(sl, 0o755)
  const original = readFileSync(sl, 'utf8')

  const first = await ensureBridge(home)
  ok('the tee goes in', first.changed === true && !first.created)
  ok('the original is backed up once', first.backedUp === true && existsSync(sl + '.pf-backup'))
  ok('the backup is the file we found', readFileSync(sl + '.pf-backup', 'utf8') === original)
  const after = readFileSync(sl, 'utf8')
  ok('the shebang is still the first line', after.startsWith('#!/usr/bin/env bash\n'))
  ok('the original script is still in there', after.includes('printf "model | %s'))

  // The property the whole design rests on: this runs at EVERY app start.
  const second = await ensureBridge(home)
  ok('the second run changes nothing', second.changed === false && second.backedUp === false)
  ok('and the file is byte-identical', readFileSync(sl, 'utf8') === after)

  // And it has to actually work: stdin teed to the log, then handed back untouched.
  const feed = JSON.stringify({
    workspace: { current_dir: '/tmp/demo' },
    context_window: { context_window_size: 1_000_000, used_percentage: 19, total_input_tokens: 190_000 }
  })
  const printed = execFileSync('bash', [sl], { input: feed, encoding: 'utf8' })
  ok('the original output is untouched', printed === `model | ${feed.length}\n`)
  const log = join(home, 'pf-context.jsonl')
  ok('a row landed', existsSync(log))
  const row = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop())
  ok('with the tokens on it', row.context_window?.total_input_tokens === 190_000)
  ok('and with the folder, which is how two panes are told apart', row.workspace?.current_dir === '/tmp/demo')
  ok('and a timestamp of our own', typeof row.pf_ts === 'number' && row.pf_ts > 0)
  execFileSync('bash', [sl], { input: feed, encoding: 'utf8' })
  ok('rows accumulate', readFileSync(log, 'utf8').trim().split('\n').length === 2)
  // An empty object is the one input that would otherwise produce `{"pf_ts":1,}`.
  execFileSync('bash', [sl], { input: '{}', encoding: 'utf8' })
  ok('an empty object is still valid JSON', typeof JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop()).pf_ts === 'number')

  // A machine that has never run the CLI must not get a folder full of state for it.
  const nowhere = await ensureBridge(join(out, 'not-installed'))
  ok('a machine without antigravity is left alone', !!nowhere.skipped && nowhere.changed === false)

  // The real hook, copied, because a synthetic one proves nothing about the file that is
  // actually out there - it reads stdin through a process substitution and 10.5 KB of jq.
  const real = join(homedir(), '.gemini', 'antigravity-cli', 'statusline.sh')
  if (!existsSync(real)) {
    console.log('  SKIP antigravity is not installed here - the real hook is unchecked')
  } else {
    const copyDir = join(out, 'agy-real')
    mkdirSync(copyDir, { recursive: true })
    copyFileSync(real, join(copyDir, 'statusline.sh'))
    const a = await ensureBridge(copyDir)
    const text = readFileSync(join(copyDir, 'statusline.sh'), 'utf8')
    const b = await ensureBridge(copyDir)
    ok('the real hook takes the tee', a.changed === true)
    ok('and does not take it twice', b.changed === false && readFileSync(join(copyDir, 'statusline.sh'), 'utf8') === text)
    ok('the tee is above the original script', text.indexOf('paneforge autoclear bridge') < text.indexOf('locate jq'))
  }
}

rmSync(out, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
