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
const { clearChunks, resumeOf, clampSeconds, readAsk, resumeBrief, dropFor, armDecision, clearCommandFor, quietEnoughToArm, ARM_QUIET_MS,
  watchDecision, expiryDecision, dropWords, DRAFT_RETRY_MS, chunkDelayMs,
  CLEAR_SETTLE_MS, SUBMIT_GAP_MS, SUBMIT_RETRIES_MS, CLEAR_PROMPT_START_MS,
  WATCH_COOLDOWN_MS, DEFAULT_AUTOCLEAR, MIN_SECONDS, MAX_SECONDS, queuedPromptDecision } =
  await import(pathToFileURL(file).href)

console.log('a queued resume prompt never lands in somebody ELSE\'s turn')
{
  // 2026-08-30, pane s4-mtednh9i: the 02:12 autoclear cleared correctly, the SessionStart
  // hook chain kept the pane painting for seconds, Robert typed his own question into the
  // fresh session, and the resume prompt was then delivered INTO that turn. `mark` is
  // lastKeyboard as it stood when the prompt was queued; anything later is a person.
  const base = { exists: true, mark: 1000, drafting: false, composerIdle: true, expired: false }
  ok('an idle composer gets the prompt', queuedPromptDecision({ ...base, lastKeyboard: 1000 }) === 'type')
  ok('our own writes do not read as a person', queuedPromptDecision({ ...base, lastKeyboard: 999 }) === 'type')
  ok(
    'a human submit since the queue DROPS the prompt',
    queuedPromptDecision({ ...base, lastKeyboard: 1001 }) === 'abandon'
  )
  ok(
    'and the deadline does not override that',
    queuedPromptDecision({ ...base, lastKeyboard: 1001, expired: true, composerIdle: false }) === 'abandon'
  )
  ok('a pane that went away is dropped', queuedPromptDecision({ ...base, exists: false, lastKeyboard: 1000 }) === 'abandon')
  // An unsent line waits, then is abandoned - never pasted onto the end of it.
  ok('an unsent draft waits', queuedPromptDecision({ ...base, lastKeyboard: 1000, drafting: true }) === 'wait')
  ok(
    'and is abandoned at the deadline, not typed over',
    queuedPromptDecision({ ...base, lastKeyboard: 1000, drafting: true, expired: true }) === 'abandon'
  )
  // The long-standing rescue: a CLI whose footer never goes quiet still gets the prompt.
  ok('a busy pane waits', queuedPromptDecision({ ...base, lastKeyboard: 1000, composerIdle: false }) === 'wait')
  ok(
    'and is typed into at the deadline',
    queuedPromptDecision({ ...base, lastKeyboard: 1000, composerIdle: false, expired: true }) === 'type'
  )
}

console.log('a busy pane WAITS, it is not refused')
{
  // The Stop hook fires inside the turn it is ending, so this is the normal case, not
  // an edge one. Refusing it is what stopped every clear on 2026-08-24.
  ok('mid-turn queues', armDecision('working') === 'queue')
  ok('idle arms', armDecision(null) === 'arm')
  ok('a pending question refuses', armDecision('asked') === 'refuse')
  ok('a closed pane refuses', armDecision('gone') === 'refuse')

  // The quiet floor in FRONT of the countdown. `dropFor` drops `runSince` when the agent's
  // footer goes quiet, which is before the turn is over: Claude Code's Stop hooks run after
  // the reply is drawn and a hook that BLOCKS makes the model write another reply into the
  // same pane. Robert watched a countdown start in exactly that gap on 2026-08-30.
  ok('a pane that has only just printed is not armed over', quietEnoughToArm(0) === false)
  ok('...nor one printing a second ago', quietEnoughToArm(1000) === false)
  ok('...nor one a hook chain ago', quietEnoughToArm(ARM_QUIET_MS - 1) === false)
  // The control: the whole feature is a countdown that DOES appear, so a genuinely settled
  // pane has to arm - a floor that never lets go is the same bug the other way round.
  ok('a settled pane arms', quietEnoughToArm(ARM_QUIET_MS) === true)
  ok('and a long-idle one certainly does', quietEnoughToArm(10 * 60_000) === true)
  // The floor is a WAIT, never a refusal: `armDecision` still says arm, and the caller
  // re-asks after the remainder. If this ever returned 'refuse' the ask would be thrown
  // away for being too fresh, which is the failure this replaces.
  ok('the floor never turns into a refusal', armDecision(null) === 'arm')
}

