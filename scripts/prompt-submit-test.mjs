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

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mock } from 'node:test'

// The ceiling on waiting for a start-up hook, short so the "never ends" case runs in seconds.
// Windows reads hooks with PowerShell, one reading a second at best and 1-3s each under the PC's
// suite load, and "over" takes two quiet readings after the hook ends: a 4s hook then confirmed
// at about +7.4s of process age, so a 6s ceiling dropped the watch first and "over" never came
// (PC job 6a65805a, 2026-10-04; same on the Mac with readings 1.8s apart). The "never ends"
// case runs only off Windows.
process.env.PF_PROMPT_HOOKS_MAX_MS ??= process.platform === 'win32' ? '30000' : '6000'
import { monitorEventLoopDelay } from 'node:perf_hooks'
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
process.env.PF_PROMPT_PIDFILE_MS ??= '1200'
process.env.PF_CLAUDE_SETTLE_MS ??= '200'
// The process-tree reading of the hooks (`hookState`): quiet after the last hook, and how
// often the shared `ps` may run.
process.env.PF_CLAUDE_HOOKS_QUIET_MS ??= '150'
process.env.PF_CLAUDE_HOOKS_PS_MS ??= '50'

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
  stdin: { contents: `export { SessionManager } from './src/main/sessions'; export { forgetQueuedPrompts, noteAccepted, noteTyped } from './src/main/queuedPrompts'; export { claudeAcceptedPrompt, claudeStartup } from './src/main/transcripts'`, resolveDir: root },
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
const { SessionManager, claudeAcceptedPrompt, claudeStartup, forgetQueuedPrompts, noteAccepted, noteTyped } = req('./sessions.bundle.cjs')

// Every wait the app makes here is cut to 120-200ms so the file runs in a minute and a half,
// which makes this process's own event loop part of every check: measured on the PC 28 Sep-
// 2 Oct, red in 4% of full runs with at most two other jobs on the machine and 33-43% with
// three or more, a different check nearly every time. A red run therefore says how late its
// loop got, so a starved machine reads differently from a broken app.
const loopLag = monitorEventLoopDelay({ resolution: 20 })
loopLag.enable()
process.on('exit', (code) => {
  if (!code) return
  const ms = (ns) => Math.round(ns / 1e6)
  console.log(`event loop: worst stall ${ms(loopLag.max)}ms, p99 ${ms(loopLag.percentile(99))}ms ` +
    `(the app's waits in this file are 120-200ms; a stall past them can fail a check the app passed)`)
})

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
// (`still starting - typing anyway after 1.2s`, short wait or ceiling); -1 when it never said.
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

// Every close below says `'user'`: a test closing a pane is a person. A close with no
// `by` is refused while the pane is `working` (`closeRefused`), and a pane left open
// pollutes the cases after it - on the slow PC that was ~15 FAILs and a throw.
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
  manager.kill(followup.id, 'user')
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
  manager.kill(typedInto.id, 'user')
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
manager.kill(cmd.id, 'user')

// ...and a QUIET composer that printed NOTHING is a swallowed return, not a landed command.
// 2026-09-07, pane s2-mtqmyvnv: `/clear` restarted the CLI, the `/model opus` return went in
// during a gap in the boot paint and was eaten, and the confirm settled 1.2s later as
// "command landed". The 721-character resume prompt was then typed onto a composer still
// holding `/model opus`, and Claude Code read the pair as one slash command:
// `Model 'opus\n\nContinue the handoff...' not found`. The clear happened, the handover did
// not. So the proof is the command's ANSWER, not the silence around it.
// Answers the moment the return this queuePrompt sends was written, so a case can be
// judged against the confirm window rather than against a wall-clock sleep.
// 10s, not 3s: on a shared PC (2026-10-01, returns 1.4s apart for a planned 0.2s) a 3s
// wait threw, and the throw ends the FILE - every case after it never runs. Master's 6s
// (PC full-suite pool stalled past 3s, 2026-10-02) is the same failure; the longer wait covers both.
async function sentReturnAt(proc, waitMs = 10_000) {
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
// nothing printed. The old code settled on that silence within one poll and wrote
// `command landed`; the right answer waits the confirm window out and writes `return
// swallowed`. So the check reads WHICH WAY the app went, off its own log, and no clock.
// The clock it had (three polls after the return, under PROMPT_CONFIRM_MS x
// PROMPT_ENTER_TRIES) measured the machine: promptsubmit's most frequent red on the PC
// (10 of 72 red runs, 28 Sep-2 Oct), and reproduced on the Mac with the event loop blocked
// 700ms a second - "813ms after the return, budget 600ms" while the app had settled nothing
// and logged nothing wrong (2026-10-03).
await sentReturnAt(eatenProc)
const confirmBudget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
const eatenVerdict = await logSays(eaten.id, /return swallowed/, 10_000)
const beforeVerdict = logOf(eaten.id).split(/return swallowed/)[0]
ok(
  eatenVerdict && !/landed|submitted/.test(beforeVerdict),
  'a command that printed nothing has not landed',
  `settles=${eatenDone}\n${logOf(eaten.id)}`
)
ok(
  eatenProc.writes.some((w) => w === '\r'),
  'and the return really was sent, so the silence is the pane\'s answer and not a missing keystroke',
  JSON.stringify(eatenProc.writes)
)
manager.kill(eaten.id, 'user')

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
  manager.kill(answering.id, 'user')
}

