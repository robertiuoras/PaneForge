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
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
// the real ceilings are a minute and ten seconds, these keep the cases below short.
process.env.PF_PROMPT_STARTUP_MS ??= '1500'
process.env.PF_PROMPT_PIDFILE_MS ??= '800'
process.env.PF_CLAUDE_SETTLE_MS ??= '200'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-prompt-submit-'))
mkdirSync(join(work, 'userData'), { recursive: true })
// The CLI's own pid files and transcripts, off the real ~/.claude.
process.env.PF_CLAUDE_HOME = join(work, 'claude-home')

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
  write(d){this.writes.push(d)}, kill(){}, resize(){},
  say(text){this._data && this._data(text)}
})}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/sessions.ts'],
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
const { SessionManager } = req('./sessions.bundle.cjs')

const fail = []
const ok = (c, n, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + n)
  if (!c) {
    if (detail !== undefined) console.log('     ', detail)
    fail.push(n)
  }
}
const sleep = (n) => new Promise((r) => setTimeout(r, n))

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
await sleep(400)
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
const LATER = 'and this one is still wanted'
manager.sendPrompt(hijack.id, LATER)
// Painted AFTER the first poll on purpose: the busy read is of the NEWEST output, and
// this pane's buffer still holds the boot's `esc to interrupt`. A real CLI keeps painting;
// a stub that never says anything again leaves the last busy frame as the newest one.
await sleep(200)
hijackProc.say(COMPOSER)
await sleep(700)
ok(
  hijackProc.writes.join('').includes(LATER),
  'a prompt queued after they finished still goes in',
  JSON.stringify(hijackProc.writes)
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
await sleep(1400)
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
let cmdDone = 0
const cmdAt = Date.now()
let cmdSettledAt = 0
manager.queuePrompt(cmd.id, '/model opus', 0, 40, () => { cmdDone++; cmdSettledAt = Date.now() }, 5000, 'idle')
await sleep(120)
cmdProc.say(COMPOSER)
await sleep(400)
// The CLI answers the command with one line and the composer again - still no turn.
cmdProc.say('\r\n  ⎿  Set model to Opus 5 and saved as your default for new sessions\r\n' + COMPOSER)
await sleep(900)
ok(cmdDone === 1, 'a slash command settles without a turn', String(cmdDone))
ok(cmdProc.writes.filter((w) => w === '\r').length === 1, 'and it got exactly one return - the idle composer was the proof', JSON.stringify(cmdProc.writes))
ok(cmdSettledAt - cmdAt < Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES) + 500, 'and it settled at the poll cadence, not after the whole confirm budget', String(cmdSettledAt - cmdAt))
manager.kill(cmd.id)

// ...and a QUIET composer that printed NOTHING is a swallowed return, not a landed command.
// 2026-09-07, pane s2-mtqmyvnv: `/clear` restarted the CLI, the `/model opus` return went in
// during a gap in the boot paint and was eaten, and the confirm settled 1.2s later as
// "command landed". The 721-character resume prompt was then typed onto a composer still
// holding `/model opus`, and Claude Code read the pair as one slash command:
// `Model 'opus\n\nContinue the handoff...' not found`. The clear happened, the handover did
// not. So the proof is the command's ANSWER, not the silence around it.
// Answers the moment the return this queuePrompt sends was written, so a case can be
// judged against the confirm window rather than against a wall-clock sleep.
async function sentReturnAt(proc, waitMs = 3000) {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (proc.writes.some((w) => w === '\r')) return Date.now()
    await sleep(10)
  }
  return Date.now()
}

const eaten = manager.start({ cwd: root, agent: 'shell' })
const eatenProc = manager.sessions.get(eaten.id).proc
let eatenDone = 0
manager.queuePrompt(eaten.id, '/model opus', 0, 40, () => eatenDone++, 5000, 'idle')
await sleep(120)
eatenProc.say(COMPOSER)
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
  `settles=${eatenDone}, ${sinceReturn}ms after the return, budget ${confirmBudget}ms`
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
  const acPath = join(work, 'userData', 'autoclear-app.log')
  const logOf = (id) => readFileSync(acPath, 'utf8').split('\n').filter((l) => l.includes(id)).join('\n')
  // The durable log is appended off the typing path; on the PC a line can land after the
  // keystrokes it describes, so a reading waits for it rather than racing it.
  const logSays = async (id, re) => {
    const until = Date.now() + 2000
    while (Date.now() < until && !re.test(logOf(id))) await sleep(40)
    return re.test(logOf(id))
  }

  // s113: the pid file is there, the hooks are not done. The composer is idle the whole time.
  cli('sess-running')
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
  ok(bAt > 0 && bAt - b.at < 700, 'a CLI that has finished starting is typed into at once', `${bAt ? bAt - b.at : '-'}ms`)
  manager.kill(b.pane.id)

  // The record never comes (hooks stuck, or none configured): held only until the process is
  // PF_PROMPT_STARTUP_MS old, then typed as it always was.
  cli('sess-stuck')
  const c = open()
  const cAt = await typedAt(c.p, 3000)
  ok(cAt > 0 && cAt - c.at >= 1200, 'a record that never comes holds the prompt only up to the ceiling',
    `${cAt ? cAt - c.at : '-'}ms\n${logOf(c.pane.id)}`)
  ok(await logSays(c.pane.id, /typing anyway/), 'and the log says it was typed without the record', logOf(c.pane.id))
  manager.kill(c.pane.id)

  // No pid file at all (a CLI that writes none): the short wait, then as before.
  rmSync(pidFile, { force: true })
  const d = open()
  const dAt = await typedAt(d.p, 2500)
  ok(dAt - d.at >= 600 && dAt - d.at < 1400, 'a CLI with no pid file costs only the short wait', `${dAt ? dAt - d.at : '-'}ms`)
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
  const sAt = await typedAt(sp, 1200)
  ok(sAt > 0 && sAt - sAt0 < 700, 'a pane that is not Claude Code is not held', `${sAt ? sAt - sAt0 : '-'}ms`)
  manager.kill(shell.id)
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
  const fn = src.slice(src.indexOf('const submit = (tries: number)'), src.indexOf('const tick = ()'))
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
  ok(/box === false/.test(fn) && /settle\('sent'\)/.test(fn), 'an empty composer settles it as sent')

  ok(!/Date\.now\(\) >= deadline\)/.test(fn), 'the confirm may not expire on the WAIT deadline')
  ok(
    /confirmUntil = typedAt \+ PROMPT_CONFIRM_MS \* PROMPT_ENTER_TRIES/.test(
      src.slice(src.indexOf('const submit = (tries: number)'), src.indexOf('const tick = ()'))
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

manager.killAll?.()
rmSync(work, { recursive: true, force: true })
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