console.log('nothing but the button stands a countdown down')
{
  // The bug this replaces: clicking the pane to READ what was about to be cleared took the
  // card away, because `cursorMove.ts` turns a bare click into arrows that go out through
  // the same `pty:write` a person typing uses. Narrowing the rule to "arrows and mouse
  // reports do not count" fixed the click and left the real complaint standing - Robert,
  // 2026-08-27: "it should continue counting down no matter what for the clear unless i
  // click on keep this session". So the whole cancel-on-write path is gone.
  //
  // Source assertions, because the thing being pinned is an ABSENCE: nothing here can
  // observe a cancel that no longer happens, and a helpful future edit putting one back is
  // exactly how this feature broke twice.
  const idx = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  ok('writePane cancels nothing', !/cancelAutoClear\(id, 'typed'\)/.test(idx))
  ok('and does not reach for a write test', !/writeCancels/.test(idx))
  const sh = readFileSync(join(root, 'src/shared/autoclear.ts'), 'utf8')
  ok('there is no typed reason left to give', !/'typed'/.test(sh))
  // The one press that IS allowed to stop it, and the only one.
  ok('the button still stands it down', armDecision('cancelled') === 'refuse')
  ok('and it has words', dropWords('cancelled') === 'you stopped it')
  const toast = readFileSync(join(root, 'src/renderer/src/components/AutoClearToast.tsx'), 'utf8')
  ok('the card still carries that button', /Keep this session/.test(toast))
}

