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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
process.env.PF_PROMPT_POLL_MS ??= '40'
process.env.PF_PROMPT_ENTER_MS ??= '60'
process.env.PF_PROMPT_CONFIRM_MS ??= '200'
process.env.PF_PROMPT_WAIT_MAX_MS ??= '5000'
// Pinned here rather than read from the module: the SHIPPED budget is 6, and the cap
// assertion below is about the cap existing at all, not about the number.
process.env.PF_PROMPT_ENTER_TRIES ??= '3'
process.env.PF_PROMPT_RETYPE_MS ??= '1500'
// How long the LAST return gets to show on screen before the prompt is marked not sent.
process.env.PF_PROMPT_BACKOFF_MAX_MS ??= '2000'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-prompt-submit-'))
mkdirSync(join(work, 'userData'), { recursive: true })

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
// Each frame REPAINTS the status line in place (`\r` + erase line), as a real CLI's
// spinner does. Appending eight copies would leave eight `esc to interrupt` lines on the
// replayed screen for ever, which no real pane draws - and the prompt path reads the
// screen (`screenOf`), not just the newest bytes.
const REPAINT = '\r\x1b[2K'
for (let i = 0; i < 8; i++) {
  proc.say(REPAINT + BOOTING)
  await sleep(40)
}
ok(!typed().includes('first line of the ask'), 'nothing is typed while the CLI is still booting', typed())