// A Codex startup repaint can clear the visible composer without accepting a turn.
// No native user row means no successful delivery, even with a fresh run clock.
{
  const pane = manager.start({ cwd: root, agent: 'shell' })
  const live = manager.sessions.get(pane.id)
  const proc = live.proc
  manager.queuePrompt(pane.id, 'Native receipt required for this startup fixture', 0, 40, () => {}, 5000)
  await sleep(120)
  proc.say(COMPOSER)
  await sentReturnAt(proc)
  live.meta.agent = 'codex'
  live.meta.runSince = Date.now() + 1
  const until = Date.now() + Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES) + 400
  while (Date.now() < until) { proc.say(ANSWERING); await sleep(50) }
  ok(await logSays(pane.id, /UNSENT/), 'Codex startup paint without a native row remains unverified', logOf(pane.id))
  ok(!/prompt submitted/.test(logOf(pane.id)), 'neither a startup clock nor an empty composer proves Codex delivery', logOf(pane.id))
  manager.kill(pane.id, 'user')
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
  manager.kill(stuck.id, 'user')
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
  // This desk runs a SessionStart hook, so hooks not seen yet are still to come (`hooksAwaited`).
  const deskHooks = (on) => writeFileSync(join(home, 'settings.json'), JSON.stringify(on
    ? { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } }
    : { hooks: {} }))
  deskHooks(true)
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
  const open = (pid, firstLookMs = 40) => {
    const t0 = Date.now()
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    if (pid) p.pid = pid
    manager.queuePrompt(pane.id, BRIEF, 0, firstLookMs, undefined, 5000)
    p.say(IDLE)
    return { pane, p, t0, at: Date.now() }
  }

  // THE USAGE-LIMIT MENU. Claude Code's "What do you want to do?" selector (option 3 spends
  // credits) is an open selector, not a composer: a paste into it can pick an option. The
  // prompt stays out of it, and pf tell says `queued` with the reason in about 2 s, not 40.
  // No SessionStart hook is declared for these panes: this case is about the menu, not the
  // start-up wait.
  deskHooks(false)
  for (const via of ['screen', 'meta']) {
    const name = `sess-limit-menu-${via}`
    cli(name)
    hooksDone(name, 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(pane.id)
    const MENU = '\x1b[2J\x1b[H What do you want to do?\r\n❯ 1. Stop and wait for limit to reset\r\n  2. Upgrade your plan\r\n  3. Switch to usage credits\r\n\r\nEnter to confirm · Esc to cancel\r\n'
    live.proc.say(via === 'screen' ? MENU : IDLE)
    if (via === 'meta') live.meta.ask = { question: 'What do you want to do?', options: [{ n: 1, label: 'Stop and wait for limit to reset' }, { n: 3, label: 'Switch to usage credits' }] }
    await sleep(700)
    const t0 = Date.now()
    const outcome = await manager.tellPane(pane.id, 'continue the work', 20_000)
    const took = Date.now() - t0
    ok(outcome?.kind === 'queued' && /a question or a setting is open/.test(outcome.reason) && took < 3500,
      `tell: a limit menu open (${via}) answers queued with the question words within ~3 s`, `${JSON.stringify(outcome)} after ${took}ms`)
    await sleep(300)
    ok(!live.proc.writes.some((w) => w.includes('\x1b[200~')),
      `tell: nothing is pasted into the open limit menu (${via})`, JSON.stringify(live.proc.writes))
    manager.kill(pane.id, 'user')
  }
  deskHooks(true)

  // s113: the pid file is there, the hooks are not done. The composer is idle the whole time.
  // The hold ends at PF_PROMPT_STARTUP_MS of process age, by design. PC job 0f0f73e5 spent
  // 6.6s between minting the pane id and returning from open(), so the first look found a
  // process past that ceiling and typed at once - the ceiling working, not a missed hold.
  // A pane typed only once PF_PROMPT_STARTUP_MS had passed since open() began is judged
  // again on one fresh pane; a second such stall fails the case.
  cli('sess-running')
  hooksPending('sess-running')
  let a, early
  for (let attempt = 1; ; attempt++) {
    a = open()
    early = await typedAt(a.p, 900)
    if (!early || early - a.t0 < Number(process.env.PF_PROMPT_STARTUP_MS) || attempt === 2) break
    console.log(`note  opening the pane took ${a.at - a.t0}ms, past the ${process.env.PF_PROMPT_STARTUP_MS}ms hold; judged on a fresh pane`)
    manager.kill(a.pane.id, 'user')
  }
  ok(!early, 'a prompt is not typed while Claude Code is still running its SessionStart hooks',
    `typed ${early ? early - a.at : '-'}ms in\n${logOf(a.pane.id)}`)
  hooksDone('sess-running')
  const late = await typedAt(a.p, 1000)
  ok(late > 0, 'and it is typed once the SessionStart record is in the transcript and it has gone quiet', logOf(a.pane.id))
  ok(typings(a.p) === 1, 'exactly once')
  ok(await logSays(a.pane.id, /finished starting/), 'the wait and its end are written down', logOf(a.pane.id))
  manager.kill(a.pane.id, 'user')

  // A CLI whose start is long over (the record written, the file quiet): nothing to wait for.
  cli('sess-done')
  const b = open()
  hooksDone('sess-done', 60_000)
  const bAt = await typedAt(b.p, 1200)
  // Not held is what the app logged, as for the shell pane below: a stopwatch here is the
  // PC pool's timer lag, not the gate.
  ok(
    bAt > 0 && (await logSays(b.pane.id, /prompt typed/)) && !/waiting for Claude Code to finish starting/.test(logOf(b.pane.id)),
    'a CLI that has finished starting is typed into at once',
    `${bAt ? bAt - b.at : '-'}ms\n${logOf(b.pane.id)}`
  )
  manager.kill(b.pane.id, 'user')

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
  manager.kill(c.pane.id, 'user')

  // NO TRANSCRIPT ON DISK IS NOT "STILL STARTING". Claude Code 2.1.283 often writes none
  // until the first prompt is in: panes s2, s15, s20, s26 and s27 (2026-09-26/27) had their
  // hooks done at +2-11s and their launch prompts held the whole minute, the file born only
  // at +62-67s after the app typed anyway. The pid file alone gets the short wait.
  deskHooks(false)
  cli('sess-deferred')
  const f = open()
  // The short wait is 1200ms and the ceiling 3000, both counted from the spawn. Which one it
  // was is the age the app logged, not a stopwatch started after `open()` returned: on the
  // PC the spawn itself took 300-500ms, so the prompt went in 488ms after `f.at` having
  // waited the full 800 (2026-09-28, 2 of 3 runs red with a 600ms floor).
  const fAt = await typedAt(f.p, 2500)
  const fWaited = await shortWaitOf(f.pane.id)
  ok(fAt > 0 && fWaited >= 0.8 && fWaited < 2.4,
    'a pid file whose transcript is not on disk yet costs only the short wait, not the ceiling',
    `${fWaited}s waited\n${logOf(f.pane.id)}`)
  ok(await logSays(f.pane.id, /no pid file or transcript yet/), 'and the log says what it was waiting for', logOf(f.pane.id))
  manager.kill(f.pane.id, 'user')

  // No pid file and nothing on disk, on a desk with no SessionStart hooks: the short wait from
  // the spawn, as before - nothing would ever say more.
  rmSync(pidFile, { force: true })
  const g = open()
  await typedAt(g.p, 2500)
  const gWaited = await shortWaitOf(g.pane.id)
  ok(gWaited >= 0.8 && gWaited < 2.4, 'a desk with no SessionStart hooks keeps the short wait', `${gWaited}s\n${logOf(g.pane.id)}`)
  manager.kill(g.pane.id, 'user')
  deskHooks(true)

  // HOOKS NOT STARTED YET ARE STILL TO COME. At load average 50-137 (2026-10-02, 5 at once)
  // a fresh CLI's first hook started at +11-25s; typed at the 10s short wait, 14 of 15 were
  // left UNSENT and 4 never answered. On a desk that runs SessionStart hooks, no pid file yet
  // holds past the short wait, and once it is there the short wait counts from it.
  if (process.platform !== 'win32') {
    const h = open()
    const hEarly = await typedAt(h.p, 1500)
    ok(!hEarly, 'no pid file yet, on a desk whose hooks will run, holds past the short wait', logOf(h.pane.id))
    ok(await logSays(h.pane.id, /hooks have not started yet/), 'and the log says it is waiting for them to start', logOf(h.pane.id))
    cli('sess-late-pid')
    const hPid = Date.now()
    const hAt = await typedAt(h.p, 2500)
    ok(hAt > 0 && hAt - hPid >= 1000, 'a pid file with no hook seen gets the short wait from when it appeared, then the prompt goes in',
      `${hAt ? hAt - hPid : '-'}ms after the pid file\n${logOf(h.pane.id)}`)
    ok(typings(h.p) === 1, 'once')
    manager.kill(h.pane.id, 'user')
  }

  // A RESUMED TRANSCRIPT HOLDS EVERY EARLIER START'S RECORDS. s41-mupyt5ez (2026-10-01,
  // `--resume` at memory pressure 2) was typed at +4.6s off an old SessionStart record while
  // the CLI still took in an old task notification. Only a record stamped since the spawn
  // counts; the old file alone says nothing.
  const resumedFile = join(proj, 'sess-resumed.jsonl')
  const longAgo = new Date(Date.now() - 3_600_000)
  writeFileSync(resumedFile, JSON.stringify({ type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup' }, timestamp: longAgo.toISOString() }) + '\n')
  utimesSync(resumedFile, longAgo, longAgo)
  cli('sess-resumed')
  const rPane = manager.start({ cwd: root, agent: 'claude', resume: true, resumeId: 'sess-resumed' })
  const rp = manager.sessions.get(rPane.id).proc
  manager.queuePrompt(rPane.id, BRIEF, 0, 40, undefined, 5000)
  rp.say(IDLE)
  const rEarly = await typedAt(rp, 300)
  ok(!rEarly, 'an old SessionStart record in a resumed transcript does not open the gate', logOf(rPane.id))
  appendFileSync(resumedFile, JSON.stringify({ type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'SessionStart:resume' }, timestamp: new Date().toISOString() }) + '\n')
  utimesSync(resumedFile, longAgo, longAgo)
  const rAt = await typedAt(rp, 1500)
  ok(rAt > 0 && !/typing anyway/.test(logOf(rPane.id)), 'this start\'s own record does', logOf(rPane.id))
  ok(typings(rp) === 1, 'once')
  manager.kill(rPane.id, 'user')
  // The cases below expect the pid file the deferred case left: no transcript behind it.
  cli('sess-deferred')

  // THE HOOKS ARE OVER WHEN THE PROCESS TREE SAYS SO. With no transcript to read, every fresh
  // pane waited the whole short wait: 67 of 72 opened 2026-10-01/02 typed at +10.0-10.2s with
  // their hooks done at +2-5s. Claude Code runs each hook in a process group of its own and
  // its MCP servers in the CLI's group (2.1.287, measured), so this fake CLI is a real process
  // with one of each: the prompt goes in once the detached child has ended, before the short
  // wait - and a hook that outlives the short wait does not lengthen it. Windows has no
  // process groups: there the short wait is the answer, as the case above pins.
  if (process.platform !== 'win32') {
    // A real process standing in for Claude Code: an MCP-like child in its group, detached
    // `hooks` ({at, ms} after it is up), and its pid file written `pidFileAt` ms in. `sleep`,
    // not node, so a hook lives its `ms` and not a node boot more.
    const fakeCli = async (sessionId, { hooks, pidFileAt = 0 }) => {
      const plan = JSON.stringify({ hooks, pidFileAt, dir: join(home, 'sessions'), sessionId, cwd: root })
      const proc = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process')
        const { writeFileSync } = require('node:fs')
        const plan = JSON.parse(process.env.FAKE_CLI)
        const t0 = Date.now()
        const kids = [spawn('sleep', ['8'], { stdio: 'ignore' })]
        console.log('up')
        setTimeout(() => writeFileSync(plan.dir + '/' + process.pid + '.json',
          JSON.stringify({ pid: process.pid, sessionId: plan.sessionId, cwd: plan.cwd, startedAt: t0, status: 'idle' })), plan.pidFileAt)
        plan.hooks.forEach(({ at, ms }, i) => setTimeout(() => {
          const hook = spawn('sleep', [String(ms / 1000)], { detached: true, stdio: 'ignore' })
          kids.push(hook)
          hook.on('exit', () => console.log('hook-ended ' + i + ' ' + Date.now()))
        }, at))
        process.on('SIGTERM', () => { for (const k of kids) { try { k.kill() } catch {} } process.exit() })
        setTimeout(() => {}, 8000)`], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, FAKE_CLI: plan } })
      let out = ''
      proc.stdout.on('data', (d) => (out += d))
      const ended = (i) => Number(new RegExp(`hook-ended ${i} (\\d+)`).exec(out)?.[1] ?? 0)
      const until = Date.now() + 5000
      while (!out.includes('up') && Date.now() < until) await sleep(5)
      return { proc, ended }
    }
    // Opens a pane on a fake CLI and waits for its prompt: typed when, and after which hook.
    const run = async (sessionId, plan, firstLookMs = 40, waitMs = 4500) => {
      const cli = await fakeCli(sessionId, plan)
      const pane = open(cli.proc.pid, firstLookMs)
      const typed = await typedAt(pane.p, waitMs)
      await sleep(50)
      return { ...pane, cli, typed, after: (i) => typed > 0 && cli.ended(i) > 0 && typed >= cli.ended(i),
        why: (i) => `typed ${typed ? typed - pane.at : '-'}ms in, hook ${i} ended ${cli.ended(i) ? cli.ended(i) - pane.at : '-'}ms in\n${logOf(pane.pane.id)}`,
        done: () => { manager.kill(pane.pane.id, 'user'); cli.proc.kill() } }
    }

    const t = await run('sess-tree', { hooks: [{ at: 0, ms: 350 }] })
    ok(t.after(0), 'a fresh CLI with no transcript is typed into once its hooks have ended, not while one runs', t.why(0))
    ok((await logSays(t.pane.id, /finished starting/)) && !/typing anyway/.test(logOf(t.pane.id)),
      'and that is the hooks ending, not the short wait running out', logOf(t.pane.id))
    ok(typings(t.p) === 1, 'typed exactly once', String(typings(t.p)))
    t.done()

    // The first look at a fresh pane comes 2.5s in and an idle desk's hooks are over by +2.2s:
    // read from the moment the prompt is queued, or a watch begun at that look sees no hook
    // and the pane waits the whole short wait (dev copy 2026-10-02: 10.1s, hooks over +2.2s).
    const e = await run('sess-tree-early', { hooks: [{ at: 0, ms: 350 }] }, 900)
    ok(e.after(0) && !/waiting for Claude Code|typing anyway/.test(logOf(e.pane.id)),
      'hooks over before the first look open the gate at that look, not at the short wait', e.why(0))
    e.done()

    // Nothing running yet is not "the hooks are over": one has to be seen first.
    const late = await run('sess-tree-late', { hooks: [{ at: 400, ms: 300 }] })
    ok(late.after(0), 'a hook that starts after the pid file is still waited for', late.why(0))
    late.done()

    // The quiet has to last: a gap between two hooks shorter than it is not the end.
    const gap = await run('sess-tree-gap', { hooks: [{ at: 0, ms: 350 }, { at: 400, ms: 350 }] })
    ok(gap.after(1), 'a short gap between two hooks does not open the gate', gap.why(1))
    gap.done()

    // Before its pid file the CLI runs short children of its own (a shell snapshot); a quiet
    // spell after one of those is not its hooks being over.
    const snap = await run('sess-tree-snap', { hooks: [{ at: 0, ms: 120 }, { at: 500, ms: 300 }], pidFileAt: 500 })
    ok(snap.after(1), 'a child that ended before the pid file does not count as the hooks', snap.why(1))
    snap.done()

    // A hook seen still running at the short wait is a reading, not a guess: held until it
    // ends. s38-mupyep73 (2026-10-01, a resume at memory pressure 2) was typed at the 10.1s
    // short wait with its hooks running until +33s, and the prompt was lost.
    const long = await run('sess-tree-long', { hooks: [{ at: 0, ms: 2000 }] })
    const uWaited = Number(/finished starting after ([\d.]+)s/.exec(logOf(long.pane.id))?.[1] ?? -1)
    ok(long.after(0) && uWaited > 1.2,
      'a hook still running at the short wait holds the prompt until it ends', `${uWaited}s waited\n${long.why(0)}`)
    long.done()

    // ...and an UNDECLARED child in a group of its own (the status line, a plugin's hook) holds it
    // only to the start-up wait, as before the hooks ceiling existed: typed at about
    // PF_PROMPT_STARTUP_MS, not held to PF_PROMPT_HOOKS_MAX_MS (6s here) while it runs.
    const stuck = await run('sess-tree-stuck', { hooks: [{ at: 0, ms: 7800 }] }, 40, 9000)
    const sWaited = await shortWaitOf(stuck.pane.id)
    const startupS = Number(process.env.PF_PROMPT_STARTUP_MS) / 1000
    ok(stuck.typed > 0 && sWaited >= startupS - 0.1 && sWaited < startupS + 1.5 && !stuck.cli.ended(0) && /typing anyway/.test(logOf(stuck.pane.id)),
      'a group-only hook that never ends holds it only to the start-up wait, not the hooks ceiling', `${sWaited}s waited (start-up wait ${startupS}s)\n${logOf(stuck.pane.id)}`)
    stuck.done()

    // A hook DECLARED in settings.json and seen by the same reading holds past the start-up wait
    // (sleep 3.6 against a 3s wait here), until it ends, and never past the ceiling.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sleep 3.6' }] }] } }))
    const decl = await run('sess-tree-declared', { hooks: [{ at: 200, ms: 3600 }] }, 40, 9000)
    ok(decl.after(0) && decl.typed - decl.at > Number(process.env.PF_PROMPT_STARTUP_MS) && /finished starting/.test(logOf(decl.pane.id)),
      'a declared hook seen in the process tree holds the prompt past the start-up wait until it ends', decl.why(0))
    decl.done()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sleep 7.8' }] }] } }))
    const declStuck = await run('sess-tree-declared-stuck', { hooks: [{ at: 0, ms: 7800 }] }, 40, 9000)
    const dsWaited = await shortWaitOf(declStuck.pane.id)
    ok(declStuck.typed > 0 && dsWaited >= 5.5 && !declStuck.cli.ended(0), 'and a declared hook that never ends holds it only to the hooks ceiling', `${dsWaited}s waited\n${logOf(declStuck.pane.id)}`)
    declStuck.done()
    deskHooks(true)

    // Five at once, as a desk opens them: one shared reading, each pane its own answer.
    const five = await Promise.all([0, 1, 2, 3, 4].map((i) => run(`sess-tree-five-${i}`, { hooks: [{ at: 0, ms: 300 + i * 60 }] })))
    ok(five.every((f) => f.after(0)), 'five opened at once are each typed into after their own hooks', five.map((f) => f.why(0)).join('\n'))
    ok(five.every((f) => typings(f.p) === 1), 'and each exactly once', five.map((f) => typings(f.p)).join(' '))
    for (const f of five) f.done()
  }

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
    manager.kill(g.pane.id, 'user')
    const cmd = manager.start({ cwd: root, agent: 'claude' })
    const cp = manager.sessions.get(cmd.id).proc
    manager.queuePrompt(cmd.id, '/model opus', 0, 40, undefined, 5000, 'idle')
    cp.say(IDLE)
    for (const until = Date.now() + 1500; Date.now() < until && !cp.writes.length; ) await sleep(20)
    ok(cp.writes[0] === '/model opus', 'a slash command is typed, not pasted', JSON.stringify(cp.writes[0]))
    manager.kill(cmd.id, 'user')
    const sh = manager.start({ cwd: root, agent: 'shell' })
    const shp = manager.sessions.get(sh.id).proc
    manager.queuePrompt(sh.id, BRIEF, 0, 40, undefined, 5000)
    shp.say(IDLE)
    await typedAt(shp, 1500)
    ok(shp.writes.find((x) => x.includes('RESEARCH QUESTION')) === BRIEF, 'a shell pane gets the text as it was', JSON.stringify(shp.writes))
    manager.kill(sh.id, 'user')
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
    manager.kill(cx.id, 'user')
  }

  // No pid file at all (a CLI that writes none, so no sessions folder): the short wait, then
  // as before - the hooks it runs are not awaited, or every prompt would sit the ceiling.
  rmSync(join(home, 'sessions'), { recursive: true, force: true })
  const d = open()
  const dAt = await typedAt(d.p, 2500)
  const dWaited = await shortWaitOf(d.pane.id)
  ok(dAt > 0 && dWaited >= 0.8 && dWaited < 2.4, 'a CLI with no pid file costs only the short wait', `${dWaited}s waited\n${logOf(d.pane.id)}`)
  manager.kill(d.pane.id, 'user')
  mkdirSync(join(home, 'sessions'), { recursive: true })

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
  manager.kill(e.pane.id, 'user')

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
  manager.kill(shell.id, 'user')

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
    manager.kill(pane.id, 'user')
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
    // The ledger line is appended apart from the app log line: wait for it too (2026-10-01,
    // a pressured Mac read the ledger with only `accepted` in it).
    const qpRead = () => { try { return readFileSync(join(work, 'userData', 'queued-prompts.log'), 'utf8').split('\n').filter((l) => l.includes(pane.id)).join('\n') } catch { return '' } }
    for (const end = Date.now() + 2000; Date.now() < end && !/queued prompt submitted|LOST/.test(qpRead()); ) await sleep(40)
    const qpLog = qpRead()
    ok(!/UNSENT/.test(logOf(pane.id)) && /Claude transcript receipt/.test(logOf(pane.id)),
      'a prompt Claude wrote down is submitted even when the pane is typed into afterwards', logOf(pane.id))
    ok(!/LOST/.test(qpLog) && /queued prompt submitted/.test(qpLog), 'and queued-prompts.log says submitted, not LOST', qpLog)
    ok(settles === 1, 'it settles once', String(settles))
    manager.kill(pane.id, 'user')
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
    manager.kill(pane.id, 'user')
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
    manager.kill(pane.id, 'user')
  }

  // "SUBMITTED" WITH NO USER ROW. 2026-10-01 08:14:53Z, pane s54-mup9d0za: a 4958-char brief
  // sat in the composer as `[Pasted text #1 +30 lines]` while the log said "it is no longer in
  // the composer" - the composer was read for the brief's words, which a placeholder does not
  // have - and Claude Code's transcript got it 2m47s later, when Robert pressed Enter. The pane
  // paints over the whole window, so only the final reading decides.
  const LONG = Array.from({ length: 30 }, (_, i) => `${i + 1}. BRIEF LINE ${i + 1}: carry this step out and prove it.`).join('\n')
  const unproven = async (name, composer) => {
    cli(name)
    hooksDone(name, 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, LONG, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    const frame = '\x1b[2J\x1b[H✻ Working… (3s · esc to interrupt)\r\n' + RULE + '\r\n' + composer + '\r\n' + RULE + '\r\n'
    for (const until = Date.now() + budget + 800; Date.now() < until && !settles; ) {
      p.say(frame)
      await sleep(50)
    }
    await logSays(pane.id, /prompt submitted|UNSENT/)
    manager.kill(pane.id, 'user')
    return { log: logOf(pane.id), settles }
  }
  const held = await unproven('sess-paste-held', '❯ [Pasted text #1 +30 lines]')
  ok(!/prompt submitted/.test(held.log) && /UNSENT/.test(held.log),
    'a paste placeholder still in the composer is UNSENT, never "submitted"', held.log)
  const gone = await unproven('sess-paste-gone', '❯ ')
  ok(!/prompt submitted/.test(gone.log) && /UNSENT: .*no record of it/.test(gone.log),
    'an empty composer with no user row in the transcript is UNSENT too, when the transcript can be read', gone.log)

  // A RETURN TAKEN WHILE CLAUDE CODE STARTS IS HELD, NOT LOST. 2026-10-01, pane
  // s27-mupamiv8: typed 10s in, six returns 4s apart, "UNSENT: 6 returns were swallowed" at
  // +38s - and the user row at +72s, sent by Claude Code itself once its SessionStart hooks
  // finished at +65s. s54 got five returns and four of them came back as "Removed 4 invisible
  // characters - review and press Enter to send". A young Claude Code with a pid file and no
  // transcript yet is given one return and waited for.
  {
    const name = 'sess-deferred'
    cli(name)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const at = Date.now()
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    p.say('\x1b[2J\x1b[H' + RULE + '\r\n❯ ' + BRIEF.split('\n')[0] + '\r\n' + RULE + '\r\n')
    // Claude Code finishes starting at +1.9s and runs the submit it took.
    while (Date.now() < at + 1900) await sleep(20)
    const before = returnsOf(p)
    received(name)
    for (const until = Date.now() + budget + 1500; Date.now() < until && !settles; ) await sleep(50)
    await logSays(pane.id, /prompt submitted|UNSENT/)
    ok(before === 1 && returnsOf(p) === 1, 'one return while Claude Code starts, and no more',
      `${before} before the row, ${returnsOf(p)} in all\n${logOf(pane.id)}`)
    ok(/Claude transcript receipt/.test(logOf(pane.id)) && !/UNSENT/.test(logOf(pane.id)) && settles === 1,
      'the submit Claude Code ran when it was ready is the receipt', logOf(pane.id))
    ok(/still starting - no more returns/.test(logOf(pane.id)), 'the wait is written down', logOf(pane.id))
    manager.kill(pane.id, 'user')
  }

  // ...and the wait ends: past the start ceiling a prompt still in the box gets its returns,
  // and one that never got a row is UNSENT, never "submitted".
  {
    const name = 'sess-deferred-never'
    cli(name)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const at = Date.now()
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    p.say('\x1b[2J\x1b[H' + RULE + '\r\n❯ ' + BRIEF.split('\n')[0] + '\r\n' + RULE + '\r\n')
    let second = 0
    for (const until = at + Number(process.env.PF_PROMPT_STARTUP_MS) + budget * 3 + 2000; Date.now() < until && !settles; ) {
      if (!second && returnsOf(p) > 1) second = Date.now()
      await sleep(20)
    }
    await logSays(pane.id, /prompt submitted|UNSENT/)
    ok(second - at >= Number(process.env.PF_PROMPT_STARTUP_MS) - 100,
      'no second return until Claude Code is past its start', `second return at +${second ? second - at : '-'}ms\n${logOf(pane.id)}`)
    ok(returnsOf(p) > 1 && /UNSENT/.test(logOf(pane.id)) && !/prompt submitted/.test(logOf(pane.id)),
      'then it gets its returns, and with no row it is UNSENT', `${returnsOf(p)} returns\n${logOf(pane.id)}`)
    manager.kill(pane.id, 'user')
  }

  // A START-UP HOOK FOUND BY ITS COMMAND, AND HELD FOR PAST THE MINUTE. s54-musnckna (PC,
  // 0.8.233, 2026-10-03): typed at the 10s short wait, its three SessionStart hooks ran from
  // +14s to +71.7s - past the 60s ceiling - and six returns went in while they ran; the prompt
  // sat unsent for 37 minutes until Robert pressed Enter from his phone. Windows has no process
  // groups, so there a hook is a process under the CLI running a command this desk's
  // settings.json declares for SessionStart (`hookState`, transcripts.ts). Here every hook is a
  // child in the CLI's own group, so only its command can find it: on Windows this is the real
  // reading (PowerShell), elsewhere `ps` stands in for it.
  {
    const hookFile = join(work, 'slow-start-hook.mjs')
    writeFileSync(hookFile, 'setTimeout(() => {}, Number(process.argv[2]))\n')
    const q = (s) => `"${s}"`
    // Declared the way the PC's are: a quoted node, a quoted script, then its arguments.
    const declare = (...ms) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup',
      hooks: ms.map((n) => ({ type: 'command', command: `${q(process.execPath)} ${q(hookFile)} ${n}` })) }] } }))
    process.env.PF_CLAUDE_HOOKS_BY = 'command'
    // A real process standing in for Claude Code: an MCP-like child declared nowhere for its whole
    // run, its pid file at once, and each hook ({at, ms}) a plain child running the declared command.
    const slowCli = async (sessionId, hooks) => {
      const plan = JSON.stringify({ hooks, hookFile, dir: join(home, 'sessions'), sessionId, cwd: root })
      const proc = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process')
        const { writeFileSync } = require('node:fs')
        const plan = JSON.parse(process.env.SLOW_CLI)
        const kids = [spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })]
        writeFileSync(plan.dir + '/' + process.pid + '.json',
          JSON.stringify({ pid: process.pid, sessionId: plan.sessionId, cwd: plan.cwd, startedAt: Date.now(), status: 'idle' }))
        console.log('up')
        plan.hooks.forEach(({ at, ms }, i) => setTimeout(() => {
          const hook = spawn(process.execPath, [plan.hookFile, String(ms)], { stdio: 'ignore' })
          kids.push(hook)
          hook.on('exit', () => console.log('hook-ended ' + i + ' ' + Date.now()))
        }, at))
        process.on('SIGTERM', () => { for (const k of kids) { try { k.kill() } catch {} } process.exit() })
        setTimeout(() => process.exit(), 15000)`], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SLOW_CLI: plan } })
      let out = ''
      proc.stdout.on('data', (d) => (out += d))
      const born = Date.now()
      for (const until = Date.now() + 5000; !out.includes('up') && Date.now() < until; ) await sleep(5)
      return { proc, born, ended: (i) => Number(new RegExp(`hook-ended ${i} (\\d+)`).exec(out)?.[1] ?? 0) }
    }

    // The reading itself, on this platform's own process list: running, then over - and the
    // MCP-like child, still running, is not a hook.
    declare(4000)
    const r = await slowCli('sess-cmd-read', [{ at: 0, ms: 4000 }])
    let seen = ''
    for (const until = Date.now() + 8000; Date.now() < until && !r.ended(0); await sleep(100)) {
      if (claudeStartup(r.proc.pid, r.born) === 'hooks') seen ||= `${Date.now() - r.born}ms`
    }
    let over = ''
    for (const until = Date.now() + (process.platform === 'win32' ? 15_000 : 8000); Date.now() < until && !over; await sleep(100)) {
      if (claudeStartup(r.proc.pid, r.born) === 'started') over = `${Date.now() - (r.ended(0) || Date.now())}ms after it ended`
    }
    ok(Boolean(seen), 'a start-up hook is found by its declared command while it runs', `seen ${seen || 'never'}`)
    ok(Boolean(over), 'and the start is over once it ends, with an undeclared child still running', `over ${over || 'never'}`)
    r.proc.kill()

    if (process.platform !== 'win32') {
      // Seen running at the start ceiling (3s here, a minute for real): held until it ends.
      declare(3600)
      const g = await slowCli('sess-cmd-gate', [{ at: 200, ms: 3600 }])
      const gp = open(g.proc.pid)
      const gTyped = await typedAt(gp.p, 9000)
      await sleep(50)
      ok(gTyped > 0 && g.ended(0) > 0 && gTyped >= g.ended(0) && /finished starting/.test(logOf(gp.pane.id)),
        'a start-up hook still running at the start ceiling holds the prompt until it ends',
        `typed ${gTyped ? gTyped - gp.at : '-'}ms in, hook ended ${g.ended(0) ? g.ended(0) - gp.at : '-'}ms in\n${logOf(gp.pane.id)}`)
      manager.kill(gp.pane.id, 'user')
      g.proc.kill()

      // s54 itself: typed before the hooks started, which then outlive the ceiling. One return,
      // none more while they run, and the submit Claude Code runs when they end is the receipt.
      declare(2400)
      const name = 'sess-cmd-s54'
      const s = await slowCli(name, [{ at: 1500, ms: 2400 }])
      const sPane = manager.start({ cwd: root, agent: 'claude' })
      const sp = { pane: sPane, p: manager.sessions.get(sPane.id).proc, at: Date.now() }
      sp.p.pid = s.proc.pid
      let settles = 0
      manager.queuePrompt(sPane.id, BRIEF, 0, 40, () => settles++, 5000)
      sp.p.say(IDLE)
      for (const until = Date.now() + 9000; Date.now() < until && !s.ended(0); ) await sleep(20)
      const before = returnsOf(sp.p)
      received(name)
      for (const until = Date.now() + budget + 3000; Date.now() < until && !settles; ) await sleep(50)
      await logSays(sp.pane.id, /prompt submitted|UNSENT/)
      ok(s.ended(0) > 0 && before <= 1 && returnsOf(sp.p) === 1,
        'no return goes in while a start-up hook runs past the start ceiling',
        `${before} returns by the hook's end (+${s.ended(0) ? s.ended(0) - sp.at : '-'}ms), ${returnsOf(sp.p)} in all\n${logOf(sp.pane.id)}`)
      ok(/Claude transcript receipt/.test(logOf(sp.pane.id)) && !/UNSENT/.test(logOf(sp.pane.id)),
        'and the submit Claude Code ran when its hooks ended is the receipt', logOf(sp.pane.id))
      manager.kill(sp.pane.id, 'user')
      s.proc.kill()
    }
    // NOTHING DECLARED, NOTHING READ: with no SessionStart command to look for (none at all, or
    // one too short to name a hook - a bare `node` matches every node child) the Windows reading
    // is never started, where it would cost a PowerShell every second for every Claude start.
    {
      const cp = createRequire(import.meta.url)('node:child_process')
      const spawnsFor = async (label) => {
        await sleep(2500) // the earlier cases' own readings wind down first
        const spy = mock.method(cp, 'execFile')
        const c = await slowCli(label, [{ at: 0, ms: 1500 }])
        let hooks = false
        for (const until = Date.now() + 1200; Date.now() < until; await sleep(100)) hooks ||= claudeStartup(c.proc.pid, c.born) === 'hooks'
        // Only the hook reading (`hookTable`): the app's other process-list readings are not it -
        // the ages of processes, and the strays sampler's 30 s table (`pid=,ppid=,lstart=,comm=`,
        // `CreationDate` on Windows), which lands in this window whenever the earlier cases'
        // running time puts its tick here.
        const hookTable = (c) => {
          const [cmd, args] = c.arguments
          if (cmd === 'ps') return String(args).includes('pgid=')
          if (cmd !== 'powershell' || !Array.isArray(args)) return false
          const script = Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1] ?? ''), 'base64').toString('utf16le')
          return script.includes('[Console]::OutputEncoding') && script.includes('ProcessId,ParentProcessId,CommandLine |')
        }
        const reads = spy.mock.calls.filter(hookTable)
        const n = reads.length
        const first = reads.map((c) => `${c.arguments[0]} ${String(c.arguments[1]).slice(0, 60)}`).join(' | ')
        spy.mock.restore()
        c.proc.kill()
        return { n, hooks, first }
      }
      declare()
      const none = await spawnsFor('sess-cmd-none')
      ok(none.n === 0 && !none.hooks, 'with no SessionStart command declared no reading of the process list is started', `${none.n} reads: ${none.first}`)
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node' }] }] } }))
      const short = await spawnsFor('sess-cmd-short')
      ok(short.n === 0 && !short.hooks, 'and a declared command shorter than 8 characters names no hook', `${short.n} reads, hooks ${short.hooks}: ${short.first}`)
      declare(1500)
      const some = await spawnsFor('sess-cmd-some')
      ok(some.n > 0 && some.hooks, 'while a real declared command is read and found', `${some.n} reads, hooks ${some.hooks}`)
    }
    // An unusable ceiling in the environment must not remove the bound (NaN compares false with everything).
    {
      buildSync({
        absWorkingDir: root,
        stdin: { contents: `export { CLAUDE_HOOKS_MAX_MS } from './src/main/transcripts'`, resolveDir: root },
        bundle: true, format: 'cjs', platform: 'node', outfile: join(work, 'hooksmax.bundle.cjs'),
        alias: { electron: join(work, 'electron-stub.cjs'), '@lydell/node-pty': join(work, 'pty-stub.cjs') }, logLevel: 'silent'
      })
      const was = process.env.PF_PROMPT_HOOKS_MAX_MS
      const got = []
      for (const v of ['abc', '', '-5', '0']) {
        process.env.PF_PROMPT_HOOKS_MAX_MS = v
        delete req.cache[req.resolve(join(work, 'hooksmax.bundle.cjs'))]
        got.push(req('./hooksmax.bundle.cjs').CLAUDE_HOOKS_MAX_MS)
      }
      process.env.PF_PROMPT_HOOKS_MAX_MS = was
      ok(got.every((n) => n === 300_000), 'an invalid hooks ceiling in the environment falls back to 5 minutes', JSON.stringify(got))
    }
    delete process.env.PF_CLAUDE_HOOKS_BY
    deskHooks(true)
  }

  // A TYPED CLAUDE PROMPT LEFT UNSENT IS KEPT, NOT CALLED LOST. After the 2026-10-01 restarts
  // 14 of 15 resumed panes' `continue` was logged LOST and then answered, up to 80s later
  // (s11-mupasdoz). The typed row stays owed instead, and the idle sweep writes it down as
  // submitted whenever its whole payload turns up in the conversation.
  {
    cli('sess-late')
    hooksDone('sess-late', 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(pane.id)
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => {}, 5000)
    live.proc.say(IDLE)
    // Three returns a confirm window apart before the verdict: ~1s here, past the 2s default
    // on the PC's full-suite pool (2026-10-01: the row went in first and read "submitted").
    await logSays(pane.id, /UNSENT/, 15_000)
    const qpNow = () => { try { return readFileSync(join(work, 'userData', 'queued-prompts.log'), 'utf8').split('\n').filter((l) => l.includes(pane.id)).join('\n') } catch { return '' } }
    ok(/UNSENT/.test(logOf(pane.id)) && !/LOST/.test(qpNow()) && live.meta.owedPrompt,
      'a typed Claude prompt left UNSENT stays owed and is not logged LOST', `${logOf(pane.id)}\n${qpNow()}`)
    received('sess-late')
    // Its own return's draft hold goes with it, read in the sweep's own tick (`confirmDraft`
    // may drop it later from the screen). Left up, it outlived the turn the prompt started and
    // `endRun` queued the next automatic clear behind it for good (s19-muqs9nqa, 2026-10-02).
    const heldBefore = Boolean(live.draftConfirmation)
    manager.sweepIdle()
    const heldAfter = Boolean(live.draftConfirmation) || Boolean(live.meta.drafting)
    ok(heldBefore && !heldAfter, 'the receipt drops the draft hold its own return set',
      `hold before ${heldBefore}, after ${heldAfter}\n${logOf(pane.id)}`)
    await logSays(pane.id, /retained prompt submitted - Claude transcript receipt/)
    ok(/retained prompt submitted - Claude transcript receipt/.test(logOf(pane.id)) && /queued prompt submitted/.test(qpNow()) &&
      !/LOST/.test(qpNow()) && !live.meta.owedPrompt,
      'its late transcript row is written down as submitted, never LOST', `${logOf(pane.id)}\n${qpNow()}`)
    manager.kill(pane.id, 'user')
  }

  // A FINISHED PANE CARRYING A BACKGROUND AGENT STILL TAKES WHAT IS QUEUED FOR IT. 2026-10-03
  // 9:05-9:55am, pane s23-murj80i9: `pf tell`s sat "waiting behind you" for 50 minutes while
  // its turn was over and only a background agent ran. The turn had been sent from outside, so
  // that Enter's draft hold was up, and the agent row's timer repaints once a second for as
  // long as the agent lives: the sweep lifts the hold only off a pane quiet for a second, and
  // the queue types only into one quiet for its own gap, so neither came until the agent
  // ended (fixture pane s33-murmzkt1 the same morning: held 4m04s, the agent's whole run).
  // The ticks here come faster than every quiet gap in this file, as the real ones do.
  {
    cli('sess-bg-agent'); hooksDone('sess-bg-agent', 60_000)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const live = manager.sessions.get(pane.id)
    const p = live.proc
    p.say(IDLE)
    manager.write(pane.id, 'run the slow suite in a background agent\r', 'phone')
    manager.setBusyOnScreen(pane.id, true)
    // One tick as the pane's log has it (see autoclear-test.mjs): cursor hops, the title glyph
    // flipping, and the one grey digit that moved, on a row below the composer.
    const E = '\x1b'
    const tick = (n) => `${E}[2C${E}[8A${E}[?25h${E}]0;${n % 2 ? '◑' : '◐'} Faster PaneForge tests\x07${E}[?25l${E}[2D` +
      `${E}[8B\r${E}[101C${E}[1A${E}[38;2;153;153;153m${n % 10}${E}[39m\r\r\n`
    let n = 0
    const ticking = setInterval(() => p.say(tick(n++)), 60)
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => {}, 60_000)
    await sleep(1500)
    const duringTurn = typings(p)
    // The turn ends as the window reads its footer; the agent it started does not.
    p.say(IDLE)
    manager.setBusyOnScreen(pane.id, false)
    const at = await typedAt(p, 15_000)
    clearInterval(ticking)
    ok(!duringTurn, 'a prompt queued behind a running turn waits for it', logOf(pane.id))
    ok(at, 'and goes in once the turn is over, though the background agent it started ticks on',
      `typed ${at ? 'yes' : 'no'}, drafting ${live.meta.drafting}, held ${Boolean(live.draftConfirmation)}, ${n} ticks\n${logOf(pane.id)}`)
    manager.kill(pane.id, 'user')
  }

  // ...and with no pid file there is no receipt to wait for: past twice the pid-file wait,
  // the returns come back rather than a minute of nothing. On a desk with no SessionStart
  // hooks, so the typing is not itself held to the ceiling for hooks still to come (that
  // hold is pinned above); this case is about the returns after it.
  {
    rmSync(pidFile, { force: true })
    deskHooks(false)
    const pane = manager.start({ cwd: root, agent: 'claude' })
    const at = Date.now()
    const p = manager.sessions.get(pane.id).proc
    let settles = 0
    manager.queuePrompt(pane.id, BRIEF, 0, 40, () => settles++, 5000)
    p.say(IDLE)
    await sentReturnAt(p)
    p.say('\x1b[2J\x1b[H' + RULE + '\r\n\u276f ' + BRIEF.split('\n')[0] + '\r\n' + RULE + '\r\n')
    let second = 0
    for (const until = at + Number(process.env.PF_PROMPT_STARTUP_MS); Date.now() < until && !second; ) {
      if (returnsOf(p) > 1) second = Date.now()
      await sleep(20)
    }
    ok(second && second - at < Number(process.env.PF_PROMPT_STARTUP_MS),
      'a Claude Code with no pid file is not held for the whole start', `second return at +${second ? second - at : '-'}ms\n${logOf(pane.id)}`)
    for (const until = Date.now() + budget * 2; Date.now() < until && !settles; ) await sleep(50)
    manager.kill(pane.id, 'user')
    deskHooks(true)
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
    manager.kill(pane.id, 'user')
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
  manager.kill(clockPane.id, 'user')

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
  manager.kill(solePane.id, 'user')

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
  manager.kill(reviewPane.id, 'user')
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
  await logSays(restored.id, /Claude transcript receipt/)
  // Waits for the follower's own settle, not the first receipt line: the receipt is logged a few
  // ms before the follower is typed, and when the 1s idle sweep reads the receipt before the
  // follower's 40ms poll does, `retained prompt submitted` is logged first and the follower is
  // typed a tick later (2026-10-02, PC: this and the close below read red;
  // `manager.sweepIdle()` right after `received` reproduces it every time).
  const released = () => rowsFor(restored.id).length === 0 && restoredLive.proc.writes.some(data => data.includes(follower))
  for (const until = Date.now() + 6000; !released() && Date.now() < until;) await sleep(40)
  ok(released() && restoredLive.proc.writes.filter(data => data.includes(follower)).length === 1 && !restoredLive.proc.writes.some(data => data.includes(BRIEF)),
    'only the entire native payload releases the retained owner and permits one follower paste', logOf(restored.id))
  const oldReply = manager.replyFor
  manager.replyFor = id => id === restored.id ? { text: 'Completed the requested recovery and verified it.' } : undefined
  restoredLive.meta.status = 'idle'; restoredLive.meta.runSince = undefined; restoredLive.meta.drafting = false
  restoredLive.meta.lastOutput = Date.now() - 10_000; restoredLive.footerEndedAt = Date.now() - 10_000
  restoredLive.busyUntil = 0; restoredLive.typed = ''
  // An agent pane closes through the app's report-first close (index.ts); this stands in for it.
  const askedToClose = []
  manager.onCloseWhenDone = id => { askedToClose.push(id); manager.kill(id, 'close-when-done') }
  manager.armCloseWhenDone(restored.id); manager.sweepIdle()
  ok(askedToClose.includes(restored.id) && !manager.sessions.has(restored.id), 'a genuine completed reply with no owed intent still closes normally')
  manager.onCloseWhenDone = null
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
  // s46-mud47sld (2026-09-22 20:17Z): a 2334-char brief wrapped over ~20 composer rows,
  // with words split at the right edge.
  const BIG = ('Robert asked: prove the queued brief off the screen and never off the run clock. ').repeat(30).slice(0, 2334)
  const RULE60 = '\u2500'.repeat(60)
  const wrapped = []
  for (let i = 0; i < BIG.length; i += 118) wrapped.push((i ? '  ' : '\u276f ') + BIG.slice(i, i + 118))
  ok(wrapped.length >= 19, 'the fixture really wraps over about twenty rows', String(wrapped.length))
  ok(
    promptStillInBox('\u273b Running SessionStart hooks\u2026 (2s \u00b7 esc to interrupt)\n' + RULE60 + '\n' + wrapped.join('\n') + '\n' + RULE60 + '\n', BIG) === true,
    'a long prompt wrapped over twenty rows, split mid-word, is still in the box'
  )
  ok(
    promptStillInBox(wrapped.slice(-6).join('\n') + '\n' + RULE60 + '\n  \u23f5\u23f5 bypass permissions on\n', BIG) === true,
    '...and so is one scrolled so only its tail rows are on screen'
  )
  ok(
    promptStillInBox(RULE60 + '\n\u276f [Pasted text #1 +20 lines]\n' + RULE60 + '\n', BIG) === true,
    '...and one Claude Code folded into a pasted-text token'
  )
  ok(
    promptStillInBox('> ' + BIG.slice(0, 118) + '\n\u23fa on it\n' + RULE60 + '\n\u276f \n' + RULE60 + '\n', BIG) === false,
    'the same long prompt submitted leaves an empty composer'
  )
  ok(promptStillInBox('\u2500'.repeat(60) + '\n\u276f Continuethehandoff:workitsNextstepsinorder\n' + '\u2500'.repeat(60) + '\n', 'Continue the handoff: work its Next steps in order') === true, 'a prompt whose spaces were drawn as cursor moves is still in the box')
  // Narrow pane: the first 24 letters are split over several 10-column rows.
  const narrow = []
  for (let i = 0; i < BIG.length; i += 10) narrow.push((i ? '  ' : '❯ ') + BIG.slice(i, i + 10))
  ok(
    promptStillInBox(RULE60 + '\n' + narrow.slice(0, 5).join('\n') + '\n' + RULE60 + '\n', BIG) === true,
    'a prompt wrapped at ten columns, its opening split over several rows, is still in the box'
  )
  // Head scrolled out of the composer, marker row and rules on screen: the tail alone answers true.
  ok(
    promptStillInBox(RULE60 + '\n❯ ' + BIG.slice(-45) + '\n' + RULE60 + '\n', BIG) === true,
    'a composer whose head is gone but whose tail is present still holds the prompt'
  )
  ok(
    promptStillInBox(wrapped.slice(-2).join('\n') + '\n\u23fa Working on it\n' + RULE60 + '\nBash command\n', BIG) === null,
    'a submitted echo whose head scrolled off, with a reply and a rule under it, is not read as held'
  )
  ok(promptStillInBox(RULE60 + '\n\u276f go on now\n' + RULE60 + '\n', 'go on now') === true, 'a short prompt is still read once its spaces are counted')
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
  // `contentAt`, not `lastOutput`: a background agent's footer timer ticks once a second and
  // would prove every command it sat beside (s23-murj80i9, 2026-10-03).
  ok(/proof === 'idle' && idle\(still\) && still\.contentAt > typedAt/.test(fn),
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
    // Real Codex naming: codexTranscriptPath opens only `rollout-<time>-<id>.jsonl` (09252fd8).
    const file = join(process.env.CODEX_HOME, 'sessions', '2026', '09', '30', `rollout-2026-09-30T01-02-03-${conversation}.jsonl`)
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
  manager.kill(startup.pane.id, 'user')

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
  manager.kill(trusted.pane.id, 'user')

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
  manager.kill(foreignTrust.pane.id, 'user')

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
    manager.kill(edited.pane.id, 'user')
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
  manager.kill(hinted.pane.id, 'user')

  const literalDraft = open()
  literalDraft.p.say(frame(hint).replace(/\x1b\[5;\d+H$/, '\x1b[5;3H'))
  const draftSettled = queue(literalDraft, payload, 300)
  await sleep(700)
  ok(draftSettled() === 0 && !pasted(literalDraft.p) &&
    ledger(literalDraft.pane.id).some(row => row.text === payload && !row.typed),
    'regular same-string draft with caret at start keeps queued bytes out and preserves accepted intent')
  manager.kill(literalDraft.pane.id, 'user')

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
  manager.kill(persistence.pane.id, 'user')

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
  manager.kill(ordered.pane.id, 'user')

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
  manager.kill(held.pane.id, 'user')

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
  manager.kill(foreign.pane.id, 'user')

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
  // 6s, not the block's 2.4s: the paste, return and receipt take ~300ms, but on the PC's
  // full-suite pool (2026-10-01, 98c30508) the paste landed and the 60ms return timer had
  // still not run 2.3s later. A 2.5s stall after the paste reproduces that on the Mac.
  ok(await waitFor(() => pasted(unknown.p, later) && ledger(unknown.pane.id).length === 0, 6000) && blockedNext() === 1,
    'a late exact receipt promotes the retained second prompt without another queue call',
    `pasted=${pasted(unknown.p, later)}, rows=${ledger(unknown.pane.id).length}\n${logOf(unknown.pane.id)}`)
  manager.kill(unknown.pane.id, 'user')

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
  manager.kill(stale.pane.id, 'user')

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
  manager.kill(selfSent.pane.id, 'user')

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
    manager.kill(scanHeld.pane.id, 'user')
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
  manager.kill(finalLF.pane.id, 'user')

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
  manager.kill(changed.pane.id, 'user')

  const asked = open()
  asked.live.meta.ask = { question: 'synthetic dialog', options: [] }
  const askedSettled = queue(asked, payload, 300)
  ok(await logSays(asked.pane.id, /queued prompt retained/) && askedSettled() === 0 && asked.p.writes.length === 0, 'a dialog blocks Codex paste without completing a deferred sequencing callback')
  manager.kill(asked.pane.id, 'user')
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
  manager.kill(afterPaste.pane.id, 'user')

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
  manager.kill(afterRestart.pane.id, 'user')
  manager.kill(repeated.pane.id, 'user')

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
    manager.kill(canceled.pane.id, 'user')
  }

  const command = open()
  command.p.onWrite = data => {
    if (data === '\r') setTimeout(() => command.p.say(frame('') + '\x1b[2;1HModel updated\x1b[5;3H'), 10)
  }
  const commandSettled = queue(command, '/model gpt-6.1-sol')
  ok(await waitFor(commandSettled) && returnsOf(command.p) === 1 && ledger(command.pane.id).length === 0,
    'a default Codex slash command uses idle command proof without a native user receipt', logOf(command.pane.id))
  manager.kill(command.pane.id, 'user')

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
  manager.kill(swallowed.pane.id, 'user')

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
    manager.kill(effort.pane.id, 'user')
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
    manager.kill(source.pane.id, 'user'); manager.kill(restored.pane.id, 'user')
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
  manager.kill(neverTyped.pane.id, 'user'); manager.kill(recoveredUntyped.pane.id, 'user')

  // ---------------------------------------------------------------------------
  // `pf tell` INTO A CODEX PANE LANDS, AND SAYS WHETHER IT DID.
  //
  // 2026-10-03: a tell to s42-mus4a344 waited for a turn that ran for hours and then gave up;
  // a 1463-char `pf type` sat typed in s40-mus3teu4's box for 10 minutes; the Enter retries
  // that should have rescued it were all held back because the box, read off the screen,
  // had lost a space at each soft wrap. A fake Codex: one input box that takes a bracketed
  // paste and shows it (long pastes as Codex 0.160 does, `[Pasted Content N chars]`), and an
  // Enter that writes the box to the rollout as a user row - or is swallowed, as each knob says.
  const fakeCodex = (f, o = {}) => {
    const s = { box: '', echoedAt: 0, returns: 0, swallowed: 0, booting: Boolean(o.booting), top: o.top ?? '', bootEndedAt: 0, pastedAt: 0, firstEchoAt: 0, firstEnterAt: 0 }
    const show = (text) => {
      if (o.show) return o.show(text)
      const n = [...text].length
      if (n > 1000) return `[Pasted Content ${n} chars]`
      if (!o.wrapAt) return text
      // Soft wrap at the last space before the width, and the space is not drawn (s40: the
      // box read 495 chars for a 497-char prompt).
      const rows = []
      let rest = text
      while (rest.length > o.wrapAt) {
        const cut = rest.lastIndexOf(' ', o.wrapAt)
        if (cut <= 0) break
        rows.push(rest.slice(0, cut))
        rest = rest.slice(cut + 1)
      }
      return [...rows, rest].join('\n')
    }
    s.paint = () => {
      let raw = frame(show(s.box), Boolean(o.working))
      if (s.booting) raw = raw.replace('\x1b[2J', '\x1b[2J\x1b[2;1H• Starting MCP servers (0/2): codex_apps (0s • esc to interrupt)')
      if (s.top) raw = raw.replace('\x1b[2J', `\x1b[2J\x1b[1;1H${s.top}`)
      f.p.say(raw)
      s.echoedAt = Date.now()
    }
    s.endBoot = () => { s.booting = false; s.bootEndedAt = Date.now(); s.paint() }
    f.p.onWrite = (data) => {
      const m = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
      if (m) {
        s.box = m[1]
        s.pastedAt = Date.now()
        // A busy TUI draws the paste late (`echoMs`): the Enter has to wait for it.
        const draw = () => { s.paint(); s.firstEchoAt ||= s.echoedAt }
        if (o.echoMs) setTimeout(draw, o.echoMs)
        else draw()
        return
      }
      if (data !== '\r') return
      s.returns++
      s.firstEnterAt ||= Date.now()
      // Codex 0.160 paste-burst guess: an Enter within 120ms of the last text it drew is part
      // of the same burst. And an Enter while it is still starting goes nowhere.
      const burst = o.burstMs !== undefined && Date.now() - s.echoedAt < o.burstMs
      if (burst || s.booting || (o.swallowFirst && s.returns === 1) || o.swallowAll) { s.swallowed++; return }
      if (s.box) f.received(s.box)
      s.box = ''
      s.paint()
    }
    s.paint()
    return s
  }
  const longTurn = (f) => {
    f.live.meta.runSince = Date.now() - 3 * 3600_000
    f.live.busyUntil = Date.now() + 600_000
    f.live.meta.status = 'working'
  }
  const ticker = (s, every = 250) => setInterval(() => s.paint(), every)

  // (i) Mid-turn, box clear: steered into the running turn, receipted, and the turn never ended.
  {
    const f = open()
    longTurn(f)
    const s = fakeCodex(f, { working: true })
    const tick = ticker(s)
    const busySince = f.live.meta.runSince
    const text = 'please also check the export settings before you render'
    const startedAt = Date.now()
    const outcome = await manager.tellPane(f.pane.id, text, 4000)
    clearInterval(tick)
    ok(outcome?.kind === 'delivered' && outcome.how === 'steered' && /Codex wrote it/.test(outcome.receipt) && outcome.id === f.pane.id,
      'tell: a Codex pane mid-turn with a clear box gets the prompt steered in and receipted', JSON.stringify(outcome) + '\n' + logOf(f.pane.id))
    ok(Date.now() - startedAt < 4000 && f.live.meta.runSince === busySince,
      'tell: steered within seconds, without waiting for the turn to end', `${Date.now() - startedAt}ms, runSince ${f.live.meta.runSince} vs ${busySince}`)
    ok(await logSays(f.pane.id, /steered into a running Codex turn \(busy since \d{1,2}:\d\d[ap]m \w{3}\)/),
      'tell: the steer is written down once, with when the turn began', logOf(f.pane.id))
    ok(pasted(f.p, text) && ledger(f.pane.id).length === 0, 'tell: one bracketed paste, ledger closed by the receipt')
    manager.kill(f.pane.id, 'user')
  }
  // ...but not over the person's draft: that waits, and the tell says so.
  {
    const f = open()
    longTurn(f)
    const s = fakeCodex(f, { working: true })
    manager.write(f.pane.id, 'half a thought', 'desk')
    s.box = 'half a thought'
    s.paint()
    const outcome = await manager.tellPane(f.pane.id, 'a tell that must wait for the draft', 900)
    ok(outcome?.kind === 'queued' && outcome.busySince === f.live.meta.runSince && /typing/.test(outcome.reason) &&
      !pasted(f.p, 'a tell that must wait for the draft') && f.live.meta.owedPrompt,
      "tell: a person's draft in the box keeps the prompt waiting, owed, and says why", JSON.stringify(outcome) + '\n' + logOf(f.pane.id))
    manager.kill(f.pane.id, 'user')
  }
  // ...nor into a sub-agent's view, where Enter would go to the sub-agent.
  {
    const f = open()
    longTurn(f)
    const s = fakeCodex(f, { working: true, show: () => 'Viewing sub-agent — direct input is disabled' })
    s.top = 'Sub-agent /root/worker'
    s.paint()
    const outcome = await manager.tellPane(f.pane.id, 'a tell that must not reach the sub-agent', 900)
    ok(outcome?.kind === 'queued' && /sub-agent/.test(outcome.reason) && !pasted(f.p, 'a tell that must not reach the sub-agent'),
      'tell: a sub-agent view keeps the prompt waiting and says why', JSON.stringify(outcome) + '\n' + logOf(f.pane.id))
    manager.kill(f.pane.id, 'user')
  }
  // (vi) A name nobody has.
  {
    const outcome = await manager.tellPane('s999-nobody', 'hello', 500)
    ok(outcome?.kind === 'missing' && outcome.ref === 's999-nobody', 'tell: no such chat answers missing', JSON.stringify(outcome))
  }
  // (ii) An Enter in the same burst as the paste is swallowed: the re-sent Enter lands it.
  // The paste is drawn 150ms late, as a busy Windows TUI does; the first Enter waits for it.
  {
    const f = open()
    const s = fakeCodex(f, { burstMs: 120, echoMs: 150 })
    const text = 'a prompt whose first Enter is read as part of the paste'
    const settled = queue(f, text)
    ok(await waitFor(() => settled() === 1) && ledger(f.pane.id).length === 0 && await logSays(f.pane.id, /native Codex receipt/),
      'a swallowed same-burst Enter is re-sent and the prompt lands', `${s.returns} returns, ${s.swallowed} swallowed\n${logOf(f.pane.id)}`)
    ok(s.firstEchoAt > 0 && s.firstEnterAt >= s.firstEchoAt,
      'and the first Enter waits until the paste is drawn', `Enter ${s.firstEnterAt - s.firstEchoAt}ms after the paste was drawn`)
    manager.kill(f.pane.id, 'user')
  }
  // (iii) The box soft-wraps at a space and drops it: still the prompt, so Enter is re-sent.
  {
    const f = open()
    const s = fakeCodex(f, { wrapAt: 30, swallowFirst: true })
    const text = 'render the opening shot again with the warmer key light and keep the same camera move throughout'
    const settled = queue(f, text)
    ok(await waitFor(() => settled() === 1) && ledger(f.pane.id).length === 0 && s.returns === 2,
      'a soft-wrapped box that lost its spaces still gets the retry Enter', `${s.returns} returns\n${logOf(f.pane.id)}`)
    manager.kill(f.pane.id, 'user')
  }
  // ...while a box that really holds something else is held back, and the log says why.
  {
    const f = open()
    const text = 'the prompt this app typed into the box'
    const s = fakeCodex(f, { swallowAll: true, show: (t) => t ? 'somebody else wrote this instead' : '' })
    const settled = queue(f, text)
    ok(await waitFor(() => settled() === 1) && s.returns === 1,
      'a box holding different text gets no retry Enter', `${s.returns} returns\n${logOf(f.pane.id)}`)
    ok(await logSays(f.pane.id, new RegExp(`codex retry \\d/\\d held back: input box shows 32 chars, prompt is ${text.length}`)),
      'and every held-back retry names both lengths', logOf(f.pane.id))
    ok(Boolean(f.live.meta.promptUnsent), 'a Codex prompt given up on is marked not sent on the pane', String(f.live.meta.promptUnsent))
    manager.write(f.pane.id, 'x', 'desk')
    ok(!f.live.meta.promptUnsent, 'and the mark clears when the person writes into the pane', String(f.live.meta.promptUnsent))
    manager.kill(f.pane.id, 'user')
    // The ledger log is appended off the closing path, so it is waited for, not raced.
    const lostOf = () => { try { return readFileSync(join(work, 'userData', 'queued-prompts.log'), 'utf8').split('\n').filter((l) => l.includes(f.pane.id) && /LOST/.test(l)).join('\n') } catch { return '' } }
    await waitFor(() => lostOf() !== '', 2000)
    const lost = lostOf()
    ok(/typed into the box but the agent never took it before the pane closed/.test(lost) && !/closed before it was typed/.test(lost),
      'closing that pane logs the prompt as typed but never taken, not as never typed', lost)
  }
  // (iv) A 1,500-char paste shows as Codex's placeholder: that IS the prompt, so Enter is re-sent.
  {
    const f = open()
    const s = fakeCodex(f, { swallowFirst: true })
    const text = ('a long brief line that goes on. '.repeat(47) + 'end').slice(0, 1500)
    const settled = queue(f, text)
    ok(await waitFor(() => settled() === 1) && ledger(f.pane.id).length === 0 && s.returns === 2,
      'a [Pasted Content 1500 chars] box is the prompt: retry Enter sent, receipt lands', `${s.returns} returns\n${logOf(f.pane.id)}`)
    manager.kill(f.pane.id, 'user')
  }
  // (v) A fresh Codex still starting its MCP servers, quiet long enough to look stale: the
  // prompt waits for the start to finish, and lands whichever way the first Enter goes.
  {
    const f = open()
    const s = fakeCodex(f, { booting: true })
    const text = 'the first prompt into a Codex that is still starting'
    const settled = queue(f, text, 8000)
    setTimeout(() => s.endBoot(), Number(process.env.PF_PROMPT_STALE_BUSY_MS) + 900)
    ok(await waitFor(() => settled() === 1, 9000) && ledger(f.pane.id).length === 0,
      'the first prompt into a starting Codex lands', `${s.returns} returns, ${s.swallowed} swallowed\n${logOf(f.pane.id)}`)
    ok(s.bootEndedAt > 0 && s.pastedAt >= s.bootEndedAt,
      'and it is typed only once the start is over', `pasted ${s.pastedAt - s.bootEndedAt}ms after the start ended\n${logOf(f.pane.id)}`)
    manager.kill(f.pane.id, 'user')
  }
  // (vii) A Codex that finished starting before anybody looked - a restored or woken chat
  // first looked at 8 s after spawn. Its start line is still in the text it printed, but the
  // screen shows a ready, empty box: that is what counts, so the prompt goes in now, not when
  // the start wait runs out a minute after spawn.
  {
    const f = open()
    const bornAt = Date.now()
    const s = fakeCodex(f, { booting: true })
    s.endBoot()
    // Quiet past the stale-footer wait, as such a chat is by the time it is looked at.
    await sleep(Number(process.env.PF_PROMPT_STALE_BUSY_MS) + 100)
    const text = 'the first prompt into a Codex that started before anybody looked'
    const queuedAt = Date.now()
    const settled = queue(f, text, 8000)
    await waitFor(() => s.pastedAt > 0, 4000)
    ok(s.pastedAt > 0 && s.pastedAt - queuedAt < 1000 && s.pastedAt - bornAt < Number(process.env.PF_PROMPT_STARTUP_MS),
      'a Codex whose start is over on screen is typed at once, not held to the end of the start wait',
      `pasted ${s.pastedAt ? s.pastedAt - queuedAt : 'never'}ms after it was queued, ${s.pastedAt ? s.pastedAt - bornAt : '-'}ms after spawn\n${logOf(f.pane.id)}`)
    ok(!/waiting for Codex to finish starting/.test(logOf(f.pane.id)), 'and nothing says it is still starting', logOf(f.pane.id))
    ok(await waitFor(() => settled() === 1) && ledger(f.pane.id).length === 0, 'and it lands', logOf(f.pane.id))
    manager.kill(f.pane.id, 'user')
  }
  // (viii) A tell to a chat still starting says so in seconds. Without it a `pf continue` that
  // reopened a chat held its caller for the whole receipt window, and GuardDeck gives it 45 s.
  {
    const f = open()
    const s = fakeCodex(f, { booting: true })
    const tick = ticker(s)
    const startedAt = Date.now()
    const outcome = await manager.tellPane(f.pane.id, 'continue', 8000)
    const took = Date.now() - startedAt
    clearInterval(tick)
    ok(outcome?.kind === 'queued' && /still starting/.test(outcome.reason) && took < 6000 && f.live.meta.owedPrompt,
      'tell: a chat still starting answers queued in seconds, and the prompt stays owed', `${took}ms ${JSON.stringify(outcome)}\n${logOf(f.pane.id)}`)
    manager.kill(f.pane.id, 'user')
  }
  // (ix) Codex takes a prompt late, after it was marked not sent: the mark goes with the hold,
  // or the card and GuardDeck keep saying "not sent" over a prompt Codex is answering.
  {
    const f = open()
    const s = fakeCodex(f, { swallowAll: true })
    const text = 'a prompt Codex takes only after it was given up on'
    const settled = queue(f, text)
    ok(await waitFor(() => settled() === 1) && Boolean(f.live.meta.promptUnsent) && Boolean(f.live.draftConfirmation),
      'precondition: a swallowed Codex prompt is marked not sent and keeps its hold', `${JSON.stringify(f.live.draftConfirmation)}\n${logOf(f.pane.id)}`)
    f.received(text)
    s.box = ''
    s.paint()
    await sleep(50)
    await manager.confirmDraft(f.live)
    ok(!f.live.draftConfirmation && !f.live.meta.promptUnsent,
      'a prompt Codex took after it was marked not sent clears the mark with the hold',
      `hold=${JSON.stringify(f.live.draftConfirmation)} promptUnsent=${f.live.meta.promptUnsent}`)
    manager.kill(f.pane.id, 'user')
  }
  // (x) A tell whose prompt cannot even be queued answers failed, once, and leaves nothing
  // ticking behind it: the 250 ms watch used to start first and then read a wait that was
  // never made, throwing on every tick for ever.
  {
    const f = open()
    const thrown = []
    const catcher = (e) => thrown.push(String(e?.message ?? e))
    process.on('uncaughtException', catcher)
    manager.queuePrompt = () => { throw new Error('the list of waiting prompts could not be saved') }
    let outcome
    try { outcome = await manager.tellPane(f.pane.id, 'hello', 2000) } catch (e) { outcome = { rejected: String(e?.message ?? e) } }
    delete manager.queuePrompt
    await sleep(700)
    // Left on when the old code is running, so its endless ticks do not end the whole file.
    if (!thrown.length) process.off('uncaughtException', catcher)
    ok(outcome?.kind === 'failed' && outcome.id === f.pane.id && /could not be saved/.test(outcome.reason) && thrown.length === 0,
      'tell: a prompt that cannot be queued answers failed with the reason, and nothing keeps ticking',
      `${JSON.stringify(outcome)} | ${thrown.length} errors after it: ${thrown[0] ?? ''}`)
    manager.kill(f.pane.id, 'user')
  }
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
  manager.kill(pane.id, 'user')
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
  manager.kill(pane.id, 'user')
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
  manager.kill(pane.id, 'user')
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
    // s54-musnckna (PC, 2026-10-03): "6 returns were swallowed" left no mark, so no card
    // chip, no `pf list` note, no GuardDeck card and nothing for the Mac that opened it.
    ok(Boolean(live.meta.promptUnsent), `${agent} (app): swallowed returns mark the prompt not sent`, String(live.meta.promptUnsent))
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
  manager.kill(pane.id, 'user')
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
    manager.kill(pane.id, 'user')
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
