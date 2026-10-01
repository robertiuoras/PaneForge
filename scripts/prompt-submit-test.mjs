// A launch prompt is TYPED and SENT, or the pane is a person waiting for nobody.
//
// The failure this pins is silent by construction. A pane opened with a prompt draws
// that prompt into the CLI's composer and then sits there for ever, looking exactly
// like a person who walked away mid-sentence: no error, no exit, the card idle and
// green. Measured 2026-08-11, two #momin backlog bundles sat like that for hours after
// the runner reported "session spawned" - because the old code wrote `prompt + '\r'`
// on a blind 2500ms timer, and Codex was still painting `Starting MCP servers (0/4)
// ... esc to interrupt`. A CLI that is still booting replays what arrived during the
// boot into its composer, where that trailing return is one more character of the
// paste; and a return that DOES land on the startup screen cancels the startup rather
// than submitting anything. Both were watched happening.
//
// So the readiness signal is an IDLE COMPOSER - output stopped AND the agent's own
// footer no longer saying it is working - the return is a separate keystroke after
// the text, and the submit is confirmed rather than assumed.
//
//   node scripts/prompt-submit-test.mjs

import { readFileSync } from 'node:fs'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mock } from 'node:test'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The real waits are seconds long because a real CLI takes seconds to boot. Every one
// of them is an env knob for exactly this reason, and they are set BEFORE the bundle is
// required - the module reads them once, at load. The test then runs in about a second.
process.env.PF_PROMPT_START_MS ??= '120'
process.env.PF_PROMPT_QUIET_MS ??= '120'
process.env.PF_PERSON_QUIET_MS ??= '120'
process.env.PF_PROMPT_POLL_MS ??= '40'
process.env.PF_PROMPT_ENTER_MS ??= '60'
process.env.PF_PROMPT_CONFIRM_MS ??= '200'
process.env.PF_PROMPT_WAIT_MAX_MS ??= '5000'
process.env.PF_PROMPT_STALE_BUSY_MS ??= '1500'
// Pinned here rather than read from the module: the SHIPPED budget is 6, and the cap
// assertion below is about the cap existing at all, not about the number.
process.env.PF_PROMPT_ENTER_TRIES ??= '3'
// A fresh Claude Code is waited for until its SessionStart hooks are done (`claudeStartup`):
// the real ceilings are a minute and ten seconds, these keep the cases below short. The
// startup ceiling sits well past the ~1.2s the hooks-done case needs to open its gate: at
// 1500 the PC's full-suite pool (timers 300-650ms late) opened it AT the ceiling, which logs
// `typing anyway`, not `finished starting` (2026-09-28, 1 of 280 red).
process.env.PF_PROMPT_STARTUP_MS ??= '3000'
process.env.PF_PROMPT_PIDFILE_MS ??= '800'
process.env.PF_CLAUDE_SETTLE_MS ??= '200'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-prompt-submit-'))
mkdirSync(join(work, 'userData'), { recursive: true })
// The CLI's own pid files and transcripts, off the real ~/.claude.
process.env.PF_CLAUDE_HOME = join(work, 'claude-home')
process.env.CODEX_HOME = join(work, 'codex-home')

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')},
  BrowserWindow:{getAllWindows:()=>[]},shell:{openPath:()=>{}},dialog:{}}
`
)

// A pty that records what was written and lets the test paint what a booting CLI
// paints. The pty layer itself is `npm run smoke`'s job; this is the bookkeeping above
// it - when the app decides the CLI is ready to be typed at.
writeFileSync(
  join(work, 'pty-stub.cjs'),
  `const off={dispose(){}}