// 2. The startup finishes: output stops and the footer stops claiming work. Now the
//    prompt goes in - and the return is NOT part of it. The composer replaces the boot
//    status line, which is what "the footer stops claiming work" looks like on screen.
proc.say(REPAINT + COMPOSER)
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
hijackProc.say(COMPOSER)
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
await echoWhenTyped(settlingProc, 'goes in fine')
await sentReturnAt(settlingProc)
// The return took: the CLI empties its box and draws a fresh composer.
settlingProc.say('\r\n' + COMPOSER)
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
// A real CLI ECHOES what is typed into its composer. The prompt path proves a submit off
// the replayed screen - "the box is empty AND the prompt had been in it" - so a fake that
// never draws the typed text is a CLI that never received it (s15-mucz8c8j), not a happy path.
async function echoWhenTyped(proc, text, waitMs = 3000) {
  const until = Date.now() + waitMs
  while (Date.now() < until && !proc.writes.some((w) => w.includes(text))) await sleep(10)
  proc.say('\r\x1b[2K › ' + text)
}

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
  await echoWhenTyped(aProc, RESUME2)
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
  // It used to be written off here as UNSENT/LOST with the text still in the box
  // (s15-mucz8c8j, 2026-09-22 18:03). A painting pane is waited out; the prompt stays owed.
  ok(!/UNSENT/.test(mine), 'a prompt still in the composer of a painting pane is not written off', mine)
  ok(sDone === 0 && manager.sessions.get(stuck.id).meta.owedPrompt, 'and it is still owed', String(sDone))
  manager.kill(stuck.id)
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
  const fn = src.slice(src.indexOf('const submitCommand = (tries: number)'), src.indexOf('const tick = ()'))
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
  // A PROMPT's confirm never reads the run clock at all (s46-mud47sld): only the composer
  // emptying, or Codex's own transcript, proves it. The `runSince` proof above is the slash
  // command path's (`submitCommand`), which only ever runs for proof 'idle'.
  const sp = src.slice(src.indexOf('const submitPrompt = (tries: number)'), src.indexOf('const submit = (tries: number)'))
  ok(sp.length > 0 && !/runSince/.test(sp), 'a queued prompt is never confirmed off runSince')
  ok(/proof === 'idle' \? submitCommand\(tries\) : submitPrompt\(tries\)/.test(src), '...and every prompt goes through that confirm')
  ok(
    /confirmUntil = typedAt \+ PROMPT_CONFIRM_MS \* PROMPT_ENTER_TRIES/.test(
      src.slice(src.indexOf('const submitCommand = (tries: number)'), src.indexOf('const tick = ()'))
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

// ---------------------------------------------------------------------------
// A QUEUED PROMPT IS NEVER LOST WHILE ITS PANE IS ALIVE.
//
// 2026-09-22 17:57, three Claude panes opened together under memory pressure, all three
// prompts logged `queued prompt LOST` inside 30s; queued-prompts.log held 417 such lines.
// Two different failures, both off the pane's own history log:
//   s15-mucz8c8j: the prompt was typed 2.8s after spawn, when Claude had printed nothing
//     but terminal queries. "Quiet and not busy" read as ready with NO COMPOSER DRAWN, the
//     text never reached the screen, and six returns hit an empty box.
//   s18-mucz8fm2: the first return WENT IN (`running UserPromptSubmit hooks… 0/4 · 12s`),
//     but Claude repaints only the cells that change, so each tick arrived as `13`, `14`:
//     no busy words in the newest bytes, a second of quiet between ticks, and the confirm
//     read an idle composer, fed five more returns and called a delivered prompt LOST.
const claudeFrame = (inBox = '') =>
  '\x1b[2J\x1b[H ▐▛███▜▌ Claude Code v2.1.280\r\n  ~/Projects/x\r\n' +
  '─'.repeat(60) + '\r\n❯ ' + inBox + '\r\n' + '─'.repeat(60) + '\r\n  ⏵⏵ bypass permissions on\r\n'
const settleLog = (id) =>
  readFileSync(join(work, 'userData', 'autoclear-app.log'), 'utf8').split('\n').filter((l) => l.includes(id)).join('\n')
const LONG = 'Robert asked: in PaneForge, remove the popup that appears when a session is renamed.'

// s15: nothing is typed until the composer is on screen, however quiet the pane is.
{
  const pane = manager.start({ cwd: root, agent: 'claude' })
  const p = manager.sessions.get(pane.id).proc
  let done = 0
  manager.queuePrompt(pane.id, LONG, 0, 40, () => done++, 5000)
  p.say('\x1b[>0q\x1b[>4m')
  await sleep(600)
  ok(!p.writes.join('').includes('Robert asked'), 'a Claude pane that has drawn no composer is not typed at', JSON.stringify(p.writes))
  p.say(claudeFrame())
  await sleep(400)
  ok(p.writes.join('').includes('Robert asked'), 'and the prompt goes in once the composer is drawn', JSON.stringify(p.writes))
  manager.kill(pane.id)
}

// s18: a submit the agent is running hooks for is SENT, even when the newest bytes are
// only the counter digits of a partial repaint.
{
  const pane = manager.start({ cwd: root, agent: 'claude' })
  const p = manager.sessions.get(pane.id).proc
  let done = 0
  const write = p.write.bind(p)
  let submitted = false
  p.write = (d) => {
    write(d)
    if (d.includes('Robert asked')) setTimeout(() => p.say(claudeFrame(LONG)), 5)
    else if (d === '\r' && !submitted) {
      submitted = true
      setTimeout(() => p.say(
        '\x1b[2J\x1b[H❯ ' + LONG + '\r\n\r\n✻ Dilly-dallying… (running UserPromptSubmit hooks… 0/4 · 0s)\r\n' +
        '─'.repeat(60) + '\r\n❯ \r\n' + '─'.repeat(60) + '\r\n'), 5)
    }
  }
  p.say(claudeFrame())
  manager.queuePrompt(pane.id, LONG, 0, 40, () => done++, 5000)
  const budget = Number(process.env.PF_PROMPT_CONFIRM_MS) * Number(process.env.PF_PROMPT_ENTER_TRIES)
  const until = Date.now() + budget + 1200
  for (let s = 1; Date.now() < until; s++) {
    await sleep(200)
    p.say(`\x1b[3;50H${s}`)
  }
  const log = settleLog(pane.id)
  ok(!/UNSENT|LOST/.test(log), 'a prompt whose hooks are running is never called unsent', log)
  ok(done === 1 && /submitted/.test(log), 'it settles as submitted, once', `${done}\n${log}`)
  ok(returnsOf(p) === 1, 'and exactly one return was sent', String(returnsOf(p)))
  manager.kill(pane.id)
}

// A RUN CLOCK THAT MOVES IS NOT A SUBMIT. s46-mud47sld (Mac, 2026-09-22 20:17Z, load ~370):
// the installed build logged `queued prompt submitted` off `runSince` (moved by a boot/hook
// spinner and by the app's own return), and 13 minutes later the whole 2334-char brief was
// still in the composer. Here every return moves `runSince` and repaints a hook spinner
// over a composer that still holds the wrapped brief.
{
  const BRIEF = ('Robert asked: prove the queued brief off the screen and never off the run clock. ').repeat(30).slice(0, 2334)
  const hookFrame = () =>
    '\x1b[2J\x1b[H\u273b Running SessionStart hooks\u2026 (2s \u00b7 esc to interrupt)\r\n' + '\u2500'.repeat(60) +
    '\r\n\u276f ' + BRIEF + '\r\n' + '\u2500'.repeat(60) + '\r\n  \u23f5\u23f5 bypass permissions on\r\n'
  const pane = manager.start({ cwd: root, agent: 'claude' })
  const live = manager.sessions.get(pane.id)
  const p = live.proc
  let done = 0
  const write = p.write.bind(p)
  p.write = (d) => {
    write(d)
    if (d.includes('Robert asked')) setTimeout(() => p.say(hookFrame()), 5)
    else if (d === '\r') setTimeout(() => {
      live.meta.runSince = Date.now()
      p.say(hookFrame())
    }, 5)
  }
  p.say(claudeFrame())
  manager.queuePrompt(pane.id, BRIEF, 0, 40, () => done++, 5000)
  const cap = Number(process.env.PF_PROMPT_ENTER_TRIES)
  const until = Date.now() + 4000
  while (Date.now() < until && returnsOf(p) < 2) await sleep(20)
  // (a) the turn looks started, the brief is still in the box: owed, and Return goes again.
  ok(returnsOf(p) >= 2, 'a spinner over a composer still holding the brief gets Return again', String(returnsOf(p)))
  ok(done === 0 && live.meta.owedPrompt && !/submitted/.test(settleLog(pane.id)),
    '...and a moved run clock never confirms it', settleLog(pane.id))
  // (b) the returns never take: UNSENT, with the resend on the card - never "submitted".
  const until2 = Date.now() + 8000
  while (Date.now() < until2 && !done) await sleep(50)
  await sleep(300) // the log line is appended after settle; read it once it has landed
  const log = settleLog(pane.id)
  ok(returnsOf(p) === cap, `returns stop at PROMPT_ENTER_TRIES (${cap})`, String(returnsOf(p)))
  ok(done === 1 && /UNSENT/.test(log) && !/submitted/.test(log), 'returns that never take end UNSENT, never submitted', `${done}\n${log}`)
  ok(live.meta.unsentPrompt?.text === BRIEF && !live.meta.owedPrompt, '...and the card offers it again (markUnsent)', JSON.stringify(live.meta.unsentPrompt?.text?.slice(0, 40)))
  manager.queuePrompt(pane.id, 'a fresh ask supersedes the chip', 0, 100000, undefined, 5000)
  ok(!live.meta.unsentPrompt, 'queuing any prompt clears the not-sent chip')
  manager.kill(pane.id)
}

// Text that never reached the box is typed again rather than returned at an empty composer.
{
  const pane = manager.start({ cwd: root, agent: 'claude' })
  const p = manager.sessions.get(pane.id).proc
  let done = 0
  const write = p.write.bind(p)
  let eaten = 0
  p.write = (d) => {
    write(d)
    // The first copy vanishes (typed into a CLI not yet reading keys); a second one echoes.
    if (d.includes('Robert asked') && eaten++ > 0) setTimeout(() => p.say(claudeFrame(LONG)), 5)
  }
  p.say(claudeFrame())
  manager.queuePrompt(pane.id, LONG, 0, 40, () => done++, 5000)
  const until = Date.now() + 6000
  while (Date.now() < until && eaten < 2) await sleep(50)
  ok(eaten >= 2, 'a prompt that never appeared in the composer is typed again', String(eaten))
  manager.kill(pane.id)
}

// HEAVY LAG: every byte the CLI prints arrives a second late - five confirm periods, the
// scaled-down shape of s44-mud42wl9 (Mac, 2026-09-22 20:13Z, load ~470), whose prompt was
// logged LOST. The echo of the typed text and the submitted frame both come late. The
// prompt must settle as sent, once, and must never be typed a second time into the box.
{
  const LAG_MS = 1000
  const pane = manager.start({ cwd: root, agent: 'claude' })
  const p = manager.sessions.get(pane.id).proc
  let done = 0
  const write = p.write.bind(p)
  let submitted = false
  p.write = (d) => {
    write(d)
    if (d.includes('Robert asked')) setTimeout(() => p.say(claudeFrame(LONG)), LAG_MS)
    else if (d === '\r' && !submitted) {
      submitted = true
      setTimeout(() => p.say(
        '\x1b[2J\x1b[H❯ ' + LONG + '\r\n\r\n✻ Thinking… (1s · esc to interrupt)\r\n' +
        '─'.repeat(60) + '\r\n❯ \r\n' + '─'.repeat(60) + '\r\n'), LAG_MS)
    }
  }
  p.say(claudeFrame())
  manager.queuePrompt(pane.id, LONG, 0, 40, () => done++, 5000)
  const until = Date.now() + 6000
  while (Date.now() < until && !done) await sleep(50)
  await sleep(600)
  const log = settleLog(pane.id)
  const copies = p.writes.filter((w) => w.includes('Robert asked')).length
  ok(done === 1 && !/UNSENT|LOST/.test(log), 'under heavy lag a late-echoed prompt still settles as sent, once', `${done}\n${log}`)
  ok(copies === 1, '...and a late echo is waited for, never typed into the box twice', String(copies))
  manager.kill(pane.id)
}

manager.killAll?.()
rmSync(work, { recursive: true, force: true })
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
