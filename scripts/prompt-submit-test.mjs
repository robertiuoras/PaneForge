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
const returns = () => proc.writes.filter((w) => w === '\r').length

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
// Their turn runs and then the composer goes quiet again - which is the exact window
// the old code typed into.
hijackProc.say(COMPOSER)
await sleep(900)
const afterHuman = hijackProc.writes.join('')
ok(
  !afterHuman.includes('Continue the handoff'),
  'a prompt queued before a HUMAN sent one is dropped, never typed into their turn',
  JSON.stringify(hijackProc.writes)
)
ok(
  typeof humanAt === 'number' && humanAt > 0,
  'the human submit is what moves lastKeyboard, and it is recorded',
  String(humanAt)
)
// ...and no stray confirm return goes out either. An Enter into a turn that is already
// answering is a keystroke at a live CLI, harmless at a composer and not at a chooser.
const straysBefore = hijackProc.writes.filter((w) => w === '\r').length
await sleep(700)
ok(
  hijackProc.writes.filter((w) => w === '\r').length === straysBefore,
  'and no confirm returns are fired after the person took the pane',
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
  'takeOver drops the queued prompt as a real keystroke would',
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

// A pane that closes mid-wait settles too - otherwise the curtain outlives the pty.
const dying = manager.start({ cwd: root, agent: 'shell' })
let dead2 = 0
manager.queuePrompt(dying.id, 'never lands', 0, 40, () => dead2++)
manager.sessions.delete(dying.id)
await sleep(400)
ok(dead2 === 1, 'a pane that went away settles the curtain rather than stranding it', String(dead2))

manager.killAll?.()
rmSync(work, { recursive: true, force: true })

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
  ok(/if \(!idle\(still\)\) \{[\s\S]*?return confirm\(\)/.test(fn), 'a painting pane must be waited out, not settled')
  // ...AND THE CONFIRM IS BOUNDED BY ITS OWN CLOCK, NOT THE WAIT'S.
  // 2026-09-01, pane s31-mti4yatg: the composer only read idle 181s into a 180s budget,
  // so the return went out with the deadline already past and the very first confirm
  // logged UNSENT with five retries unused. `handoverMaxMs` always sized the curtain as
  // `budgetMs + PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES`; only this branch disagreed.
  ok(/Date\.now\(\) >= confirmUntil\)/.test(fn), 'and the wait must still be bounded')
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
  ok(/setHandover\(id, Date\.now\(\) \+ handoverMaxMs\(CLEAR_RESUME_BUDGET_MS\)\)/.test(src),
    'and the curtain outlives that wait, so the pane says a prompt is still coming')
}

console.log(fail.length ? `\n${fail.length} FAILED` : '\nall ok')
process.exit(fail.length ? 1 : 0)