module.exports={spawn:(file,args,opts)=>({
  pid: 4242, file, args, cols: opts.cols, rows: opts.rows,
  writes: [], _data: null,
  onData(fn){this._data=fn;return off}, onExit(){return off},
  write(d){if(d==='\\r'&&this.firstReturnAt===undefined)this.firstReturnAt=Date.now();this.writes.push(d);this.onWrite?.(d)}, kill(){}, resize(){},
  say(text){this._data && this._data(text)}
})}
`
)

buildSync({
  absWorkingDir: root,
  stdin: { contents: `export { SessionManager } from './src/main/sessions'; export { forgetQueuedPrompts, noteAccepted, noteTyped } from './src/main/queuedPrompts'; export { claudeAcceptedPrompt } from './src/main/transcripts'`, resolveDir: root },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'sessions.bundle.cjs'),
  alias: {
    electron: join(work, 'electron-stub.cjs'),
    '@lydell/node-pty': join(work, 'pty-stub.cjs')
  },
  logLevel: 'silent'
})

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/promptLanded.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'landed.bundle.cjs'),
  logLevel: 'silent'
})

const req = createRequire(join(work, 'x.cjs'))
const { SessionManager, claudeAcceptedPrompt, forgetQueuedPrompts, noteAccepted, noteTyped } = req('./sessions.bundle.cjs')

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}
const sleep = (n) => new Promise((r) => setTimeout(r, n))
// What the app itself wrote down about one pane, waited for because the log is appended off
// the typing path. A check that is about WHICH way a prompt went reads this, not a clock: on
// the PC's full-suite pool this process's own timers fired 300-650ms late (2026-09-27, the
// test said its composer at +456ms for a planned +120), so wall-clock limits failed runs in
// which the app did exactly the right thing - a different check each time.
const logOf = (id) => {
  try {
    return readFileSync(join(work, 'userData', 'autoclear-app.log'), 'utf8').split('\n').filter((l) => l.includes(id)).join('\n')
  } catch {
    return ''
  }
}
// On the PC a line can land after the keystrokes it describes, so a reading waits for it
// rather than racing it.
const logSays = async (id, re, waitMs = 2000) => {
  const until = Date.now() + waitMs
  while (Date.now() < until && !re.test(logOf(id))) await sleep(40)
  return re.test(logOf(id))
}
// How long a held launch prompt waited, in seconds from the spawn, as the app logged it
// (`still starting - typing anyway after 0.8s`, short wait or ceiling); -1 when it never said.
const shortWaitOf = async (id) => {
  const re = /still starting - typing anyway after ([\d.]+)s/
  if (!(await logSays(id, re))) return -1
  return Number(logOf(id).match(re)[1])
}

const PROMPT = 'first line of the ask\nsecond line: do the thing'
// What Codex really prints while its MCP servers come up. `esc to interrupt` is the
// part that matters: it reads as "working", and it is the screen a return cancels.
const BOOTING = '\x1b[2m• Starting MCP servers (0/4): codex_apps, node_repl (0s • esc to interrupt)\x1b[0m'
const COMPOSER = '\r\n\x1b[2m › Use /skills to list available skills\x1b[0m\r\n'

const manager = new SessionManager()
const started = manager.start({ cwd: root, agent: 'shell', prompt: PROMPT })
const proc = manager.sessions.get(started.id).proc
const typed = () => proc.writes.join('')
const returnsOf = (p) => p.writes.filter((w) => w === '\r').length
const returns = () => returnsOf(proc)

// 1. A CLI that is still painting its startup is not ready, however long it takes.
//    PF_PROMPT_START_MS is 120 here, so a blind timer would have typed long ago.
for (let i = 0; i < 8; i++) {
  proc.say(BOOTING)
  await sleep(40)
}
ok(!typed().includes('first line of the ask'), 'nothing is typed while the CLI is still booting', typed())

// 2. The startup finishes: output stops and the footer stops claiming work. Now the
//    prompt goes in - and the return is NOT part of it.
proc.say(COMPOSER)
// Until the return is written (capped), not a fixed 400ms: the return is 60ms after the
// text, and a starved PC run typed at +370ms and failed with the return still 60ms away.
await sentReturnAt(proc)
ok(typed().includes('first line of the ask'), 'the prompt is typed once the composer is idle', typed())
// `?? ''` rather than a bare index: when the prompt never went in at all - which is
// the whole bug - this must report a FAILING assertion, not crash the file and take
// the remaining cases with it.
const promptWrite = proc.writes.find((w) => w.includes('first line of the ask')) ?? ''
ok(
  Boolean(promptWrite) && !promptWrite.endsWith('\r'),
  'the return is not the last byte of the pasted prompt',
  JSON.stringify(promptWrite.slice(-12))
)
ok(returns() >= 1, 'a return is sent as its own keystroke', proc.writes.length + ' writes')

// 3. The pane is STILL idle, so that return was eaten: another one is sent. This is the
//    half that makes it recover rather than merely try - a CLI can swallow the first.
const afterFirst = returns()
await sleep(500)
ok(returns() > afterFirst, 'a return that changed nothing is sent again', `${afterFirst} -> ${returns()}`)

// 4. ...and it stops once the agent is working. A pane answering must never be typed at.
const beforeBusy = returns()
for (let i = 0; i < 6; i++) {
  proc.say('\x1b[2m• Working (3s • esc to interrupt)\x1b[0m')
  await sleep(60)
}
ok(returns() === beforeBusy, 'no more returns once the pane says it is working', `${beforeBusy} -> ${returns()}`)
ok(returns() <= 3, 'the retries are capped', String(returns()))

// Follow-ups queued during an existing turn wait beyond the boot deadline.
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
try {
  const followup = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(followup.id)
  const p = live.proc
  live.meta.runSince = Date.now() - 1000
  live.busyUntil = Date.now() + 5000
  p.say(COMPOSER)
  manager.queuePrompt(followup.id, 'follow up after this turn', 0, 0, undefined, 40)
  manager.queuePrompt(followup.id, 'a separate second follow up', 0, 0, undefined, 40)
  mock.timers.tick(2000)
  ok(p.writes.length === 0, 'a follow-up waits past the boot budget for an already running turn')
  live.meta.runSince = undefined
  live.busyUntil = 0
  mock.timers.tick(200)
  ok(p.writes.includes('follow up after this turn'), 'the follow-up is typed when that existing turn ends')
  ok(!p.writes.includes('a separate second follow up'), 'the next queued message is not appended to the first paste')
  manager.kill(followup.id)
} finally {
  mock.timers.reset()
}

// 5. A pane opened with no prompt is never typed at at all.
const bare = manager.start({ cwd: root, agent: 'shell' })
const bareProc = manager.sessions.get(bare.id).proc
await sleep(400)
ok(bareProc.writes.length === 0, 'a pane opened without a prompt is left alone', JSON.stringify(bareProc.writes))

// 6. The same discipline for a job handed to a pane that is already running - a lane
//    hand-over, which is this failure arriving later in a pane's life. LaneStrip wrote
//    `text + '\r'` itself and Robert found the conflicted-lane job sitting unsent in his
//    prompt box on 2026-08-17; `sendPrompt` is the fix and this is what makes it stay one.
const JOB = 'taskdriver.ai lane f is conflicted, so its finished work is left out of every release.'
manager.sendPrompt(bare.id, JOB)
bareProc.say(COMPOSER)
await sleep(500)
const jobWrite = bareProc.writes.find((w) => w.includes('lane f is conflicted')) ?? ''
ok(Boolean(jobWrite), 'a job handed to a live pane is typed into it', JSON.stringify(bareProc.writes))
ok(
  Boolean(jobWrite) && !jobWrite.endsWith('\r'),
  'the job is not written with the return glued on',
  JSON.stringify(jobWrite.slice(-12))
)
ok(
  bareProc.writes.filter((w) => w === '\r').length >= 1,
  'and the return is pressed for it, as its own keystroke',
  JSON.stringify(bareProc.writes)
)

// 7. An id that is not a live pane is a no-op, not a crash: a lane's chat can exit
//    between the strip deciding to hand the job over and this call landing.
manager.sendPrompt('no-such-pane', JOB)
ok(true, 'sendPrompt on a dead id does not throw')

// 8. THE ONE THIS SESSION BROKE ON. A queued prompt must never be delivered into a turn
//    a PERSON started first. 2026-08-30, pane s4-mtednh9i: autoclear typed `/clear`, the
//    fresh session spent seconds running its SessionStart hooks (memory symlinks, handoff
//    injection, superpowers), Robert read the screen and sent his own question, and the
//    queued `Continue the handoff: ...` was then typed INTO that turn as a second message.
//    Every log line said the clear succeeded, so it reads as autoclear breaking again.
//
//    The old code read composer idleness and nothing else, so it could not tell a composer
//    idle because the CLI finished booting from one idle because somebody had just sent a
//    message. This drives the real SessionManager through exactly that order.
const RESUME = 'Continue the handoff: work its Next steps in order.'
const hijack = manager.start({ cwd: root, agent: 'shell' })
const hijackProc = manager.sessions.get(hijack.id).proc
// The pane is booting: the queued prompt is waiting, not typed.
hijackProc.say(BOOTING)
manager.sendPrompt(hijack.id, RESUME)
await sleep(150)
ok(
  !hijackProc.writes.join('').includes('Continue the handoff'),
  'the queued prompt waits while the fresh session is still booting',
  JSON.stringify(hijackProc.writes)
)
// A person types their own question and sends it. This is a real keystroke path
// (`write`), which is what moves `lastKeyboard` past the mark the queue took.
manager.write(hijack.id, 'it broke again do you have logs')
manager.write(hijack.id, '\r')
const humanAt = manager.sessions.get(hijack.id).meta.lastKeyboard
// Their turn is running. This is the window the 2026-08-30 bug typed into, and nothing
// may go in here - not at any deadline.
//
// The renderer reads the CLI's busy footer and says so, as it does for a real agent. This
// pane is a shell over a stub pty with no foreground process, and on POSIX `sweepIdle`
// ends a shell's run the moment nothing is in the foreground (`shellDone`) - so without
// this reading the turn was over within a second on a Mac and the prompt went in, while
// the same test passed on Windows where that rule is off.
manager.setBusyOnScreen(hijack.id, true, 'esc to interrupt')
hijackProc.say(BOOTING)
await sleep(700)
ok(
  !hijackProc.writes.join('').includes('Continue the handoff'),
  'the queued prompt is never typed into the turn a person just started',
  JSON.stringify(hijackProc.writes)
)
ok(
  typeof humanAt === 'number' && humanAt > 0,
  'the human submit is what moves lastKeyboard, and it is recorded',
  String(humanAt)
)
// ...and their turn ends. Until 2026-09-07 the prompt was DROPPED the moment they typed, so
// the session was cleared and then never told to carry on - Robert: "we lost the hands off
// autoclear flow now its getting messed up if i type while thats happening". It waits behind
// them instead, and goes in at the composer they hand back. Late is right; never is not.
// The renderer's footer read is what ends a turn in the app (`endRun`); a paint gap alone
// is not (s21-muczy2r3, 2026-09-22: typed into a running turn on a 900ms stall).
hijackProc.say(COMPOSER)
await sleep(400)
ok(
  !hijackProc.writes.join('').includes('Continue the handoff'),
  'a quiet composer is not their turn ending while the app still reads the turn as running',
  JSON.stringify(hijackProc.writes)
)
manager.setBusyOnScreen(hijack.id, false, COMPOSER)
await sleep(900)
ok(
  hijackProc.writes.join('').includes('Continue the handoff'),
  'and lands after their turn ends, rather than being lost because they typed',
  JSON.stringify(hijackProc.writes)
)

// 9. The same pane accepts a prompt queued AFTER the person's message: the drop is about
//    ownership at queue time, not a pane that is permanently off limits.
//
// Queued once the resume prompt has SETTLED. Its confirm returns are keystrokes too (`write`
// stamps `lastKeyboard` on every submit), so a prompt queued while they are still coming
// reads them as a person who typed after it and waits behind that turn.
for (const until = Date.now() + 5000; Date.now() < until && manager.sessions.get(hijack.id).meta.owedPrompt; ) await sleep(40)
const LATER = 'and this one is still wanted'
manager.sendPrompt(hijack.id, LATER)
// Painted AFTER the first poll on purpose: the busy read is of the NEWEST output, and
// this pane's buffer still holds the boot's `esc to interrupt`. A real CLI keeps painting;
// a stub that never says anything again leaves the last busy frame as the newest one.
await sleep(200)
hijackProc.say(COMPOSER)
// The resume's own return started a turn, and a prompt queued during a turn waits for it
// to end. The app ends it on the renderer's footer read; without that read only the 4s
// quiet backstop does, on Windows (no foreground-job rule for a shell): measured 4331ms of
// this 5000ms wait on a Mac with that rule off, past it on the PC's loaded pool. 369ms with it.
manager.setBusyOnScreen(hijack.id, false, COMPOSER)
for (const until = Date.now() + 5000; Date.now() < until && !hijackProc.writes.join('').includes(LATER); ) await sleep(40)
ok(
  hijackProc.writes.join('').includes(LATER),
  'a prompt queued after they finished still goes in',
  `${JSON.stringify(hijackProc.writes)}\n${logOf(hijack.id)}`
)

// 10. The handover curtain always comes DOWN. It swallows keystrokes, so every way the
//     resume prompt can end - typed and submitted, dropped because a person took the pane,
//     the pane closing - has to settle it, or the pane silently stops accepting keys.
// A person taking the pane back mid-handover: `takeOver` moves lastKeyboard, which is what
// drops the queued prompt, and lowers the curtain in the same call.
const curtain = manager.start({ cwd: root, agent: 'shell' })
const curtainProc = manager.sessions.get(curtain.id).proc
curtainProc.say(BOOTING)
manager.sendPrompt(curtain.id, 'a queued resume prompt')
await sleep(120)
ok(manager.takeOver(curtain.id) === true, 'takeOver answers for a live pane')
await sleep(200)
curtainProc.say(COMPOSER)
await sleep(700)
ok(
  !curtainProc.writes.join('').includes('a queued resume prompt'),
  'takeOver drops the queued prompt - the one deliberate cancel, unlike ordinary typing',
  JSON.stringify(curtainProc.writes)
)
ok(manager.takeOver('no-such-pane') === false, 'takeOver on a dead id is false, not a throw')

// A prompt the app or a phone typed is said to the window as `typed`, so the rail can tag
// it; the window's own keystrokes are not, because it tagged those itself.
{
  const typedInto = manager.start({ cwd: root, agent: 'shell' })
  const said = []
  manager.on('typed', (id, line) => id === typedInto.id && said.push(line))
  manager.write(typedInto.id, 'typed by hand\r')
  manager.write(typedInto.id, 'from a phone\r', 'phone')
  manager.write(typedInto.id, '\x1b[200~pasted\nby app\x1b[201~\r', 'app')
  manager.write(typedInto.id, '\r', 'app')
  ok(said.length === 2, 'desk keystrokes are not announced; app and phone lines are', JSON.stringify(said))
  ok(said[0] === 'from a phone', 'the phone line arrives whole', said[0])
  ok(said[1] === 'pasted\nby app', 'a pasted prompt keeps its newlines and is not the 200-char tail', said[1])
  manager.kill(typedInto.id)
}

// And the settle path fires for a prompt that goes in normally, which is what lowers the
// curtain on the happy path.
const settling = manager.start({ cwd: root, agent: 'shell' })
const settlingProc = manager.sessions.get(settling.id).proc
let done = 0
manager.queuePrompt(settling.id, 'goes in fine', 0, 40, () => done++)
await sleep(120)
settlingProc.say(COMPOSER)
// Until it fires (capped), then a whole confirm budget more for a second firing to show up.
// A fixed 1400ms failed 6 of 9 cold PC runs (2026-09-27) on the same late timers as above.
const settleBy = Date.now() + 5000
while (!done && Date.now() < settleBy) await sleep(40)
await sleep(Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES))
ok(done === 1, 'the settle callback fires exactly once on the happy path', String(done))
ok(
  settlingProc.writes.join('').includes('goes in fine'),
  'and it fired because the prompt actually went in',
  JSON.stringify(settlingProc.writes)
)

// A slash command starts no turn. `/model opus` prints "Set model to Opus 5 and saved as
// your default" and hands the composer back; measured 2026-09-02/03 on every autoclear
// carrying a model switch, the turn-proof confirm fed it two more bare returns and gave
// up after 24s as "still painting". With proof 'idle' the composer coming back IS the
// proof: exactly one return, settled at the poll cadence, no turn needed.
const cmd = manager.start({ cwd: root, agent: 'shell' })
const cmdProc = manager.sessions.get(cmd.id).proc
// The CLI answers the command with one line and the composer again - still no turn. It
// answers the RETURN, as the real one does, not a fixed 400ms after the composer: on a
// starved PC that sleep ran so late (2026-09-27, settled at 1082ms) that the answer came
// after the confirm window, and the app rightly settled some other way. `setImmediate` puts
// the answer after the app's bookkeeping for that return and before its first poll; the
// spin keeps it out of the return's own millisecond, which a real pty's answer never shares
// and the app reads (`lastOutput > typedAt`) as nothing printed.
const cmdWrite = cmdProc.write
cmdProc.write = function (d) {
  cmdWrite.call(this, d)
  if (d !== '\r') return
  setImmediate(() => {
    const at = Date.now()
    while (Date.now() === at);
    this.say('\r\n  ⎿  Set model to Opus 5 and saved as your default for new sessions\r\n' + COMPOSER)
  })
}
let cmdDone = 0
const cmdAt = Date.now()
let cmdSettledAt = 0
manager.queuePrompt(cmd.id, '/model opus', 0, 40, () => { cmdDone++; cmdSettledAt = Date.now() }, 5000, 'idle')
await sleep(120)
cmdProc.say(COMPOSER)
const cmdBy = Date.now() + 5000
while (!cmdDone && Date.now() < cmdBy) await sleep(40)
await sleep(Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES))
ok(cmdDone === 1, 'a slash command settles without a turn', String(cmdDone))
ok(cmdProc.writes.filter((w) => w === '\r').length === 1, 'and it got exactly one return - the idle composer was the proof', JSON.stringify(cmdProc.writes))
// The WAY it settled, not how long it took: the budget path logs `return swallowed` and sends
// more returns, this one logs `command landed`. Timed from cmdAt it read 1167ms on a starved
// PC while the app settled 1ms after the answer - which the test itself had said 647ms late.
ok(
  await logSays(cmd.id, /command landed - the composer is idle again/),
  'and it settled at the poll cadence, not after the whole confirm budget',
  `${cmdSettledAt - cmdAt}ms\n${logOf(cmd.id)}`
)
manager.kill(cmd.id)

// ...and a QUIET composer that printed NOTHING is a swallowed return, not a landed command.
// 2026-09-07, pane s2-mtqmyvnv: `/clear` restarted the CLI, the `/model opus` return went in
// during a gap in the boot paint and was eaten, and the confirm settled 1.2s later as
// "command landed". The 721-character resume prompt was then typed onto a composer still
// holding `/model opus`, and Claude Code read the pair as one slash command:
// `Model 'opus\n\nContinue the handoff...' not found`. The clear happened, the handover did
// not. So the proof is the command's ANSWER, not the silence around it.
// Answers the moment the return this queuePrompt sends was written, so a case can be
// judged against the confirm window rather than against a wall-clock sleep. 6s: a throw
// here ends the whole file, and the PC's full-suite pool stalled past 3s (2026-10-02).
async function sentReturnAt(proc, waitMs = 6000) {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (proc.firstReturnAt !== undefined) return proc.firstReturnAt
    await sleep(10)
  }
  throw new Error('fake PTY did not receive Enter within the fixture wait')
}

const eaten = manager.start({ cwd: root, agent: 'shell' })
const eatenProc = manager.sessions.get(eaten.id).proc
let eatenDone = 0
// Paint readiness before submitting: a delayed setup paint after Enter would look
// like the command printed an answer, defeating this silence-only fixture.
eatenProc.say(COMPOSER)
manager.queuePrompt(eaten.id, '/model opus', 0, 40, () => eatenDone++, 5000, 'idle')
// The return goes in and the pane stays exactly as it was - quiet at its composer, with
// nothing printed. The old code settled on that silence within one poll (40ms here).
// Timed off the RETURN, never off a fixed sleep: the give-up settle lands
// PROMPT_CONFIRM_MS x PROMPT_ENTER_TRIES after it, and on a loaded Windows box a
// 400ms sleep overshot far enough to reach that give-up and read it as a landing
// (2026-09-10, test:pc). Three polls is still long past the single poll the old bug
// settled in, and the elapsed guard makes a slow machine FAIL rather than pass.
const eatenReturnAt = await sentReturnAt(eatenProc)
await sleep(Number(process.env.PF_PROMPT_POLL_MS) * 3)
const sinceReturn = Date.now() - eatenReturnAt
const confirmBudget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
ok(
  eatenDone === 0 && sinceReturn < confirmBudget,
  'a command that printed nothing has not landed',
  `settles=${eatenDone}, ${sinceReturn}ms after the return, budget ${confirmBudget}ms\n${logOf(eaten.id)}`
)
ok(
  eatenProc.writes.some((w) => w === '\r'),
  'and the return really was sent, so the silence is the pane\'s answer and not a missing keystroke',
  JSON.stringify(eatenProc.writes)
)
manager.kill(eaten.id)

// THE PROMPT WENT IN AND THE APP SAID IT DID NOT.
//
// `write()` starts the run clock on the return this very confirm is trying to prove:
// `ourWrite('\r')` -> `beginRun` -> `runSince = Date.now()`, and `typedAt` is read a line
// later, so the stamp is always a hair OLDER than the thing it proves. The comparison
// `runSince >= typedAt` therefore passes only when the CLI's own footer happens to
// re-anchor the clock past it (`anchorRun`). Measured in autoclear-app.log 2026-09-17..18:
// 8 panes settled "prompt submitted - a turn started", 16 gave up 24s later as
// "prompt left UNSENT: still painting" - every one of them while the agent was answering
// the prompt it said had not been sent. 09:57:19 s16-mu6saugo and 10:16:41 s15-mu6q4smz
// are two of them, and the session reading this line is the pane from the first.
//
// The frame below is this pane's own, off `history/s16-mu6saugo.log`: the busy footer, the
// marker, the rule under it. The composer is EMPTY - the prompt left it - which is the
// reading the give-up was missing.
const ANSWERING =
  '\r\n⏺ reading the log now\r\n· Leavening… (3m 56s · esc to interrupt)\r\n❯ \r\n' +
  '────────────────────────────────────────────────────────────\r\n  ⏵⏵ bypass permissions on\r\n'
{
  const acPath = join(work, 'userData', 'autoclear-app.log')
  const answering = manager.start({ cwd: root, agent: 'shell' })
  const aProc = manager.sessions.get(answering.id).proc
  let aDone = 0
  const RESUME2 = 'Continue the handoff: work its Next steps in order, and do not re-do finished items.'
  manager.queuePrompt(answering.id, RESUME2, 0, 40, () => aDone++, 5000)
  await sleep(120)
  aProc.say(COMPOSER)
  await sentReturnAt(aProc)
  const afterReturn = returnsOf(aProc)
  // The agent answers, and keeps answering past the whole confirm budget - which is the
  // window the old code spent and then called the prompt unsent.
  const budget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
  const until = Date.now() + budget + 400
  while (Date.now() < until) {
    aProc.say(ANSWERING)
    await sleep(50)
  }
  await sleep(300)
  const ac = readFileSync(acPath, 'utf8')
  const mine = ac.split('\n').filter((l) => l.includes(answering.id)).join('\n')
  ok(!/UNSENT/.test(mine), 'a prompt the agent is answering is never called UNSENT', mine)
  ok(aDone === 1, 'and it settles exactly once', String(aDone))
  ok(returnsOf(aProc) === afterReturn, 'no second return is fed into the turn it started', String(returnsOf(aProc)))
  manager.kill(answering.id)
}

// ...and the failure this path exists for still reads as the failure. Same painting pane,
// but the composer is holding the prompt: the return was eaten and nobody sent it.
{
  const acPath = join(work, 'userData', 'autoclear-app.log')
  const stuck = manager.start({ cwd: root, agent: 'shell' })
  const sProc = manager.sessions.get(stuck.id).proc
  const STUCK_PROMPT = 'Continue the handoff: work its Next steps in order.'
  let sDone = 0
  manager.queuePrompt(stuck.id, STUCK_PROMPT, 0, 40, () => sDone++, 5000)
  await sleep(120)
  sProc.say(COMPOSER)
  await sentReturnAt(sProc)
  const budget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
  const until = Date.now() + budget + 600
  while (Date.now() < until) {
    sProc.say(
      '\r\n· Starting MCP servers (0/4) (12s · esc to interrupt)\r\n❯ ' +
        STUCK_PROMPT +
        '\r\n────────────────────────────────────────────────────────────\r\n'
    )
    await sleep(50)
  }
  await sleep(300)
  const mine = readFileSync(acPath, 'utf8').split('\n').filter((l) => l.includes(stuck.id)).join('\n')
  ok(/UNSENT/.test(mine), 'a prompt still sitting in the composer is still called UNSENT', mine)
  ok(sDone === 1, 'and that settles once too', String(sDone))
  manager.kill(stuck.id)
}

// NOT INTO A CLAUDE CODE THAT IS STILL STARTING.
//
// 2026-09-24 13:53, pane s113-mufldnmu (Claude Code 2.1.281, ~/Projects/research-lab: an
// AGENTS.md and no CLAUDE.md). The 3797-char brief was typed 2.5s after the process started,
// while the CLI's SessionStart hooks ran until +13s. Replayed through @xterm/headless, no
// frame of `history/s113-mufldnmu.log` ever drew it; six bare returns went into an empty
// composer and it was lost. Five panes opened at once on 2026-09-25 showed the rest of it:
// typed at +1s, their submits waited for the hooks (12-45s) past the confirm, and typing the
// prompt again into a box that LOOKED empty sent it 2-3 times in one message. So the prompt
// waits for the CLI to say its start is over: the SessionStart record in its transcript.
//
// The fake CLI here is the pid file and the transcript the real one writes, under
// PF_CLAUDE_HOME, plus the idle composer it paints long before either is done. The panes
// sit in `root`, as every case here does: Windows cannot remove a folder a pane was in.
{
  const home = process.env.PF_CLAUDE_HOME
  const proj = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(join(home, 'sessions'), { recursive: true })
  mkdirSync(proj, { recursive: true })
  const RULE = '─'.repeat(60)
  const IDLE = '\x1b[2J\x1b[H ▐▛███▜▌   Claude Code v2.1.281\r\n\r\n' + RULE + '\r\n❯ \r\n' + RULE +
    '\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n'
  const BRIEF = 'RESEARCH QUESTION: is an always-loaded CLAUDE.md still the right place for the rules?\n' +
    'METHOD: primary sources first.'
  const pidFile = join(home, 'sessions', '4242.json') // the stub pty's pid
  const cli = (sessionId) =>
    writeFileSync(pidFile, JSON.stringify({ pid: 4242, sessionId, cwd: root, startedAt: Date.now(), status: 'idle' }))
  const hooksDone = (sessionId, agoMs = 0) => {
    const file = join(proj, `${sessionId}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'SessionStart:startup' }, timestamp: new Date().toISOString() }) + '\n')
    if (agoMs) utimesSync(file, new Date(Date.now() - agoMs), new Date(Date.now() - agoMs))
  }
  // A transcript on disk with the records that come BEFORE the hooks' own (the head
  // 2.1.283 writes), so the hooks are provably still running.
  const hooksPending = (sessionId) =>
    writeFileSync(join(proj, `${sessionId}.jsonl`), JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n')
  const typings = (...procs) => procs.flatMap((p) => p.writes).filter((w) => w.includes('RESEARCH QUESTION')).length
  const typedAt = async (p, waitMs) => {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      if (typings(p)) return Date.now()
      await sleep(20)
    }
    return 0
  }
  const open = () => {
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    manager.queuePrompt(pane.id, BRIEF, 0, 40, undefined, 5000)
    p.say(IDLE)
    return { pane, p, at: Date.now() }
  }

  // s113: the pid file is there, the hooks are not done. The composer is idle the whole time.
  cli('sess-running')
  hooksPending('sess-running')
  const a = open()
  const early = await typedAt(a.p, 900)
  ok(!early, 'a prompt is not typed while Claude Code is still running its SessionStart hooks',
    `typed ${early ? early - a.at : '-'}ms in\n${logOf(a.pane.id)}`)
  hooksDone('sess-running')
  const late = await typedAt(a.p, 1000)
  ok(late > 0, 'and it is typed once the SessionStart record is in the transcript and it has gone quiet', logOf(a.pane.id))
  ok(typings(a.p) === 1, 'exactly once')
  ok(await logSays(a.pane.id, /finished starting/), 'the wait and its end are written down', logOf(a.pane.id))
  manager.kill(a.pane.id)

  // A CLI whose start is long over (the record written, the file quiet): nothing to wait for.
  cli('sess-done')
  hooksDone('sess-done', 60_000)
  const b = open()
  const bAt = await typedAt(b.p, 1200)
  // Not held is what the app logged, as for the shell pane below: a stopwatch here is the
  // PC pool's timer lag, not the gate.
  ok(
    bAt > 0 && (await logSays(b.pane.id, /prompt typed/)) && !/waiting for Claude Code to finish starting/.test(logOf(b.pane.id)),
    'a CLI that has finished starting is typed into at once',
    `${bAt ? bAt - b.at : '-'}ms\n${logOf(b.pane.id)}`
  )
  manager.kill(b.pane.id)

  // The record never comes (hooks stuck): held only until the process is
  // PF_PROMPT_STARTUP_MS old, then typed as it always was.
  cli('sess-stuck')
  hooksPending('sess-stuck')
  const c = open()
  const cAt = await typedAt(c.p, 4500)
  // The logged age from the spawn, as for the short waits below: a stopwatch from `c.at`
  // loses the PC's slow spawn and read 2700-less on 2026-09-28.
  const cWaited = await shortWaitOf(c.pane.id)
  ok(cAt > 0 && cWaited >= 3, 'a record that never comes holds the prompt only up to the ceiling',
    `${cWaited}s waited\n${logOf(c.pane.id)}`)
  ok(await logSays(c.pane.id, /typing anyway/), 'and the log says it was typed without the record', logOf(c.pane.id))
  manager.kill(c.pane.id)

  // NO TRANSCRIPT ON DISK IS NOT "STILL STARTING". Claude Code 2.1.283 often writes none
  // until the first prompt is in: panes s2, s15, s20, s26 and s27 (2026-09-26/27) had their
  // hooks done at +2-11s and their launch prompts held the whole minute, the file born only
  // at +62-67s after the app typed anyway. The pid file alone gets the short wait.
  cli('sess-deferred')
  const f = open()
  // The short wait is 800ms and the ceiling 3000, both counted from the spawn. Which one it
  // was is the age the app logged, not a stopwatch started after `open()` returned: on the
  // PC the spawn itself took 300-500ms, so the prompt went in 488ms after `f.at` having
  // waited the full 800 (2026-09-28, 2 of 3 runs red with a 600ms floor).
  const fAt = await typedAt(f.p, 2500)
  const fWaited = await shortWaitOf(f.pane.id)
  ok(fAt > 0 && fWaited >= 0.8 && fWaited < 2.4,
    'a pid file whose transcript is not on disk yet costs only the short wait, not the ceiling',
    `${fWaited}s waited\n${logOf(f.pane.id)}`)
  ok(await logSays(f.pane.id, /no pid file or transcript yet/), 'and the log says what it was waiting for', logOf(f.pane.id))
  manager.kill(f.pane.id)

  // ONE PASTE, NOT A BURST. 2026-09-27 05:37:04Z, pane s26-mujdy43s: the 2116-char prompt
  // written raw reached the CLI as two 1024-byte reads and a 99-byte tail, Claude Code took
  // them as two pastes and some typing, and its user row was the tail alone. Bracketed, it
  // is one paste however the pty splits it. A slash command stays keystrokes, and so does
  // any agent this was not measured on.
  {
    cli('sess-paste')
    hooksDone('sess-paste', 60_000)
    const g = open()
    await typedAt(g.p, 1500)
    const w = g.p.writes.find((x) => x.includes('RESEARCH QUESTION')) ?? ''
    ok(w === '\x1b[200~' + BRIEF + '\x1b[201~', 'a Claude prompt goes in as one bracketed paste', JSON.stringify(w.slice(0, 40)))
    ok(!g.p.writes.some((x) => x.includes('\x1b[201~\r')), 'and its return is still a keystroke of its own', JSON.stringify(g.p.writes))
    manager.kill(g.pane.id)
    const cmd = manager.start({ cwd: root, agent: 'claude' })
    const cp = manager.sessions.get(cmd.id).proc
    manager.queuePrompt(cmd.id, '/model opus', 0, 40, undefined, 5000, 'idle')
    cp.say(IDLE)
    for (const until = Date.now() + 1500; Date.now() < until && !cp.writes.length; ) await sleep(20)
    ok(cp.writes[0] === '/model opus', 'a slash command is typed, not pasted', JSON.stringify(cp.writes[0]))
    manager.kill(cmd.id)
    const sh = manager.start({ cwd: root, agent: 'shell' })
    const shp = manager.sessions.get(sh.id).proc
    manager.queuePrompt(sh.id, BRIEF, 0, 40, undefined, 5000)
    shp.say(IDLE)
    await typedAt(shp, 1500)
    ok(shp.writes.find((x) => x.includes('RESEARCH QUESTION')) === BRIEF, 'a shell pane gets the text as it was', JSON.stringify(shp.writes))
    manager.kill(sh.id)
    // Codex as well. 2026-09-29 7:59:39am, pane s62-mulltgcs: a 959-char `pf tell` typed
    // as keys, Codex read the burst as a paste and the return after it as a newline, and
    // the brief sat unsent in the composer.
    const cx = manager.start({ cwd: root, agent: 'codex' })
    const cxp = manager.sessions.get(cx.id).proc
    manager.queuePrompt(cx.id, BRIEF, 0, 40, undefined, 5000)
    // The queue reads Codex's composer off the replayed screen before it pastes, so the
    // frame is a drawn one (alternate screen, `› ` row, status row), not a bare placeholder.
    cxp.say('\x1b[?1049h\x1b[2J\x1b[5;1H› \x1b[7;1H  gpt-6.1-sol · 50% left\x1b[5;3H')
    await typedAt(cxp, 1500)
    const cw = cxp.writes.find((x) => x.includes('RESEARCH QUESTION')) ?? ''
    ok(cw === '\x1b[200~' + BRIEF + '\x1b[201~', 'a Codex prompt goes in as one bracketed paste too', JSON.stringify(cw.slice(0, 40)))
    ok(!cxp.writes.some((x) => x.includes('\x1b[201~\r')), 'and its return is a write of its own', JSON.stringify(cxp.writes))
    manager.kill(cx.id)
  }

  // No pid file at all (a CLI that writes none): the short wait, then as before.
  rmSync(pidFile, { force: true })
  const d = open()
  const dAt = await typedAt(d.p, 2500)
  const dWaited = await shortWaitOf(d.pane.id)
  ok(dAt > 0 && dWaited >= 0.8 && dWaited < 2.4, 'a CLI with no pid file costs only the short wait', `${dWaited}s waited\n${logOf(d.pane.id)}`)
  manager.kill(d.pane.id)

  // Restarted while it waited: `restart` re-keys the owed row and queues it again, so the
  // first wait stands down and the prompt goes into the new process ONCE. Before this, both
  // waits typed it - and the gate made that window seconds long instead of a blink.
  cli('sess-restart')
  const e = open()
  await sleep(300)
  manager.restart(e.pane.id)
  const e2 = manager.sessions.get(e.pane.id).proc
  e2.say(IDLE)
  cli('sess-restart-2')
  hooksDone('sess-restart-2')
  await typedAt(e2, 1500)
  await sleep(600)
  ok(typings(e.p, e2) === 1, 'a pane restarted while its prompt waited gets it once, in the new process',
    `${typings(e.p)} in the old, ${typings(e2)} in the new\n${logOf(e.pane.id)}`)
  manager.kill(e.pane.id)

  // Only Claude Code is waited for: a shell pane is typed into on its idle composer alone.
  cli('sess-shell')
  const shell = manager.start({ cwd: root, agent: 'shell' })
  const sp = manager.sessions.get(shell.id).proc
  const sAt0 = Date.now()
  manager.queuePrompt(shell.id, BRIEF, 0, 40, undefined, 5000)
  sp.say(IDLE)
  const sAt = await typedAt(sp, 2500)
  // Held or not is what the app logged, not a stopwatch: the hold says so the moment it starts
  // (`waiting for Claude Code to finish starting`). A 700ms limit failed twice in the PC's
  // full-suite pool (2026-09-27) and never alone on the Mac, where this pane types at ~130ms.
  ok(
    sAt > 0 && (await logSays(shell.id, /prompt typed/)) && !/waiting for Claude Code to finish starting/.test(logOf(shell.id)),
    'a pane that is not Claude Code is not held',
    `${sAt ? sAt - sAt0 : '-'}ms\n${logOf(shell.id)}`
  )
  manager.kill(shell.id)

  // THE PROMPT WENT IN AND THE APP CALLED IT LOST. 2026-09-24 13:26:18.630Z, pane s105: the
  // resume prompt is a user row in its transcript (taskdriver.ai-c, 69ec86bb-...), and the
  // app logged it LOST; five fresh panes on 2026-09-25 logged 5/5 and then 3/5 LOST while
  // every one was answered. The screen could not tell - an idle box, or a pane still
  // painting with no composer to read - so the confirm fed it more returns and gave up. The
  // CLI's own record of the message is the receipt; a paste lands wrapped in its tags.
  const budget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
  const received = (sessionId, at = new Date()) =>
    appendFileSync(join(proj, `${sessionId}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user',
      content: '\n\n<pasted_content id="7c1e">\n' + BRIEF + '\n</pasted_content id="7c1e">' },
    timestamp: at.toISOString(), sessionId }) + '\n')
  // A long paste is stored as several pasted_content chunks, each cut at whitespace
  // (2026-10-01, claude-memory-c e885a4ad: a 3589-char brief as four ~1050-char chunks).
  // The whole payload is still the receipt; a first line alone, or one changed word, is not.
  {
    cli('sess-chunked'); hooksDone('sess-chunked')
    const long = Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ') + '\n\n' +
      Array.from({ length: 160 }, (_, i) => `more${i}`).join(' ')
    const cut = long.indexOf(' ', 1000) + 1
    const row = (content) => appendFileSync(join(proj, 'sess-chunked.jsonl'), JSON.stringify({ type: 'user',
      message: { role: 'user', content }, timestamp: new Date().toISOString(), sessionId: 'sess-chunked' }) + '\n')
    const since = Date.now() - 1000
    row(long.split('\n')[0])
    ok(!claudeAcceptedPrompt(4242, long, since), 'a first line alone is not the receipt for a long paste')
    row('\n\n<pasted_content id="0167">\n' + long.slice(0, cut) + '\n</pasted_content id="0167">\n\n\n' +
      '<pasted_content id="0167">\n' + long.slice(cut).replace('more42 ', 'more4x ') + '\n</pasted_content id="0167">')
    ok(!claudeAcceptedPrompt(4242, long, since), 'a chunked paste with one word changed is not the receipt')
    row('\n\n<pasted_content id="0167">\n' + long.slice(0, cut) + '\n</pasted_content id="0167">\n\n\n' +
      '<pasted_content id="0167">\n' + long.slice(cut) + '\n</pasted_content id="0167">')
    ok(claudeAcceptedPrompt(4242, long, since), 'a long paste stored as several chunks is the receipt')
  }
  const receipt = async (name, paint, stallMs = 0) => {
    cli(name)
    hooksDone(name, 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    if (stallMs) {
      // The row lands once the text is in, and then the app's main thread stalls, so its
      // return timer fires late - the order measured on 2026-09-26.
      for (const until = Date.now() + 3000; Date.now() < until && !p.writes.some((w) => w.includes(BRIEF)); ) await sleep(5)
      received(name)
      for (const until = Date.now() + stallMs; Date.now() < until; );
    }
    await sentReturnAt(p)
    if (!stallMs) received(name)
    const until = Date.now() + budget + 600
    while (Date.now() < until) {
      if (paint) p.say(paint)
      await sleep(50)
    }
    await logSays(pane.id, /prompt submitted|UNSENT/)
    manager.kill(pane.id)
    return { log: logOf(pane.id), settles, returns: returnsOf(p) }
  }

  // The box stays empty and quiet, as it does while Claude Code finishes a submit it took.
  const quiet = await receipt('sess-receipt-idle')
  ok(!/UNSENT/.test(quiet.log) && /Claude transcript receipt/.test(quiet.log),
    'a prompt Claude Code wrote into its transcript is submitted, not UNSENT, on an idle box', quiet.log)
  ok(quiet.returns === 1, 'and no bare return is sent after it', `${quiet.returns} returns`)
  ok(quiet.settles === 1, 'it settles once', String(quiet.settles))

  // The pane keeps painting with no composer anywhere on screen, past the whole confirm.
  const busy = await receipt('sess-receipt-painting', '\r\n  ⎿  SessionStart:startup hook running\r\n')
  ok(!/UNSENT/.test(busy.log) && /Claude transcript receipt/.test(busy.log),
    'a prompt Claude Code wrote into its transcript is submitted while the pane still paints', busy.log)
  ok(busy.settles === 1, 'that settles once too', String(busy.settles))

  // Claude's row stamped BEFORE the app's first return, after the text went in: measured
  // 2026-09-26 in 3 of 3 prompts to a dev copy (the return timer fired seconds late), and
  // a window opened at the return logged one of them LOST (s3-muhsr8eu).
  const lateReturn = await receipt('sess-receipt-early', undefined, 1500)
  ok(!/UNSENT/.test(lateReturn.log) && /Claude transcript receipt/.test(lateReturn.log),
    'a receipt stamped after the text went in but before the return still counts', lateReturn.log)

  // SOMEBODY TYPING AFTERWARDS DOES NOT UN-SEND IT. 2026-09-27 05:37Z, pane s27-mujdy58r:
  // the launch prompt is a user row at 05:37:06.4, a `pf type` re-send of it landed at
  // 05:37:13.8 (a submitted line from outside, which stamps `lastKeyboard`), and the next
  // confirm tick called it UNSENT - queued-prompts.log said LOST for a prompt Claude had.
  {
    cli('sess-receipt-then-hand')
    hooksDone('sess-receipt-then-hand', 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    received('sess-receipt-then-hand')
    manager.write(pane.id, 'sent again by hand\r', 'phone')
    const until = Date.now() + budget + 600
    while (Date.now() < until && !settles) await sleep(50)
    await logSays(pane.id, /prompt submitted|UNSENT/)
    const qpLog = (() => { try { return readFileSync(join(work, 'userData', 'queued-prompts.log'), 'utf8').split('\n').filter((l) => l.includes(pane.id)).join('\n') } catch { return '' } })()
    ok(!/UNSENT/.test(logOf(pane.id)) && /Claude transcript receipt/.test(logOf(pane.id)),
      'a prompt Claude wrote down is submitted even when the pane is typed into afterwards', logOf(pane.id))
    ok(!/LOST/.test(qpLog) && /queued prompt submitted/.test(qpLog), 'and queued-prompts.log says submitted, not LOST', qpLog)
    ok(settles === 1, 'it settles once', String(settles))
    manager.kill(pane.id)
  }

  // ...AND ONE LOOK IS NOT THE ANSWER. 2026-09-27 16:31, pane s81-muk0ypqg: prompt typed
  // 51.545, return 51.902, a submitted line from outside 52.455, the confirm's first look at
  // 55.926 found no receipt and said UNSENT; the transcript's user row is stamped 51.955.
  // Here the receipt cannot be read at the first look (no pid file yet, as when the CLI had
  // not written it) and becomes readable one tick later: it is asked again, and no return
  // goes in on top of the line that was written.
  {
    const name = 'sess-receipt-late-after-hand'
    hooksDone(name, 60_000)
    cli(name)
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    let pane
    try {
      pane = manager.start({ cwd: root, agent: 'claude' })
      const p = manager.sessions.get(pane.id).proc
      let settles = 0
      manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
      p.say(IDLE)
      for (let elapsed = 0; elapsed < 5000 && !returnsOf(p); elapsed += 10) mock.timers.tick(10)
      ok(returnsOf(p) === 1, 'late-receipt fixture sent its initial return')
      const ret = Date.now()
      rmSync(pidFile, { force: true })
      mock.timers.setTime(ret + 1)
      manager.write(pane.id, 'x\r', 'phone')
      // This case has no observed newer turn. The fake clock makes the app's
      // own bookkeeping exactly equal to the return timestamp; keep that from
      // satisfying the separate new-turn proof before the receipt is checked.
      manager.sessions.get(pane.id).meta.runSince = ret - 1
      // Move the clock beyond the deadline without running its overdue callback.
      // Deliver the receipt between the first and second looks, not after an async log write.
      mock.timers.setTime(ret + budget + 200)
      mock.timers.tick(0)
      ok(settles === 0, 'the first look without a receipt does not settle it', String(settles))
      received(name, new Date(ret + 53))
      cli(name)
      mock.timers.tick(Number(process.env.PF_PROMPT_CONFIRM_MS))
      ok(returnsOf(p) === 1, 'and no return went in on top of that line', `${returnsOf(p)} returns`)
      ok(settles === 1, 'it settles once', String(settles))
    } finally {
      mock.timers.reset()
    }
    await logSays(pane.id, /prompt submitted|UNSENT/)
    ok(/Claude transcript receipt \(then the pane was typed into by hand\)/.test(logOf(pane.id)) && !/UNSENT/.test(logOf(pane.id)),
      'a receipt readable a tick later still counts after a line from outside', logOf(pane.id))
    ok(/a phone write submitted while a prompt is owed: "<1>\\r" \(2 bytes, line of \d+ chars\)/.test(logOf(pane.id)), 'the outside line is logged with its shape and origin, never its words', logOf(pane.id))
    manager.kill(pane.id)
  }

  // ...and a transcript without it is still no receipt: the empty box gets its returns.
  cli('sess-receipt-none')
  hooksDone('sess-receipt-none', 60_000)
  {
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    manager.queuePrompt(pane.id, BRIEF, 0, 40, undefined, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    await sleep(budget + 600)
    await logSays(pane.id, /UNSENT/)
    ok(/UNSENT/.test(logOf(pane.id)) && returnsOf(p) > 1,
      'with no user row in the transcript it is still called UNSENT', `${returnsOf(p)} returns\n${logOf(pane.id)}`)
    manager.kill(pane.id)
  }

  // A RETURN INTO A QUESTION IS AN ANSWER. 2026-09-27 04:55Z, pane s9-mujbz9vp: `pf tell`
  // typed into a Claude turn, Claude QUEUED it (a queue-operation enqueue, no user row), an
  // AskUserQuestion was drawn over it, and the retries' five returns answered all four
  // questions and pressed Submit. The frame is the real one, replayed from that pane's
  // history log through @xterm/headless (rows trimmed, the queued text swapped for BRIEF).
  // The records are the shapes Claude Code 2.1.283 wrote into that transcript.
  const ASK_FRAME = [
    '⏺ Agent "Inventory social-media access routes" finished · 9m 22s',
    '',
    '❯ ' + BRIEF.split('\n')[0],
    '  ' + BRIEF.split('\n')[1],
    '─'.repeat(143),
    '←  ☒ X access  ☐ TikTok/IG  ☐ Delivery  ☐ Run length  ✔ Submit  →',
    '',
    'X is the main source. How should the nightly agent read it?',
    '',
    '❯ 1. Free watchlist (Recommended)',
    '     Reads ~120 picked accounts (AI tools, web design, marketing, agency) plus their threads and linked pages through the free X mirror your X',
    '  2. Watchlist + paid X search',
    '     Adds keyword search across all of X through twitterapi.io at US$0.15 per 1,000 posts (checked today), roughly US$5-15 a month at our',
    '  3. Use my logged-in X account',
    '     Full search plus your likes and bookmarks, but it\'s automation on your real account and X can restrict it the way Upwork did on 24 Sep.',
    '  4. Type something.',
    '─'.repeat(143),
    '  5. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
  ].join('\n')
  const queued = (sessionId, record) =>
    appendFileSync(join(proj, `${sessionId}.jsonl`), JSON.stringify({ ...record, timestamp: new Date().toISOString(), sessionId }) + '\n')
  const enqueue = { type: 'queue-operation', operation: 'enqueue',
    content: '<pasted_content id="68c7">\n' + BRIEF + '\n</pasted_content id="68c7">' }
  const qpPath = join(work, 'userData', 'queued-prompts.log')
  const qpOf = (id) => { try { return readFileSync(qpPath, 'utf8').split('\n').filter((l) => l.includes(id)).join('\n') } catch { return '' } }
  const asked = async (name, record, ask) => {
    cli(name)
    hooksDone(name, 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    manager.queuePrompt(pane.id, BRIEF, 0, 40, undefined, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    if (record) queued(name, record)
    if (ask) {
      // The question arrives after the first return, as it did: painted by the CLI, and read
      // off that frame by the renderer's busy reading into `meta.ask`.
      await sleep(50)
      p.say('\x1b[2J\x1b[H' + ASK_FRAME.replace(/\n/g, '\r\n'))
      manager.setBusyOnScreen(pane.id, false, ASK_FRAME)
    }
    await sleep(budget + 600)
    await logSays(pane.id, /prompt submitted|UNSENT|return withheld/)
    const retained = Object.values(JSON.parse(readFileSync(join(work, 'userData', 'queued-prompts.json'), 'utf8')))
      .filter(row => row.id === pane.id)
    const out = { log: logOf(pane.id), qp: qpOf(pane.id), returns: returnsOf(p), asking: Boolean(manager.sessions.get(pane.id).meta.ask), retained }
    manager.kill(pane.id)
    return out
  }

  const both = await asked('sess-queued-ask', enqueue, true)
  ok(both.asking, 'the real AskUserQuestion frame is read as a question on screen', both.log)
  ok(both.returns === 1, 'a queued entry plus a question on screen: zero returns after the first', `${both.returns} returns\n${both.log}`)
  ok(/Claude transcript receipt/.test(both.log) && !/UNSENT/.test(both.log), 'and the queued entry is the receipt, not UNSENT', both.log)
  ok(!/LOST/.test(both.qp) && /queued prompt submitted/.test(both.qp), 'queued-prompts.log says submitted, not LOST', both.qp)

  const askOnly = await asked('sess-ask-only', null, true)
  ok(askOnly.returns === 1, 'a question on screen with no receipt still gets no more returns', `${askOnly.returns} returns\n${askOnly.log}`)
  ok(/selector on screen, return withheld/.test(askOnly.log), 'and the log says the return was withheld', askOnly.log)
  ok(!/LOST|queued prompt submitted/.test(askOnly.qp) && askOnly.retained.length === 1 &&
    askOnly.retained[0].text === BRIEF && Boolean(askOnly.retained[0].typed),
    'a question without a native receipt retains the full typed intent without calling it lost or submitted', askOnly.qp)

  const enqOnly = await asked('sess-enqueue-only', enqueue, false)
  ok(enqOnly.returns === 1 && /Claude transcript receipt/.test(enqOnly.log),
    'a queue-operation enqueue alone is a receipt: no more returns into an idle box', `${enqOnly.returns} returns\n${enqOnly.log}`)

  const attOnly = await asked('sess-queued-command', { type: 'attachment',
    attachment: { type: 'queued_command', prompt: '<pasted_content id="68c7">\n' + BRIEF + '\n</pasted_content id="68c7">',
      commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true } }, false)
  ok(attOnly.returns === 1 && /Claude transcript receipt/.test(attOnly.log),
    'a queued_command attachment alone is a receipt too', `${attOnly.returns} returns\n${attOnly.log}`)

  cli('sess-unconfirmed-clock'); hooksDone('sess-unconfirmed-clock', 60_000)
  const clockPane = manager.start({ cwd: root, agent: 'claude' })
  const clockLive = manager.sessions.get(clockPane.id)
  clockLive.proc.say(IDLE)
  clockLive.proc.onWrite = data => {
    if (data === '\r') {
      clockLive.meta.runSince = Date.now()
      clockLive.proc.say('\x1b[2J\x1b[HStarting MCP servers (0/4) (12s · esc to interrupt)\r\n')
    }
  }
  let clockSettles = 0
  manager.queuePrompt(clockPane.id, BRIEF, 0, 40, () => clockSettles++, 1200)
  await sentReturnAt(clockLive.proc)
  await logSays(clockPane.id, /prompt left UNSENT/, confirmBudget + 5000)
  ok(clockSettles === 1 && clockLive.meta.owedPrompt && !/prompt submitted/.test(logOf(clockPane.id)),
    'a turn clock and unreadable startup paint cannot confirm a Claude prompt without its native receipt', logOf(clockPane.id))
  manager.kill(clockPane.id)

  cli('sess-sole-review'); hooksDone('sess-sole-review', 60_000)
  const solePane = manager.start({ cwd: root, agent: 'claude' })
  const soleLive = manager.sessions.get(solePane.id)
  soleLive.proc.say(IDLE)
  soleLive.proc.onWrite = data => {
    if (data.includes(BRIEF)) soleLive.proc.say('\x1b[2J\x1b[H❯ [Pasted text #1 +7 lines]\r\nRemoved 4 invisible characters · review and press Enter to send\r\n')
  }
  manager.queuePrompt(solePane.id, BRIEF, 0, 40, undefined, 1200)
  await logSays(solePane.id, /return withheld/)
  queued('sess-sole-review', { type: 'user', message: { role: 'user', content: BRIEF.split('\n')[0] } })
  manager.sweepIdle()
  ok(soleLive.meta.owedPrompt, 'a sole withheld prompt remains owed after a partial native receipt')
  received('sess-sole-review')
  manager.sweepIdle()
  ok(!soleLive.meta.owedPrompt && !returnsOf(soleLive.proc) && soleLive.proc.writes.filter(data => data.includes(BRIEF)).length === 1,
    'a sole withheld prompt reconciles its full native receipt without a follower or replay', logOf(solePane.id))
  manager.kill(solePane.id)

  // The two failed real recovery panes never received an accepted prompt or a reply.
  // Their invisible-character review composer must remain an unfinished task.
  cli('sess-review-hold'); hooksDone('sess-review-hold', 60_000)
  const reviewPane = manager.start({ cwd: root, agent: 'claude' })
  const reviewLive = manager.sessions.get(reviewPane.id)
  reviewLive.proc.say(IDLE)
  manager.armCloseWhenDone(reviewPane.id)
  manager.sweepCloseWhenDone(reviewLive, Date.now(), 10_000)
  ok(manager.sessions.has(reviewPane.id), 'an idle startup composer with no completed reply cannot close')
  reviewLive.proc.onWrite = data => {
    if (data.includes(BRIEF)) reviewLive.proc.say('\x1b[2J\x1b[H❯ [Pasted text #1 +7 lines]\r\nRemoved 4 invisible characters · review and press Enter to send\r\n')
  }
  let reviewSettles = 0
  manager.queuePrompt(reviewPane.id, BRIEF, 0, 40, () => reviewSettles++, 1200)
  await logSays(reviewPane.id, /return withheld/)
  const rowsFor = id => Object.values(JSON.parse(readFileSync(join(work, 'userData', 'queued-prompts.json'), 'utf8'))).filter(row => row.id === id)
  ok(reviewSettles === 1 && returnsOf(reviewLive.proc) === 0 && rowsFor(reviewPane.id)[0]?.typed && reviewLive.meta.owedPrompt,
    'an altered pasted prompt is durably retained without blindly approving the review', logOf(reviewPane.id))
  reviewLive.meta.finished = true // Even an older completed reply cannot dispose of owed intent.
  manager.sweepCloseWhenDone(reviewLive, Date.now(), 10_000)
  ok(manager.sessions.has(reviewPane.id), 'typed but unconfirmed intent prevents explicit completion and closure')

  cli('sess-review-restored'); hooksDone('sess-review-restored', 60_000)
  const restored = manager.start({ cwd: root, agent: 'claude' })
  const restoredLive = manager.sessions.get(restored.id)
  restoredLive.proc.say(IDLE)
  forgetQueuedPrompts(); manager.deliverOwed(reviewPane.id, restored.id)
  manager.kill(reviewPane.id)
  const follower = 'A separate follow-up must wait for the original exact receipt.'
  manager.queuePrompt(restored.id, follower, 0, 40, undefined, 400)
  await sleep(650)
  ok(rowsFor(restored.id).some(row => row.text === BRIEF && row.typed) && !restoredLive.proc.writes.some(data => data.includes(BRIEF) || data.includes(follower)),
    'a restored Claude process never replays uncertain typed intent or appends a follower')
  queued('sess-review-restored', { type: 'user', message: { role: 'user', content: BRIEF.split('\n')[0] } })
  await sleep(350)
  ok(rowsFor(restored.id).some(row => row.text === BRIEF) && !restoredLive.proc.writes.some(data => data.includes(follower)),
    'a matching first line with missing payload is not a native delivery receipt')
  restoredLive.proc.onWrite = data => {
    if (data.includes(follower)) queued('sess-review-restored', { type: 'user', message: { role: 'user', content: follower } })
  }
  received('sess-review-restored')
  // Waits for the follower's own settle, not the first receipt line: when the 1s idle sweep
  // reads the receipt before the follower's 40ms poll does, `retained prompt submitted` is
  // logged first and the follower is typed a tick later (2026-10-02, PC: this and the close
  // below read red; `manager.sweepIdle()` right after `received` reproduces it every time).
  const released = () => rowsFor(restored.id).length === 0 && restoredLive.proc.writes.some(data => data.includes(follower))
  for (const until = Date.now() + 6000; !released() && Date.now() < until;) await sleep(40)
  ok(released() && restoredLive.proc.writes.filter(data => data.includes(follower)).length === 1 && !restoredLive.proc.writes.some(data => data.includes(BRIEF)),
    'only the entire native payload releases the retained owner and permits one follower paste', logOf(restored.id))
  const oldReply = manager.replyFor
  manager.replyFor = id => id === restored.id ? { text: 'Completed the requested recovery and verified it.' } : undefined
  restoredLive.meta.status = 'idle'; restoredLive.meta.runSince = undefined; restoredLive.meta.drafting = false
  restoredLive.meta.lastOutput = Date.now() - 10_000; restoredLive.footerEndedAt = Date.now() - 10_000
  restoredLive.busyUntil = 0; restoredLive.typed = ''
  manager.armCloseWhenDone(restored.id); manager.sweepIdle()
  ok(!manager.sessions.has(restored.id), 'a genuine completed reply with no owed intent still closes normally')
  manager.replyFor = oldReply

  // A queue record for some OTHER message is no receipt: the empty box still gets its returns.
  const other = await asked('sess-queued-other', { type: 'queue-operation', operation: 'enqueue',
    content: '<task-notification>\n<task-id>a5bbfa148ebfc4b2f</task-id>\n</task-notification>' }, false)
  ok(other.returns > 1 && /UNSENT/.test(other.log), 'an enqueue of a different message is not a receipt', `${other.returns} returns\n${other.log}`)
  rmSync(pidFile, { force: true })
}

// The reading itself, on the frames it has to tell apart.
{
  const { promptStillInBox } = req('./landed.bundle.cjs')
  const P = 'Continue the handoff: work its Next steps in order.'
  ok(
    promptStillInBox('\u00b7 Leavening\u2026 (3m 56s \u00b7 esc to interrupt)\n\u276f \n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n', P) === false,
    'an empty composer under a busy footer says the prompt left'
  )
  ok(
    promptStillInBox('\u00b7 Starting MCP servers (0/4) (12s)\n\u276f ' + P + '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n', P) === true,
    'a composer holding it says it is still there'
  )
  // Claude Code echoes a SUBMITTED message with the same marker. The composer is the last
  // one drawn, and reading the echo instead is the false "unsent" this whole case is about.
  ok(
    promptStillInBox('> ' + P + '\n\u23fa working on it\n\u276f \n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n', P) === false,
    'the echo of a submitted message is not the composer'
  )
  // A long prompt wraps onto indented rows, and only the first carries the marker.
  ok(
    promptStillInBox('\u276f ' + P.slice(0, 30) + '\n  ' + P.slice(30) + '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n', P) === true,
    'a wrapped composer is still one composer'
  )
  ok(promptStillInBox('\u23fa nothing that looks like a composer at all\n', P) === null, 'a frame with no composer answers null, never a guess')
  // A long paste is drawn as a placeholder. Read for its words that composer "does not hold
  // it", and a prompt still waiting was logged as gone.
  ok(promptStillInBox('\u2022 Working (3s \u2022 esc to interrupt)\n\u203a [Pasted Content 959 chars]\n', P) === true,
    'a Codex paste placeholder is the prompt still in the composer')
  ok(promptStillInBox('\u276f [Pasted text #1 +26 lines]\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n', P) === true,
    '...and so is a Claude one')
  ok(promptStillInBox('\u2022 Working (3s \u2022 esc to interrupt)\n\u203a \n', P) === false, 'an empty Codex composer still reads as gone')
  ok(promptStillInBox('\u276f \n', 'go') === null, 'a prompt too short to recognise answers null')
}

// A pane that closes mid-wait settles too - otherwise the curtain outlives the pty.
const dying = manager.start({ cwd: root, agent: 'shell' })
let dead2 = 0
manager.queuePrompt(dying.id, 'never lands', 0, 40, () => dead2++)
manager.sessions.delete(dying.id)
await sleep(400)
ok(dead2 === 1, 'a pane that went away settles the curtain rather than stranding it', String(dead2))

// A new process cannot inherit a composer shadow from the replaced CLI.
{
  const pane = manager.start({ cwd: root, agent: 'shell' })
  manager.write(pane.id, 'unsent draft')
  manager.write(pane.id, '\x1b[A')
  const live = manager.sessions.get(pane.id)
  ok(Boolean(live.meta.drafting), 'history navigation protects an uncertain draft')
  manager.restart(pane.id)
  ok(live.typed === '' && live.submitLine.text === '' && live.draft.text === '' &&
    live.draft.certain && !live.meta.drafting, 'restart clears all old composer shadows')
}

// ---------------------------------------------------------------------------
// SOURCE: a busy pane is waited out, never counted as a submit.
//
// 2026-08-30, pane s7-mtfk52fv: an autoclear typed its resume prompt, sent one return
// while the freshly restarted CLI was still painting its banner and hook chain, and the
// confirm branch read that paint as "it went in" and settled. The pane sat at a composer
// holding a fully typed prompt nobody had sent, and the app's own history log ended at
// that write. The proof a return landed is a TURN, not output.
{
  const src = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
  const submitStart = src.indexOf('const submit = (tries: number)')
  const fn = src.slice(submitStart, src.indexOf('const tick = ', submitStart))
  ok(/runSince \?\? 0\) >= typedAt/.test(fn), 'a turn newer than the return is the only proof it went in')
  // ...for a PROMPT. `write()` stamps `runSince` on every return it sends, so a slash
  // command - which starts no turn - would otherwise be proven by this app's own keystroke.
  ok(/proof !== 'idle' && [^\n]*\(still\.meta\.runSince/.test(fn),
    'and a command ignores that stamp, because the return this sends is what set it')
  // ...and neither does a turn, while the composer is still drawing the prompt: the CLI's
  // busy footer re-anchors `runSince` whether or not the return went in.
  ok(/heldNow !== true && \(still\.meta\.runSince/.test(fn),
    'a turn is not proof while the composer still holds the prompt')
  ok(/proof === 'idle' && idle\(still\) && \(still\.meta\.lastOutput \?\? 0\) > typedAt/.test(fn),
    'a command is proven by the pane PRINTING something, never by silence')
  ok(/if \(!idle\(still\)\) \{[\s\S]*?return confirm\(\)/.test(fn), 'a painting pane must be waited out, not settled')
  // ...AND THE CONFIRM IS BOUNDED BY ITS OWN CLOCK, NOT THE WAIT'S.
  // 2026-09-01, pane s31-mti4yatg: the composer only read idle 181s into a 180s budget,
  // so the return went out with the deadline already past and the very first confirm
  // logged UNSENT with five retries unused. `handoverMaxMs` always sized the curtain as
  // `budgetMs + PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES`; only this branch disagreed.
  ok(/Date\.now\(\) >= confirmUntil\)/.test(fn), 'and the wait must still be bounded')
  // ...and the give-up is not the last word: the composer is read before a prompt the
  // agent is answering is written off as unsent.
  ok(/promptStillInBox\(painted, prompt\)/.test(fn), 'the give-up reads the composer before it calls a prompt unsent')
  ok(/codexAcceptedPrompt\(id, prompt, typedAt - 1000\)/.test(fn), 'an exact native Codex user row proves a queued follow-up was accepted')
  ok(/box === true && still\.meta\.agent === 'codex'[^\n]*\n[\s\S]{0,200}return submit\(tries \+ 1\)/.test(fn),
    'a Codex composer still holding the prompt at the deadline gets another return, not UNSENT')
  ok(/box === false/.test(fn) && /settle\('sent'\)/.test(fn), 'an empty composer settles it as sent')

  ok(!/Date\.now\(\) >= deadline\)/.test(fn), 'the confirm may not expire on the WAIT deadline')
  ok(
    /confirmUntil = typedAt \+ PROMPT_CONFIRM_MS \* PROMPT_ENTER_TRIES/.test(
      fn
    ),
    'the confirm clock starts at the return and lasts every retry it is allowed'
  )
  ok(!/if \(still && idle\(still\)\) submit\(tries \+ 1\)\s*\n\s*else settle\(\)/.test(fn),
    'the old settle-on-busy branch is the bug and must be gone')

  // SOURCE: every exit is written DOWN.
  //
  // 2026-08-30, pane s6-mtfk52fr: an autoclear typed its resume prompt and it was never
  // submitted. Which of the five exits took it could not be established, because all of
  // them reported through `console.info` - a stdout nobody keeps when the app is launched
  // from the dock. This is the third incident in this function whose cause had to be
  // guessed at; `acLog` is the durable record the arm path already writes to.
  const qp = src.slice(src.indexOf('private queuePrompt('), src.indexOf('private sweepRecover('))
  ok(!/console\.info/.test(qp), 'no exit from queuePrompt reports to a stdout nobody keeps')
  ok((qp.match(/acLog\(/g) || []).length >= 6, 'every branch leaves a line in the durable log',
    String((qp.match(/acLog\(/g) || []).length))
  ok(/UNSENT/.test(qp), 'and a prompt left in the box says so in those words')

  // SOURCE: a `/clear` restarts the CLI, so the resume prompt gets its own budget.
  //
  // 45s is a fair ceiling on a CLI that is merely booting. It is not one on a CLI that
  // boots and then runs this desk's whole SessionStart hook chain, which is what a clear
  // produces - and the failure at the end of that budget is the worst one here: the
  // context is already gone and the prompt that would have carried the work forward is
  // sitting unsent in the box.
  ok(/CLEAR_RESUME_BUDGET_MS = ms\('PF_CLEAR_RESUME_BUDGET_MS', (\d[\d_]*)\)/.test(src),
    'the clear resume has a budget of its own')
  const clearBudget = Number(RegExp.$1.replace(/_/g, ''))
  const launchBudget = Number((src.match(/PROMPT_WAIT_MAX_MS = ms\('PF_PROMPT_WAIT_MAX_MS', (\d[\d_]*)\)/) || [])[1]?.replace(/_/g, '') || 0)
  ok(clearBudget > launchBudget, 'and it is longer than a launch prompt gets',
    `${clearBudget} vs ${launchBudget}`)
  ok(/queuePrompt\(id, resume, 0, switchCmd \? SUBMIT_GAP_MS : CLEAR_PROMPT_START_MS,[\s\S]{0,80}?CLEAR_RESUME_BUDGET_MS\)/.test(src),
    'the autoclear resume is the call that uses it')
  ok(/this\.queuePrompt\(id, switchCmd, 0, CLEAR_PROMPT_START_MS,[\s\S]{0,400}?CLEAR_RESUME_BUDGET_MS, 'idle'\)/.test(src),
    'the model switch is proven by an idle composer, never by a turn - a slash command starts none')
  ok(/setHandover\(id, Date\.now\(\) \+ handoverMaxMs\(CLEAR_RESUME_BUDGET_MS\)\)/.test(src),
    'and the curtain outlives that wait, so the pane says a prompt is still coming')
}

// Production queue + terminal replay + exact native JSONL, with no real CLI or home.
// The raw repaint has no LF: stripping escapes cannot reconstruct this composer.
{
  let fixture = 0
  const payload = 'first line: preserve this newline\n  indented second line\n\nlast line'
  // A ceiling, not a stopwatch: every wait below answers the moment its condition holds, so
  // only a failing run pays it. 6s because the PC's loaded pool stalled this process past
  // 2.4s mid-case (2026-10-01 98c30508; 2026-10-02 master 913bcdd8: the unknown owner's
  // budget, the stale turn's follow-up and the Ctrl-C follow-up each read red once). A 2.5s
  // stall after the queue reproduces each on the Mac.
  const waitFor = async (test, ms = 6000) => {
    const until = Date.now() + ms
    while (!test() && Date.now() < until) await sleep(20)
    return test()
  }
  const frame = (text, working = false) => {
    const lines = text.split('\n')
    let raw = '\x1b[?1049h\x1b[2J'
    if (working) raw += '\x1b[2;1H• Working (2s · esc to interrupt)'
    lines.forEach((line, n) => { raw += `\x1b[${5 + n};1H${n ? '  ' : '› '}${line}` })
    raw += `\x1b[${6 + lines.length};1H  gpt-6.1-sol · 50% left`
    return raw + `\x1b[${4 + lines.length};${3 + lines.at(-1).length}H`
  }
  const open = () => {
    const conversation = `12345678-1234-1234-1234-${String(++fixture).padStart(12, '0')}`
    const file = join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30', `queue-${fixture}.jsonl`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: conversation, cwd: root, timestamp: new Date().toISOString() } }) + '\n')
    const pane = manager.start({ cwd: root, agent: 'codex', resume: true, resumeId: conversation })
    const live = manager.sessions.get(pane.id)
    live.cols = 134; live.rows = 53
    live.proc.say(frame(''))
    const received = (text) => {
      appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text }]
      } }) + '\n')
    }
    return { pane, live, p: live.proc, received, conversation, file }
  }
  const queue = (f, text = payload, budget = 1800) => {
    let settled = 0
    manager.queuePrompt(f.pane.id, text, 0, 40, () => settled++, budget)
    return () => settled
  }
  const pasted = (p, text = payload) => p.writes.includes('\x1b[200~' + text + '\x1b[201~')
  const ledger = (id) => Object.values(JSON.parse(readFileSync(join(work, 'userData', 'queued-prompts.json'), 'utf8'))).filter(row => row.id === id)

  const startup = open()
  startup.p.onWrite = data => {
    if (data.includes(payload)) startup.p.say(frame(payload))
    if (data === '\r') startup.received(payload)
  }
  const startupSettled = queue(startup)
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
  const terminal = new Terminal({cols:73,rows:28,allowProposedApi:true})
  const replies = []
  terminal.onData(data => {
    replies.push(data)
    manager.write(startup.pane.id,data,'desk',true)
  })
  await new Promise(resolve => terminal.write('\x1b[6n\x1b[c',resolve))
  terminal.dispose()
  ok(JSON.stringify(replies) === JSON.stringify(['\x1b[1;1R','\x1b[?1;2c']) &&
    startup.live.draft.certain && !startup.live.draft.text && !startup.live.meta.drafting &&
    !manager.codexQueued.get(startup.pane.id)?.foreign,
    'real xterm startup replies reach PTY without claiming or poisoning the queued composer')
  ok(await waitFor(() => startupSettled() === 1) &&
    startup.p.writes.filter(data => data === '\x1b[200~' + payload + '\x1b[201~').length === 1 && ledger(startup.pane.id).length === 0,
    'startup replies preserve one multiline delivery confirmed by the exact native receipt',logOf(startup.pane.id))
  manager.kill(startup.pane.id)

  const trusted = open()
  queue(trusted)
  trusted.p.say('\x1b[2J\x1b[HDo you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, exit\r\nEnter to select\r\n')
  manager.write(trusted.pane.id, '\r', 'desk')
  const trustForeign = manager.codexQueued.get(trusted.pane.id)?.foreign
  trusted.p.say(frame(''))
  trusted.p.onWrite = data => {
    if (data.includes(payload)) trusted.p.say(frame(payload))
    if (data === '\r') trusted.received(payload)
  }
  ok(await waitFor(() => ledger(trusted.pane.id).length === 0) && !trustForeign &&
    trusted.p.writes.filter(data => data === '\x1b[200~' + payload + '\x1b[201~').length === 1,
    'a pre-paste trust choice preserves the empty checked composer and exact queued delivery', logOf(trusted.pane.id))
  manager.kill(trusted.pane.id)

  const foreignTrust = open()
  queue(foreignTrust, payload, 300)
  manager.write(foreignTrust.pane.id, 'human', 'desk')
  foreignTrust.p.say('\x1b[2J\x1b[HDo you trust the contents of this directory?\r\n› 1. Yes, proceed\r\n  2. No, exit\r\nEnter to select\r\n')
  manager.write(foreignTrust.pane.id, '\r', 'desk')
  const stillForeign = manager.codexQueued.get(foreignTrust.pane.id)?.foreign
  foreignTrust.p.say(frame(''))
  await sleep(420)
  ok(stillForeign && !pasted(foreignTrust.p),
    'accepting a trust chooser never clears genuine earlier user ownership', logOf(foreignTrust.pane.id))
  manager.kill(foreignTrust.pane.id)

  for (const [name,data,tagged] of [
    ['typing','human',false],['arrow','\x1b[D',false],['Shift-F3','\x1b[1;2R',false],
    ['paste','\x1b[200~human\x1b[201~',false],['invalid protocol tag','human',true]
  ]) {
    const edited = open()
    queue(edited,payload,300)
    manager.write(edited.pane.id,data,'desk',tagged)
    const claimed = manager.codexQueued.get(edited.pane.id)?.foreign
    await sleep(420)
    ok(claimed && !pasted(edited.p) && !returnsOf(edited.p) && edited.p.writes.includes(data),
      `${name} still owns the composer and prevents queued startup paste`,logOf(edited.pane.id))
    manager.kill(edited.pane.id)
  }

  const hint = 'Ask Codex to do anything'
  const hinted = open()
  hinted.p.say(frame(`\x1b[2m${hint}\x1b[22m`).replace(/\x1b\[5;\d+H$/, '\x1b[5;3H'))
  hinted.p.onWrite = data => {
    if (data.includes(payload)) hinted.p.say(frame(payload))
    if (data === '\r') hinted.received(payload)
  }
  const hintSettled = queue(hinted)
  ok(await waitFor(() => hintSettled() === 1) &&
    hinted.p.writes.filter(data => data === '\x1b[200~' + payload + '\x1b[201~').length === 1 && ledger(hinted.pane.id).length === 0,
    'native dim placeholder permits one multiline paste proven by its exact native receipt', logOf(hinted.pane.id))
  // Its own Enter set a draft hold; the receipt is the proof that releases it, not a
  // later screen reading, or the next queued prompt sits behind a box already empty.
  ok(!hinted.live.meta.drafting && !hinted.live.draftConfirmation,
    'a prompt proven sent by its receipt drops its own draft hold at once', JSON.stringify(hinted.live.draftConfirmation))
  manager.kill(hinted.pane.id)

  const literalDraft = open()
  literalDraft.p.say(frame(hint).replace(/\x1b\[5;\d+H$/, '\x1b[5;3H'))
  const draftSettled = queue(literalDraft, payload, 300)
  await sleep(700)
  ok(draftSettled() === 0 && !pasted(literalDraft.p) &&
    ledger(literalDraft.pane.id).some(row => row.text === payload && !row.typed),
    'regular same-string draft with caret at start keeps queued bytes out and preserves accepted intent')
  manager.kill(literalDraft.pane.id)

  const persistence = open()
  const markerFile = join(work, 'userData', 'queued-prompts.json.tmp')
  mkdirSync(markerFile)
  const persistenceSettled = queue(persistence)
  ok(await logSays(persistence.pane.id, /durable delivery marker could not be saved/) && persistenceSettled() === 0 && persistence.p.writes.length === 0 &&
    ledger(persistence.pane.id).some(row => row.text === payload && !row.typed) &&
    !manager.codexQueued.has(persistence.pane.id),
    'failed durable typed marker keeps accepted intent without bytes or a phantom composer owner', logOf(persistence.pane.id))
  rmSync(markerFile, { recursive: true })
  persistence.p.onWrite = data => {
    if (data.includes(payload)) persistence.p.say(frame(payload))
    if (data === '\r') persistence.received(payload)
  }
  ok(await waitFor(() => pasted(persistence.p) && ledger(persistence.pane.id).length === 0) && persistenceSettled() === 1,
    'the existing wait retries after persistence recovers and completes its caller exactly once', logOf(persistence.pane.id))
  manager.kill(persistence.pane.id)

  // The autoclear caller chains a model switch's completion to a confirm and resume.
  // Exercise that same production callback boundary across a failed durable marker.
  const ordered = open()
  const switchText = '/model gpt-6.1-sol'
  const orderedResume = 'resume only after the model switch completes'
  const order = []
  let switchCompleted = 0
  let resumeCompleted = 0
  manager.setHandover(ordered.pane.id, Date.now() + 10_000)
  ordered.p.onWrite = data => {
    if (data === switchText) { order.push('switch text'); ordered.p.say(frame(switchText)) }
    if (data === '\r') {
      order.push('return')
      if (pasted(ordered.p, orderedResume)) ordered.received(orderedResume)
      else setTimeout(() => ordered.p.say(frame('') + '\x1b[2;1HModel updated\x1b[5;3H'), 10)
    }
    if (data.includes(orderedResume)) { order.push('resume text'); ordered.p.say(frame(orderedResume)) }
  }
  mkdirSync(markerFile)
  manager.queuePrompt(ordered.pane.id, switchText, 0, 40, () => {
    switchCompleted++
    order.push('switch completed')
    setTimeout(() => {
      manager.write(ordered.pane.id, '\r', 'app')
      manager.queuePrompt(ordered.pane.id, orderedResume, 0, 40, () => {
        resumeCompleted++
        manager.setHandover(ordered.pane.id, 0)
      }, 1800)
    }, 20)
  }, 1800, 'idle')
  ok(await logSays(ordered.pane.id, /durable delivery marker could not be saved/) &&
    switchCompleted === 0 && resumeCompleted === 0 && ordered.p.writes.length === 0 && ordered.live.meta.handoverUntil,
    'transient switch persistence failure neither runs the sequencing callback nor releases its handover')
  rmSync(markerFile, { recursive: true })
  ok(await waitFor(() => resumeCompleted === 1, 3500) && switchCompleted === 1 &&
    order.join('|') === 'switch text|return|switch completed|return|resume text|return' &&
    ledger(ordered.pane.id).length === 0 && !ordered.live.meta.handoverUntil,
    'storage recovery completes the model switch before its confirm and resume, exactly once', order.join('|'))
  manager.kill(ordered.pane.id)

  const held = open()
  held.p.onWrite = (data) => {
    if (data.includes(payload)) held.p.say(frame(payload, true))
    if (data === '\r') {
      // Cursor-only footer repaint leaves the composer outside the newest paint tail.
      held.p.say('\x1b[2;1H\x1b[2K• Working (3s · esc to interrupt)\x1b[8;12H')
      if (returnsOf(held.p) === 2) held.received(payload)
    }
  }
  const heldSettled = queue(held)
  ok(await waitFor(heldSettled), 'a held Codex prompt gets a bounded confirmation')
  ok(pasted(held.p), 'Codex multiline text is one bracketed paste with every LF intact')
  ok(returnsOf(held.p) === 2, 'actual held composer permits one safe retry despite a cursor-only Working repaint', String(returnsOf(held.p)))
  ok(await logSays(held.pane.id, /native Codex receipt/) && ledger(held.pane.id).length === 0,
    'only the exact multiline native receipt settles that prompt as submitted', logOf(held.pane.id))
  manager.kill(held.pane.id)

  const foreign = open()
  foreign.p.onWrite = (data) => {
    if (data.includes(payload)) foreign.p.say(frame(payload))
  }
  const foreignSettled = queue(foreign)
  await sentReturnAt(foreign.p)
  manager.write(foreign.pane.id, 'another human line', 'phone')
  setTimeout(() => foreign.received(payload), 350)
  ok(await waitFor(foreignSettled) && await logSays(foreign.pane.id, /native Codex receipt/),
    'a delayed native Codex receipt still wins after external typing', logOf(foreign.pane.id))
  ok(returnsOf(foreign.p) === 1, 'no retry is sent into the external writer’s line',
    `${returnsOf(foreign.p)} returns\n${logOf(foreign.pane.id)}`)
  manager.kill(foreign.pane.id)

  const unknown = open()
  unknown.p.onWrite = (data) => {
    if (data.includes(payload)) unknown.p.say('\x1b[2J\x1b[1;1H• Working (4s · esc to interrupt)')
    if (data === '\r') unknown.live.meta.runSince = Date.now() + 1
  }
  const unknownSettled = queue(unknown)
  ok(await waitFor(unknownSettled), 'an unknown composer confirmation ends within its budget')
  ok(returnsOf(unknown.p) === 1 && ledger(unknown.pane.id).some(row => row.text === payload) && unknown.live.meta.owedPrompt,
    'paint and a newer turn clock cannot confirm Codex; unknown draft retains its full ledger and owner',
    `${returnsOf(unknown.p)} returns, ${ledger(unknown.pane.id).length} rows, owed=${unknown.live.meta.owedPrompt}\n${logOf(unknown.pane.id)}`)
  const blockedNext = queue(unknown, 'later queued message must not append', 300)
  ok(await logSays(unknown.pane.id, /queued prompt retained/) && blockedNext() === 0 && !pasted(unknown.p, 'later queued message must not append'),
    'a later queue cannot append after the unknown owner has settled unsuccessfully', logOf(unknown.pane.id))
  ok(ledger(unknown.pane.id).some(row => row.text === 'later queued message must not append' && !row.typed),
    'a never-typed second accepted prompt survives its wait deadline')
  unknown.received(payload)
  const afterReceipt = Date.now()
  await waitFor(() => Date.now() - afterReceipt >= 400)
  ok(!pasted(unknown.p, 'later queued message must not append') &&
    ledger(unknown.pane.id).some(row => row.text === 'later queued message must not append' && !row.typed),
    'an exact earlier receipt does not discard or paste the second intent while the actual composer remains unknown')
  unknown.p.say(frame('a foreign held draft'))
  const nonemptyAt = Date.now()
  await waitFor(() => Date.now() - nonemptyAt >= 200)
  ok(!pasted(unknown.p, 'later queued message must not append') &&
    ledger(unknown.pane.id).some(row => row.text === 'later queued message must not append' && !row.typed),
    'a nonempty composer after the receipt preserves the accepted second intent')
  unknown.p.say(frame(''))
  const later = 'later queued message must not append'
  unknown.p.onWrite = data => {
    if (data.includes(later)) unknown.p.say(frame(later))
    if (data === '\r') unknown.received(later)
  }
  // The receipt says the held prompt went in, so the turn still on the clock is its
  // answer, and an idle-looking composer mid-turn is no licence to steer into it.
  const idleAt = Date.now()
  await waitFor(() => Date.now() - idleAt >= 600)
  ok(!pasted(unknown.p, later) && blockedNext() === 0,
    'a follow-up behind a held prompt that is then accepted waits for that prompt’s turn', logOf(unknown.pane.id))
  unknown.live.meta.runSince = undefined
  unknown.live.busyUntil = 0
  ok(await waitFor(() => pasted(unknown.p, later) && ledger(unknown.pane.id).length === 0) && blockedNext() === 1,
    'a late exact receipt promotes the retained second prompt without another queue call',
    `pasted=${pasted(unknown.p, later)}, rows=${ledger(unknown.pane.id).length}\n${logOf(unknown.pane.id)}`)
  manager.kill(unknown.pane.id)

  // A stale owner - another process's, about to be dropped - says nothing about whose
  // turn is running. A follow-up queued during that turn still waits for it to end.
  const stale = open()
  stale.live.meta.runSince = Date.now() - 1000
  stale.live.busyUntil = Date.now() + 60_000
  manager.codexQueued.set(stale.pane.id, { key: 'an-old-process-row', live: stale.live, proc: {}, prompt: 'old process prompt',
    since: Date.now() - 5000, writing: false, foreign: true, proof: 'receipt' })
  const staleNext = 'typed only after the running turn ends'
  stale.p.onWrite = data => {
    if (data.includes(staleNext)) stale.p.say(frame(staleNext))
    if (data === '\r') stale.received(staleNext)
  }
  const staleSettled = queue(stale, staleNext, 300)
  const staleAt = Date.now()
  await waitFor(() => Date.now() - staleAt >= 700)
  ok(!pasted(stale.p, staleNext), 'a stale held owner does not let a follow-up into a turn already running', logOf(stale.pane.id))
  stale.live.meta.runSince = undefined
  stale.live.busyUntil = 0
  ok(await waitFor(() => staleSettled() === 1 && pasted(stale.p, staleNext)),
    'and that follow-up is typed when the turn ends', logOf(stale.pane.id))
  manager.kill(stale.pane.id)

  // The held prompt can prove ITSELF sent first: its own receipt check runs one confirm
  // after its return, and a follow-up queued during that turn may not look until later.
  // That settle removes the owner the follow-up was queued behind, while the turn the
  // receipt proves is still running over Codex's empty box - and the follow-up's budget
  // running out is no licence to steer into it.
  const selfSent = open()
  const heldFirst = 'held prompt that proves itself sent'
  const heldNext = 'follow-up queued during the self-confirmed turn'
  selfSent.p.onWrite = data => {
    if (data.includes(heldFirst)) selfSent.p.say(frame(heldFirst))
    if (data.includes(heldNext)) selfSent.p.say(frame(heldNext))
    if (data !== '\r') return
    if (pasted(selfSent.p, heldNext)) { selfSent.received(heldNext); return }
    // The return went in: the box empties, the turn starts (its footer read as busy, so
    // the 4s quiet backstop cannot end it mid-test), and the receipt is written.
    selfSent.live.meta.runSince = Date.now()
    selfSent.live.busyUntil = Date.now() + 60_000
    selfSent.p.say(frame('', true))
    selfSent.received(heldFirst)
  }
  const heldFirstSettled = queue(selfSent, heldFirst)
  ok(await waitFor(() => returnsOf(selfSent.p) === 1), 'the held prompt is typed and its return sent', logOf(selfSent.pane.id))
  // Queued after that return, first look 1.5s later: the held prompt's own confirm is
  // 200ms after its return, and the PC's loaded pool runs timers 300-650ms late, so the
  // order this case is about holds there too (asserted, not assumed). Its 300ms budget is
  // spent by then, so the old code typed on that first look.
  let heldNextSettled = 0
  const heldNextAt = Date.now()
  manager.queuePrompt(selfSent.pane.id, heldNext, 0, 1500, () => heldNextSettled++, 300)
  ok(await waitFor(() => heldFirstSettled() === 1, 1400) && !manager.codexQueued.has(selfSent.pane.id) && heldNextSettled === 0,
    'the held prompt confirms itself before the follow-up first looks', logOf(selfSent.pane.id))
  await waitFor(() => Date.now() - heldNextAt >= 3000, 3200)
  ok(!pasted(selfSent.p, heldNext) && heldNextSettled === 0 && Boolean(selfSent.live.meta.runSince),
    'a follow-up behind a held prompt that confirmed itself waits for that prompt’s turn, past its own budget',
    `pasted=${pasted(selfSent.p, heldNext)} settled=${heldNextSettled}\n${logOf(selfSent.pane.id)}`)
  manager.setBusyOnScreen(selfSent.pane.id, false, '')
  selfSent.p.say(frame(''))
  ok(await waitFor(() => heldNextSettled === 1 && pasted(selfSent.p, heldNext) && ledger(selfSent.pane.id).length === 0),
    'and it is typed once that turn ends', logOf(selfSent.pane.id))
  manager.kill(selfSent.pane.id)

  // All waiting followers share the retained owner's negative native scan. Count
  // real 2 MiB reads, including invalidation without a terminal repaint.
  const scanHeld = open()
  appendFileSync(scanHeld.file, (JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(4000) } }) + '\n').repeat(600))
  scanHeld.p.onWrite = data => { if (data.includes(payload)) scanHeld.p.say(frame(payload)) }
  const scanHead = queue(scanHeld)
  ok(await waitFor(scanHead), 'scan fixture retains an unconfirmed typed head')
  const fs = req('node:fs')
  const originalFs = { openSync: fs.openSync, readSync: fs.readSync, statSync: fs.statSync }
  const scanFds = new Set()
  let scans = 0, statChecks = 0, failedStats = 0, failedReads = 0, failStat = false, failRead = false, frozenStat
  fs.openSync = (file, ...args) => {
    const fd = originalFs.openSync(file, ...args)
    if (String(file) === scanHeld.file) scanFds.add(fd)
    else scanFds.delete(fd)
    return fd
  }
  fs.readSync = (fd, buf, ...args) => {
    if (scanFds.has(fd) && buf.length === 2 * 1024 * 1024 && failRead) {
      failedReads++
      throw new Error('fixture read unavailable')
    }
    const got = originalFs.readSync(fd, buf, ...args)
    if (scanFds.has(fd) && buf.length === 2 * 1024 * 1024) scans++
    return got
  }
  fs.statSync = (file, ...args) => {
    if (String(file) === scanHeld.file) {
      statChecks++
      if (failStat) { failedStats++; throw new Error('fixture stat unavailable') }
      if (frozenStat) return frozenStat
    }
    return originalFs.statSync(file, ...args)
  }
  try {
    const initialReturns = returnsOf(scanHeld.p)
    for (let n = 0; n < 8; n++) queue(scanHeld, `scan follower ${n}`, 300)
    ok(await waitFor(() => statChecks >= 32) && scans === 1 && ledger(scanHeld.pane.id).length === 9,
      'eight followers poll an unchanged rollout repeatedly but share one 2 MiB negative scan', `stats=${statChecks}, scans=${scans}`)
    scanHeld.received(payload.replace('first', 'wrong'))
    ok(await waitFor(() => scans === 2) && ledger(scanHeld.pane.id).length === 9,
      'a delayed append invalidates the shared miss without accepting a different prompt')
    const beforeRewrite = originalFs.statSync(scanHeld.file)
    writeFileSync(scanHeld.file, readFileSync(scanHeld.file, 'utf8').replace('wrong line:', 'other line:'))
    utimesSync(scanHeld.file, beforeRewrite.atime, beforeRewrite.mtime)
    ok(await waitFor(() => scans === 3) && originalFs.statSync(scanHeld.file).size === beforeRewrite.size &&
      ledger(scanHeld.pane.id).length === 9,
      'a same-size rewrite with restored mtime invalidates the miss through file change identity')
    const unchangedStat = originalFs.statSync(scanHeld.file)
    failStat = true
    ok(await waitFor(() => failedStats >= 8), 'unavailable stat is retried without discarding the retained intent')
    writeFileSync(scanHeld.file, readFileSync(scanHeld.file, 'utf8').replace('other line:', 'first line:'))
    // Simulate the same signature returning after a transient stat failure. The
    // failed check must have cleared its prior miss, so this receipt is still read.
    frozenStat = unchangedStat
    failRead = true
    failStat = false
    ok(await waitFor(() => failedReads >= 8) && scans === 3 && ledger(scanHeld.pane.id).length === 9,
      'transient read failure is retried with the same signature and preserves every intent')
    failRead = false
    scanHeld.p.say(frame('a foreign draft still owns the composer'))
    ok(await waitFor(() => ledger(scanHeld.pane.id).length === 8) && scans === 4 &&
      ledger(scanHeld.pane.id).every(row => row.text.startsWith('scan follower ') && !row.typed) &&
      returnsOf(scanHeld.p) === initialReturns && scanHeld.p.writes.filter(data => data.includes(payload)).length === 1,
      'a receipt after stat recovery acknowledges only the head and never repastes its waiting followers', `scans=${scans}`)
    console.log(`receipt scan regression: 8 followers, ${statChecks} stat checks, ${scans} scans across 4 file states`)
  } finally {
    Object.assign(fs, originalFs)
    manager.kill(scanHeld.pane.id)
  }

  const finalLF = open()
  const terminated = payload + '\n'
  finalLF.p.onWrite = data => {
    if (data.includes(terminated)) finalLF.p.say(frame(terminated))
    if (data === '\r') finalLF.received(payload)
  }
  const finalLFSettled = queue(finalLF, terminated)
  ok(await waitFor(finalLFSettled) && returnsOf(finalLF.p) === 1 &&
    finalLF.p.writes.filter(data => data === '\x1b[200~' + terminated + '\x1b[201~').length === 1 &&
    ledger(finalLF.pane.id).length === 0 && !finalLF.live.meta.owedPrompt,
    'the native receipt omitting only the final LF clears its durable intent without another paste or Return', logOf(finalLF.pane.id))
  manager.kill(finalLF.pane.id)

  // An altered native row missing interior LFs cannot acknowledge the original.
  const changed = open()
  changed.p.onWrite = data => {
    if (data.includes(payload)) changed.p.say(frame(payload))
    if (data === '\r') changed.received(payload.replace(/\n/g, ''))
  }
  const changedSettled = queue(changed)
  ok(await waitFor(changedSettled) && ledger(changed.pane.id).some(row => row.text === payload),
    'a native row missing interior LF is not normalized into an exact receipt')
  ok(!/prompt submitted/.test(logOf(changed.pane.id)), 'missing interior LF never reports Codex as submitted')
  const nextHeld = queue(changed, 'must not append to held prompt', 300)
  ok(await logSays(changed.pane.id, /queued prompt retained/) && nextHeld() === 0 && !pasted(changed.p, 'must not append to held prompt'),
    'a held composer also retains ownership after all safe retries expire')
  manager.kill(changed.pane.id)

  const asked = open()
  asked.live.meta.ask = { question: 'synthetic dialog', options: [] }
  const askedSettled = queue(asked, payload, 300)
  ok(await logSays(asked.pane.id, /queued prompt retained/) && askedSettled() === 0 && asked.p.writes.length === 0, 'a dialog blocks Codex paste without completing a deferred sequencing callback')
  manager.kill(asked.pane.id)
  const afterPaste = open()
  afterPaste.p.onWrite = data => {
    if (data.includes(payload)) {
      afterPaste.p.say(frame(payload) + '\x1b[30;1HPress Enter to confirm')
      afterPaste.live.meta.ask = { question: 'synthetic dialog', options: [] }
    }
  }
  const afterPasteSettled = queue(afterPaste)
  ok(await waitFor(afterPasteSettled) && pasted(afterPaste.p) && returnsOf(afterPaste.p) === 0,
    'a dialog appearing after paste withholds the first Enter')
  ok(ledger(afterPaste.pane.id).some(row => row.text === payload), 'withheld pasted text keeps its durable owner')
  manager.kill(afterPaste.pane.id)

  const repeated = open()
  repeated.received(payload) // This identical row precedes the actual paste.
  repeated.p.onWrite = data => { if (data.includes(payload)) repeated.p.say(frame(payload)) }
  const repeatedSettled = queue(repeated)
  ok(await waitFor(repeatedSettled) && returnsOf(repeated.p) > 0 && ledger(repeated.pane.id).some(row => row.text === payload),
    'an identical native row before this paste cannot acknowledge the new prompt', logOf(repeated.pane.id))
  const retainedRow = ledger(repeated.pane.id).find(row => row.text === payload)
  ok(retainedRow?.typed?.at > 0 && retainedRow.typed.conversationId === repeated.conversation,
    'an actual typed timeout persists its first paste time and original native identity')
  const beforeWake = repeated.p.writes.length
  forgetQueuedPrompts()
  manager.deliverOwed(repeated.pane.id, repeated.pane.id)
  ok(repeated.p.writes.length === beforeWake && manager.codexQueued.get(repeated.pane.id)?.key === ledger(repeated.pane.id)[0]?.key,
    'same-pane recovery replaces stale ownership with the re-keyed uncertain intent without replay')
  repeated.received(payload)
  const afterRestart = open()
  forgetQueuedPrompts()
  manager.deliverOwed(repeated.pane.id, afterRestart.pane.id)
  ok(afterRestart.p.writes.length === 0 && ledger(afterRestart.pane.id).length === 0,
    'disk reload after a real typed timeout clears its later original receipt without any restored writes')
  manager.kill(afterRestart.pane.id)
  manager.kill(repeated.pane.id)

  for (const cancel of ['\x03', '\x15', 'takeOver']) {
    const canceled = open()
    canceled.p.onWrite = data => { if (data.includes(payload)) canceled.p.say(frame(payload)) }
    const canceledSettled = queue(canceled)
    await sentReturnAt(canceled.p)
    if (cancel === 'takeOver') manager.takeOver(canceled.pane.id)
    else manager.write(canceled.pane.id, cancel, 'phone')
    canceled.p.say(frame(''))
    ok(await waitFor(canceledSettled) && ledger(canceled.pane.id).length === 0,
      `explicit ${JSON.stringify(cancel)} cancellation removes the matching durable intent`)
    canceled.live.meta.status = 'idle'
    canceled.live.meta.runSince = undefined
    canceled.live.busyUntil = 0
    // Our own Enter left a draft hold, and a cancel is not proof the box is empty: the
    // screen is. The redraw a cancel key causes falls in that key's repaint grace and
    // stamps no output, and nothing else is printed: the idle sweep reads that redraw.
    ok(await waitFor(() => !canceled.live.draftConfirmation && !canceled.live.meta.drafting, 4000),
      `the ${JSON.stringify(cancel)} redraw alone releases our own Enter's draft hold`,
      `status=${canceled.live.meta.status} hold=${JSON.stringify(canceled.live.draftConfirmation)}`)
    const next = `after explicit cancellation ${JSON.stringify(cancel)}`
    canceled.p.onWrite = data => {
      if (data.includes(next)) canceled.p.say(frame(next))
      if (data === '\r') canceled.received(next)
    }
    const nextSettled = queue(canceled, next)
    ok(await waitFor(nextSettled) && pasted(canceled.p, next) && ledger(canceled.pane.id).length === 0,
      `a subsequent queue delivers after ${JSON.stringify(cancel)} without resending canceled text`, logOf(canceled.pane.id))
    manager.kill(canceled.pane.id)
  }

  const command = open()
  command.p.onWrite = data => {
    if (data === '\r') setTimeout(() => command.p.say(frame('') + '\x1b[2;1HModel updated\x1b[5;3H'), 10)
  }
  const commandSettled = queue(command, '/model gpt-6.1-sol')
  ok(await waitFor(commandSettled) && returnsOf(command.p) === 1 && ledger(command.pane.id).length === 0,
    'a default Codex slash command uses idle command proof without a native user receipt', logOf(command.pane.id))
  manager.kill(command.pane.id)

  const swallowed = open()
  const cmd = '/model gpt-6.1-sol'
  swallowed.p.onWrite = data => { if (data === cmd) swallowed.p.say(frame(cmd)) }
  const swallowedSettled = queue(swallowed, cmd)
  ok(await waitFor(swallowedSettled) && ledger(swallowed.pane.id).some(row => row.text === cmd),
    'a held slash command retains its durable intent after swallowed returns')
  swallowed.p.say(frame(cmd) + '\x1b[20;1HUnrelated repaint')
  const afterCmd = 'blocked behind held command'
  const commandBlocked = queue(swallowed, afterCmd, 300)
  ok(await logSays(swallowed.pane.id, /queued prompt retained/) && commandBlocked() === 0 && !pasted(swallowed.p, 'blocked behind held command'),
    'unrelated output cannot release a slash command still held in the actual composer')
  swallowed.p.onWrite = data => {
    if (data === '\r') swallowed.p.say(frame('') + '\x1b[2;1HModel updated after manual Enter\x1b[5;3H')
  }
  manager.write(swallowed.pane.id, '\r', 'phone')
  swallowed.live.meta.runSince = undefined; swallowed.live.busyUntil = 0
  swallowed.p.onWrite = data => {
    if (data.includes(afterCmd)) swallowed.p.say(frame(afterCmd))
    if (data === '\r') swallowed.received(afterCmd)
  }
  ok(await waitFor(() => pasted(swallowed.p, afterCmd) && ledger(swallowed.pane.id).length === 0),
    'manual command Enter plus new output and an empty idle composer releases the retained owner once', logOf(swallowed.pane.id))
  manager.kill(swallowed.pane.id)

  for (const human of [false, true]) {
    const effort = open()
    effort.p.onWrite = data => { if (data.includes(payload)) effort.p.say(frame(payload)) }
    const effortSettled = queue(effort)
    await sentReturnAt(effort.p)
    if (human) manager.write(effort.pane.id, 'human edit without Enter', 'phone')
    effort.live.effortPassThrough = true
    manager.write(effort.pane.id, '\x1b[I', 'app')
    manager.write(effort.pane.id, '\r', 'app')
    effort.live.effortPassThrough = false
    ok(manager.codexQueued.get(effort.pane.id)?.foreign === human,
      `effort replay ${human ? 'preserves real human ownership' : 'does not create foreign ownership'}`)
    effort.received(payload)
    ok(await waitFor(effortSettled) && ledger(effort.pane.id).length === 0,
      'an exact receipt resolves effort replay without duplicating the payload')
    manager.kill(effort.pane.id)
  }

  // Exercise production disk loading and recovery, independent of the live pane claim.
  for (const receipt of ['original', 'missing', 'before', 'wrong', 'altered', 'unknown']) {
    const source = open()
    const restored = open() // Deliberately a different native conversation.
    const at = Date.now()
    const key = noteAccepted(source.pane.id, payload, root)
    ok(noteTyped(key, { at, conversationId: receipt === 'unknown' ? undefined : source.conversation, proof: 'receipt' }),
      `typed recovery marker is durable (${receipt})`)
    const nativeRow = (file, text, timestamp) => appendFileSync(file, JSON.stringify({ timestamp,
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n')
    if (receipt === 'original') nativeRow(source.file, payload, at + 1)
    if (receipt === 'before') nativeRow(source.file, payload, at - 1)
    if (receipt === 'wrong' || receipt === 'unknown') nativeRow(restored.file, payload, at + 1)
    if (receipt === 'altered') nativeRow(source.file, payload.replace(/\n/g, ''), at + 1)
    forgetQueuedPrompts()
    manager.deliverOwed(source.pane.id, restored.pane.id)
    ok(restored.p.writes.length === 0 && ledger(restored.pane.id).length === (receipt === 'original' ? 0 : 1),
      `disk recovery ${receipt === 'original' ? 'clears exact original conversation receipt without replay' : `retains uncertain ${receipt} delivery without replay`}`)
    if (receipt !== 'original') {
      const blockedRecovery = queue(restored, 'must not append after uncertain restored delivery', 300)
      ok(await logSays(restored.pane.id, /queued prompt retained/) && blockedRecovery() === 0 &&
        !pasted(restored.p, 'must not append after uncertain restored delivery') &&
        ledger(restored.pane.id).some(row => row.text === 'must not append after uncertain restored delivery' && !row.typed),
        `uncertain restored ${receipt} delivery protects subsequent queues`)
    }
    manager.kill(source.pane.id); manager.kill(restored.pane.id)
  }

  const neverTyped = open()
  const recoveredUntyped = open()
  const untypedText = 'accepted but never typed remains deliverable'
  noteAccepted(neverTyped.pane.id, untypedText, root)
  recoveredUntyped.p.onWrite = data => {
    if (data.includes(untypedText)) recoveredUntyped.p.say(frame(untypedText))
    if (data === '\r') recoveredUntyped.received(untypedText)
  }
  forgetQueuedPrompts()
  manager.deliverOwed(neverTyped.pane.id, recoveredUntyped.pane.id)
  ok(await waitFor(() => pasted(recoveredUntyped.p, untypedText) && ledger(recoveredUntyped.pane.id).length === 0),
    'accepted never-typed intent still recovers into an exact native submission')
  manager.kill(neverTyped.pane.id); manager.kill(recoveredUntyped.pane.id)
}

// A completed Codex turn keeps its notification pending until the attention gate
// runs. Its idle particle animation must not turn that notification back into work.
{
  // Turn boundaries launch asynchronous Git reads. Keep their cwd outside the
  // disposable fixture, as in the other cases, so Windows can remove it below.
  const pane = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(pane.id)
  live.proc.say(COMPOSER)
  manager.setBusyOnScreen(pane.id, true, 'Esc to interrupt · 1s')
  ok(live.meta.status === 'working' && Boolean(live.meta.runSince), 'a live footer starts working')
  manager.setBusyOnScreen(pane.id, false, COMPOSER)
  ok(live.meta.status === 'idle' && !live.meta.runSince, 'the finished footer ends the turn')
  ok(live.turnPending, 'the completion notification is still pending')
  for (let frame = 0; frame < 10; frame++) live.proc.say(`\r⠁  ⠈ ${COMPOSER}`)
  ok(live.meta.status === 'idle' && !live.meta.runSince, 'idle animation cannot resurrect a finished turn')
  ok(live.turnPending, 'idle painting preserves the completion notification')
  manager.setBusyOnScreen(pane.id, true, 'Esc to interrupt · 1s')
  live.proc.say('Working')
  ok(live.meta.status === 'working' && Boolean(live.meta.runSince), 'a subsequent real turn still starts')
  manager.kill(pane.id)
}

// A working line that has stopped moving is a leftover, not a turn. After `/clear`
// Claude Code's last bytes are its SessionEnd spinner and then silence while the fresh
// session sits ready; every post-clear resume on 2026-09-23 waited out the whole budget
// on that frame (22 of 22 at ~45s). Painted once, then quiet: typed after the stale
// window, well before the budget - and not before the window.
{
  const pane = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(pane.id)
  live.proc.say('\r\n✳ Forming… (running SessionEnd hooks… 0/2 · 0s)\r\n')
  manager.sendPrompt(pane.id, 'Continue the handoff after a clear.')
  await sleep(800)
  ok(!live.proc.writes.join('').includes('after a clear'), 'a busy line younger than the stale window still holds the prompt', JSON.stringify(live.proc.writes))
  await sleep(1400)
  ok(live.proc.writes.join('').includes('after a clear'), 'a busy line nothing has repainted for the stale window does not', JSON.stringify(live.proc.writes))
  manager.kill(pane.id)
}

// An app slash command takes no draft hold. `/clear` (autoclear writes it straight to the
// pty) hands the box back with its own answer, and a hold on it would park the resume
// queued right behind it until a sweep happened to read the box empty.
{
  const pane = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(pane.id)
  live.meta.agent = 'grok'
  live.proc.say(COMPOSER)
  manager.write(pane.id, '/clear\r', 'app')
  ok(!live.meta.drafting && !live.draftConfirmation, 'an app slash command takes no draft hold', JSON.stringify(live.draftConfirmation))
  live.meta.runSince = undefined
  live.busyUntil = 0
  live.proc.say(COMPOSER)
  manager.queuePrompt(pane.id, 'Continue the handoff after the clear.', 0, 40, undefined, 5000)
  const until = Date.now() + 3000
  while (!live.proc.writes.join('').includes('after the clear') && Date.now() < until) await sleep(40)
  ok(live.proc.writes.join('').includes('after the clear'), 'and the resume queued behind it goes in', logOf(pane.id))
  manager.kill(pane.id)
}

// Enter can be swallowed while the CLI boots. A pending draft must outlive that
// attempt and keep every automatic-close path blocked until the screen is empty.
// A prompt this app typed is no different: once its returns are given up as swallowed
// its owed flag drops, and the hold is all that keeps a closer off the box. Grok only: a
// Codex prompt keeps its composer owner and a typed Claude prompt its transcript-receipt
// row, and so their owed flag, as well (lane h, 51801fd2).
for (const [agent, origin] of [['codex', 'desk'], ['claude', 'desk'], ['grok', 'desk'], ['claude', 'app'], ['grok', 'app']]) {
  const pane = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(pane.id)
  live.meta.agent = agent
  const frame = (text) => `\x1b[2J\x1b[H${'─'.repeat(60)}\r\n❯ ${text}\r\n${'─'.repeat(60)}\r\n\x1b[2;${3 + text.length}H`
  // Through the pty's own data path, so the reader sees every paint the app counts -
  // the cancel key's redraw below lands in its repaint grace.
  const paint = (text) => live.proc.say(text)
  if (origin === 'desk') {
    manager.write(pane.id, 'Keep this unsent prompt safe', 'desk')
    manager.write(pane.id, '\r', 'desk')
    ok(live.meta.drafting === true, `${agent}: Enter alone keeps the draft hold`)
  } else {
    // The CLI draws the typed prompt in its box and then eats every return.
    live.proc.onWrite = (data) => { if (data.includes('Keep this unsent prompt safe')) live.proc.say(frame('Keep this unsent prompt safe')) }
    live.proc.say(frame(''))
    let settled = 0
    manager.queuePrompt(pane.id, 'Keep this unsent prompt safe', 0, 40, () => settled++, 5000)
    const until = Date.now() + 6000
    while (!settled && Date.now() < until) await sleep(40)
    const owedAsExpected = agent === 'claude' ? live.meta.owedPrompt === true : !live.meta.owedPrompt
    ok(settled === 1 && await logSays(pane.id, /returns were swallowed/) && owedAsExpected && live.meta.drafting === true,
      `${agent} (app): a queued prompt whose returns were swallowed keeps the draft hold`,
      `settled=${settled} owed=${live.meta.owedPrompt} drafting=${live.meta.drafting}\n${logOf(pane.id)}`)
    live.proc.onWrite = undefined
  }
  const name = origin === 'app' ? `${agent} (app)` : agent
  paint(frame('Keep this unsent prompt safe'))
  await manager.confirmDraft(live)
  live.meta.status = 'idle'
  live.meta.runSince = undefined
  live.busyUntil = 0
  ok(!manager.closeAfterResult(pane.id, Date.now()).closed, `${name}: swallowed Enter refuses Review close`)
  paint('\x1b[2J\x1b[HStarting agent...')
  await manager.confirmDraft(live)
  ok(live.meta.drafting === true, `${name}: unreadable startup frame preserves draft`)
  paint(frame(''))
  const reading = manager.confirmDraft(live)
  manager.write(pane.id, 'A newer draft', 'desk')
  await reading
  ok(live.meta.drafting === true, `${name}: stale empty reading cannot clear newer input`)
  manager.write(pane.id, '\x15', 'desk')
  paint(frame(''))
  await manager.confirmDraft(live)
  ok(!live.meta.drafting, `${name}: confirmed empty composer releases the hold`)
  manager.kill(pane.id)
}

// A CANCEL KEY'S REDRAW IS THE ONLY PROOF AN IDLE BOX GIVES. Ctrl-U and Ctrl-C are not
// typing, so `write` gives them a repaint grace and the CLI's box-emptying redraw lands
// inside it, stamping no output. An idle Claude/Codex composer prints nothing more on its
// own, and the idle sweep had already read the box at that output with the prompt still
// in it - so the hold, and `drafting`, stayed until the agent next printed, and a queued
// follow-up waited behind a "person" for its whole 45 min. Driven through the pty's own
// data path and the real 1s idle sweep: nothing here pokes the grace or the reader. The
// bound is 4s from the redraw: one 1s sweep tick after the box has been quiet for a second
// is 2s at most, and the PC's loaded pool runs timers 300-650ms late.
{
  const frame = (text) => `\x1b[2J\x1b[H${'─'.repeat(60)}\r\n❯ ${text}\r\n${'─'.repeat(60)}\r\n\x1b[2;${3 + text.length}H`
  const stuck = 'Keep this prompt until the box is proven empty'
  const typedIn = (live, text) => live.proc.writes.join('').includes(text)
  const run = async (agent, origin, key, endBy = 'manual') => {
    const name = `${agent} (${origin}${endBy === 'footer' ? ', turn ended by footer read' : ''}) ${key === '\x15' ? 'Ctrl-U' : 'Ctrl-C'}`
    const pane = manager.start({ cwd: root, agent: 'shell' })
    const live = manager.sessions.get(pane.id)
    live.meta.agent = agent
    live.proc.say(frame(''))
    if (origin === 'desk') {
      // A person's own prompt, its Enter swallowed: the CLI still draws it in the box.
      manager.write(pane.id, stuck, 'desk')
      manager.write(pane.id, '\r', 'desk')
      live.proc.say(frame(stuck))
    } else {
      // This app's prompt, every return eaten.
      live.proc.onWrite = (data) => { if (data.includes(stuck)) live.proc.say(frame(stuck)) }
      let settled = 0
      manager.queuePrompt(pane.id, stuck, 0, 40, () => settled++, 5000)
      const until = Date.now() + 6000
      while (!settled && Date.now() < until) await sleep(40)
      live.proc.onWrite = undefined
    }
    // The swallowed Enter's turn clock ends the way the app ends it: the renderer reads
    // the footer as not busy (`setBusyOnScreen`). The manual cases set the same fields.
    // Read right around the call: on the Mac the 1s idle sweep ends a shell pane's run by
    // itself, so a check after the sleep below passes whether or not this path works.
    let footerEnded = true
    if (endBy === 'footer') {
      const ran = Boolean(live.meta.runSince)
      manager.setBusyOnScreen(pane.id, false, frame(stuck))
      footerEnded = ran && !live.meta.runSince && live.meta.status === 'idle'
    } else {
      live.meta.status = 'idle'
      live.meta.runSince = undefined
      live.busyUntil = 0
    }
    // The idle sweep reads the box, prompt still in it, once the pane has been quiet 1s.
    await sleep(2300)
    const heldBefore = live.meta.drafting === true && Boolean(live.draftConfirmation) &&
      live.meta.status === 'idle' && !live.meta.runSince
    // Codex: a person's cancel key also cancels a waiting queued prompt of ours (by
    // design), so its follow-up is queued after the release instead.
    const next = `follow-up after ${name}`
    const queueNext = () => {
      live.proc.onWrite = (data) => { if (data.includes(next)) live.proc.say(frame(next)) }
      manager.queuePrompt(pane.id, next, 0, 40, undefined, 5000)
    }
    let waited = true
    if (agent !== 'codex') {
      queueNext()
      await sleep(300)
      waited = !typedIn(live, next)
    }
    const hold = live.draftConfirmation
    manager.write(pane.id, key, 'desk')
    live.proc.say(frame('')) // the CLI's box-emptying redraw, inside that key's grace
    const at = Date.now()
    while (live.draftConfirmation === hold && Date.now() - at < 4000) await sleep(20)
    const ms = Date.now() - at
    // The follow-up may already be in, with its own Enter's hold: it is only typed once
    // nothing is drafting, so that is the same proof.
    const cleared = live.draftConfirmation !== hold && (!live.meta.drafting || typedIn(live, next))
    ok(heldBefore && waited && cleared && footerEnded, `${name}: the box-emptying redraw alone releases the hold within 4s`,
      `status=${live.meta.status} runSince=${live.meta.runSince} held=${heldBefore} footerEnded=${footerEnded} waited=${waited} cleared=${cleared} after ${ms}ms, drafting=${live.meta.drafting} hold=${JSON.stringify(live.draftConfirmation)}`)
    if (agent === 'codex') queueNext()
    const until = Date.now() + 2000
    while (!typedIn(live, next) && Date.now() < until) await sleep(40)
    ok(typedIn(live, next), `${name}: and a queued follow-up then goes in`, logOf(pane.id))
    manager.kill(pane.id)
  }
  await Promise.all([
    run('claude', 'desk', '\x15'), run('codex', 'desk', '\x15'), run('claude', 'app', '\x15'),
    run('claude', 'desk', '\x15', 'footer'),
    run('grok', 'app', '\x15'), run('claude', 'desk', '\x03'), run('claude', 'app', '\x03')
  ])
}

manager.killAll?.()
rmSync(work, { recursive: true, force: true })
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