console.log('a countdown can be heard')
{
  // A card drawn in the corner of a window that is behind something else is a card nobody
  // reads in time. Source assertion for the same reason as above - the sound is a side
  // effect in an effect, and there is nothing to return.
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('the soonest clear countdown is tracked', /const clearSoonAt = sessions\.reduce/.test(app))
  ok('it ticks', /clearSoonAt - left \* 1000/.test(app))
  ok('and it announces itself once', /if \(first\) playAction\('move', soundSet\.current\)/.test(app))
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
  ok(
    'a model switch sits between the clear and the prompt, with its confirm CR',
    JSON.stringify(clearChunks('carry on', '/clear', 'opus')) ===
      JSON.stringify(['/clear\r', '/model opus\r', '\r', 'carry on', '\r'])
  )
  ok('a promptless clear never switches models', JSON.stringify(clearChunks('', '/clear', 'opus')) === JSON.stringify(['/clear\r']))
  ok('resumeOf finds the prompt behind a switch', JSON.stringify(resumeOf(clearChunks('carry on', '/clear', 'opus'))) === JSON.stringify({ switchCmd: '/model opus', resume: 'carry on' }))
  ok('resumeOf without a switch', JSON.stringify(resumeOf(clearChunks('carry on'))) === JSON.stringify({ switchCmd: '', resume: 'carry on' }))
  ok('readAsk keeps a clean model alias', readAsk({ paneId: 'p', prompt: 'x', seconds: 15, model: 'opus' })?.model === 'opus')
  ok('readAsk drops a model that is not an alias', readAsk({ paneId: 'p', prompt: 'x', seconds: 15, model: 'opus; rm -rf' })?.model === undefined)
  ok('readAsk drops the model on a cost clear', readAsk({ paneId: 'p', noResume: true, seconds: 15, model: 'opus' })?.model === undefined)

  // The SCHEDULE the HOOK's own fallback typing path still runs on (2026-08-27, s2): flat
  // 400ms gaps typed the prompt fine and lost the submit CR, because /clear restarts the
  // CLI and a CR arriving mid-redraw is swallowed. That path has no reading of the pane,
  // so it must still guess, and these pin the guess.
  ok('the clear goes out immediately', chunkDelayMs(0) === 0)
  ok('the prompt waits for /clear to settle', chunkDelayMs(1) === CLEAR_SETTLE_MS && CLEAR_SETTLE_MS >= 2000)
  ok('the submit follows the prompt, not the clear', chunkDelayMs(2) === CLEAR_SETTLE_MS + SUBMIT_GAP_MS && SUBMIT_GAP_MS >= 1000)
  ok('submit retries exist and are ordered', SUBMIT_RETRIES_MS.length >= 2 && SUBMIT_RETRIES_MS.every((v, i, a) => v > 0 && (!i || v > a[i - 1])))

  // ...and the APP does not run on it any more. Measured over the 16 clears in
  // autoclear-app.log on 2026-08-27/28: the blind schedule typed the prompt at a fixed
  // +2500ms and its submit at +3700ms, then fired two unconditional CRs at +6700ms and
  // +11700ms - 28 retries across 16 clears, BOTH of them every time, including the
  // fourteen where the first submit had plainly landed. Nothing read the pane at any
  // point, so a stray Enter went into a live session on every single clear.
  //
  // These are SOURCE assertions because the alternative is a green test over a schedule
  // nothing calls: the constants above still exist and still export, so importing them
  // proves nothing about which code path uses them.
  const src = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  const fire = src.slice(src.indexOf('armAutoClear(id: string'), src.indexOf('cancelAutoClear(id: string'))
  ok('the app fire path no longer schedules chunks blind', !/chunkDelayMs/.test(fire), fire.match(/chunkDelayMs.*/)?.[0])
  ok('and it fires no blind submit retries', !/SUBMIT_RETRIES_MS/.test(fire), fire.match(/SUBMIT_RETRIES_MS.*/)?.[0])
  // What it does instead: hand the resume prompt to the machinery that WAITS for an idle
  // composer, sends the return as its own write, and re-sends only after reading the pane.
  ok(
    'the resume prompt goes through queuePrompt',
    /this\.queuePrompt\(id, resume, 0, switchCmd \? SUBMIT_GAP_MS : CLEAR_PROMPT_START_MS/.test(fire)
  )
  ok(
    "a model switch is typed through queuePrompt before the prompt, then confirmed with one CR",
    /this\.queuePrompt\(id, switchCmd, 0, CLEAR_PROMPT_START_MS/.test(fire) && /this\.write\(id, .\\r., 'app'\)\s*\n\s*typeResume\(\)/.test(fire)
  )
  // The curtain over the pane goes UP with the clear and DOWN when the prompt settles.
  // Raising it without passing the settle callback is a pane that never takes keys again.
  // ...and it outlives the resume prompt's own wait, which a `/clear` restart makes far
  // longer than a launch prompt's: the pane must say a prompt is still coming rather than
  // looking like somebody walked away mid-sentence.
  ok('the handover curtain is raised before the prompt is queued', /this\.setHandover\(id, Date\.now\(\) \+ handoverMaxMs\(CLEAR_RESUME_BUDGET_MS\)\)/.test(fire))
  // The `'app'` hand on both writes is load-bearing beyond tidiness: A7 counts how often a
  // PERSON stepped in, and an autoclear typing `/clear` into a pane must not read as one.
  ok('the clear itself is still typed first, after the armclear lead', /this\.emit\('armclear', id\)/.test(fire) && /this\.write\(id, clearCmd, 'app'\)/.test(fire))
  // The beat before the wait BEGINS, not the wait: it must be short, or the adaptive path
  // costs exactly what the blind one did.
  ok('the start beat is short', CLEAR_PROMPT_START_MS > 0 && CLEAR_PROMPT_START_MS < CLEAR_SETTLE_MS / 2)
  // queuePrompt must actually honour the override, or the 2500ms default is back and this
  // whole change is a comment.
  ok(
    'queuePrompt takes the override',
    /private queuePrompt\(\s*id: string,\s*prompt\?: string,\s*extraDelay = 0,\s*startMs = PROMPT_START_MS,/.test(src)
  )
  // Every exit settles, or the curtain outlives the prompt. `settle` is what the callback
  // runs through and it is called on the drop, the submit and the pane going away.
  ok('and it settles on every exit', (src.match(/return settle\(\)/g) ?? []).length >= 4, String((src.match(/return settle\(\)/g) ?? []).length))
  ok('and starts on it', /setTimeout\(tick, Math\.max\(0, startMs\) \+ Math\.max\(0, extraDelay\)\)/.test(src))

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
    ok(
      'the hook and the app type the same model-switch list',
      JSON.stringify(hook.paneChunks('carry on', 'opus')) === JSON.stringify(clearChunks('carry on', '/clear', 'opus')),
      JSON.stringify(hook.paneChunks('carry on', 'opus'))
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
  // The control for the 2026-08-28 bug: firing mid-turn queued /clear + prompt + CR
  // together, the clear ran first at the turn boundary and discarded the rest, so the
  // pane cleared and continued nothing. It must wait for the turn, never type into it.
  ok('mid-turn never types - it goes back on the queue', expiryDecision({ ...base, drop: 'working' }) === 'working')
  // (c) a draft at expiry WAITS - it does not stand down. Typing over somebody's unsent
  // line is the one damage a clear can do that cannot be undone, and the countdown staying
  // on screen is what keeps the promise that only the button stops it.
  ok('a draft at expiry waits', expiryDecision({ ...base, drop: 'drafting' }) === 'wait')
  ok('and the reason still has words for the log', dropWords('drafting').includes('unsent'))
  ok('the retry is short enough to be a wait, not a second countdown', DRAFT_RETRY_MS <= 10_000)
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
  // RUNNING the script needs a bash, and a Windows box has none on PATH - the WSL shim
  // answers `execvpe(/bin/bash) failed` and the whole suite reads as a code failure. The
  // shape assertions above hold everywhere; only the execution is skipped, out loud, so
  // nobody mistakes a machine without bash for a passing tee.
  let hasBash = true
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
  } catch {
    hasBash = false
  }
  if (!hasBash) console.log('skip  no bash on this machine - the statusline tee is not run')
  if (hasBash) {
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
  }

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
    // `changed` is false when the file ALREADY carries the tee, which is the normal state
    // of this machine's own statusline once the bridge has run - the check is that the
    // copy ends up teed exactly once, not that this particular call did the teeing.
    const marks = (text.match(/>>> paneforge autoclear bridge >>>/g) ?? []).length
    ok('the real hook carries the tee, once', marks === 1, `changed=${a.changed} marks=${marks}`)
    ok('and does not take it twice', b.changed === false && readFileSync(join(copyDir, 'statusline.sh'), 'utf8') === text)
    ok('the tee is above the original script', text.indexOf('paneforge autoclear bridge') < text.indexOf('locate jq'))
  }
}

rmSync(out, { recursive: true, force: true })

console.log('the resume prompt is forged, so it names the handoff and what done means')
{
  const ask = readAsk({
    paneId: 'p1',
    prompt: 'Continue the handoff: work its Next steps in order, and do not re-do finished items.',
    steps: ['Ship the offload switch.', 'Run npm run test:settingsearch.'],
    seconds: 30
  })
  const brief = resumeBrief(ask, '/Users/x/Projects/claude-memory/PaneForge/handoffs/session.md')
  ok('the handoff path is the anchor', brief.includes('/handoffs/session.md'))
  ok('the hook words survive', brief.includes('Continue the handoff'))
  ok('every open step becomes a done line', brief.includes('- Ship the offload switch.') && brief.includes('- Run npm run test:settingsearch.'))
  ok('no work beyond the handoff is invited', brief.includes('add no work it does not name'))

  const noPath = resumeBrief(ask, null)
  ok('an unknown handoff draws no anchor', !noPath.includes('Start from:'))
  ok('and still says what done means', noPath.includes('Done means:'))

  const noSteps = resumeBrief(readAsk({ paneId: 'p1', prompt: 'Continue the handoff.', seconds: 30 }), null)
  ok('a handoff with no steps still gets a done line', noSteps.includes('is finished, or is named as blocked'))

  const quiet = resumeBrief(readAsk({ paneId: 'p1', noResume: true, seconds: 30 }), '/x/h.md')
  ok('a noResume clear forges nothing - it types nothing on purpose', quiet === '')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
