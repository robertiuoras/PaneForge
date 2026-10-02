// A chat whose CLI process died mid-turn on its own (OOM kill, crash, kill -9) while the app
// kept running is reopened on its conversation and told to carry on - not closed 6 s later
// with nobody the wiser. The app-restart path already does this for a whole-app restart
// (`shared/restoreTurn.ts` `continueAfterRestore`); this is the same thing for ONE pane.
//
// Half the file is refusals: the exit was the app's or a person's doing, nothing was in
// flight, there is no conversation to reopen, or it is a crash loop. The other half is the
// wiring, asserted as source because the exit handler is a closure over a live pty.
//
//   node scripts/cli-revive-test.mjs

import { readFileSync } from 'node:fs'

let failed = 0
function ok(what, cond, extra) {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${what}${cond || extra === undefined ? '' : ` - ${extra}`}`)
  if (!cond) failed++
}

const source = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
const start = source.indexOf('proc.onExit(({ exitCode }) => {')
const exit = source.slice(start, source.indexOf('Raise or drop the handover curtain', start))

console.log('the exit handler consults the verdict before the plan that closes the card')
{
  const at = (s) => exit.indexOf(s)
  ok('onExit is found', start > 0 && exit.length > 500)
  ok('it calls reviveVerdict', at('reviveVerdict(') > 0)
  ok('...before exitPlan', at('reviveVerdict(') > 0 && at('reviveVerdict(') < at('exitPlan('))
  ok('mid-turn is read before endRun clears the clock it reads', at('this.midTurn(live)') > 0 && at('this.midTurn(live)') < at('this.endRun(live)'))
  const branch = exit.slice(at('if (verdict.revive'), at('exitPlan('))
  ok('a revival returns before the card is closed', /this\.restart\(id\)[\s\S]*?return/.test(branch))
  ok('it respawns on the conversation, without replaying the launch prompt', /resume: true, resumeId, prompt: undefined/.test(branch))
  ok('the continue goes through queuePrompt (the owed-prompt path restore uses)', /this\.queuePrompt\(id, REVIVE_PROMPT, RESTORE_CONTINUE_MS\)/.test(branch))
  ok("reclaim.log says 'revive'", /action: 'revive'/.test(exit))
  ok("...and 'revive-refused' with the reason", /action: 'revive-refused'[\s\S]*?why/.test(exit))
  ok('the crash-loop record lives on the pane, not the process', /live\.revives/.test(exit))
}

console.log('the mid-turn reading is the one the app restart uses')
{
  ok('snapshot() asks it', /wasWorking: this\.midTurn\(s\)/.test(source))
  ok(
    'it is the native turn, else the run clock or a pending background task',
    /private midTurn\(s: Live\): boolean \{[\s\S]*?rolloutTurn\(codexTranscriptPath[\s\S]*?\.inProgress[\s\S]*?\?\? \(Boolean\(s\.meta\.runSince\) \|\| this\.hasPendingBackground\(s\)\)/.test(source)
  )
}

let mod
try {
  mod = await import('../src/shared/cliRevive.ts')
} catch (e) {
  ok('src/shared/cliRevive.ts loads', false, e.message.split('\n')[0])
}
if (mod) {
  const { reviveVerdict, REVIVE_PROMPT } = mod
  const NOW = 1_800_000_000_000
  const died = (over = {}) => ({ agent: 'claude', resumeId: 'conv-1', midTurn: true, lastRevives: [], now: NOW, ...over })

  console.log('a chat killed mid-turn on its own comes back')
  {
    const v = reviveVerdict(died())
    ok('a working pane that died revives', v.revive === true, JSON.stringify(v))
    ok('codex too', reviveVerdict(died({ agent: 'codex' })).revive === true)
    ok('the prompt tells it what happened, in plain words', REVIVE_PROMPT === "This chat's process stopped mid-turn and was reopened. Carry on with what you were doing, from where it stopped.")
  }

  console.log('...and not when the exit was somebody\'s doing, or nothing was in flight')
  {
    const no = (what, over, words) => {
      const v = reviveVerdict(died(over))
      ok(what, v.revive === false && (!words || words.test(v.why)), JSON.stringify(v))
    }
    no('an idle pane that died is not reopened', { midTurn: false }, /not mid-turn/)
    no('a pane the app or a person closed (closedFirst)', { closedFirst: true }, /closed/)
    no('the app quitting', { quitting: true }, /closing/)
    no('a pane put to sleep', { asleep: true }, /sleep/)
    no('a pane being moved to the other machine', { handingOff: true }, /other machine/)
    no('a process a newer one already replaced', { superseded: true }, /replaced/)
    no('no conversation id to reopen it on', { resumeId: undefined }, /conversation/)
    no('an empty conversation id', { resumeId: '' }, /conversation/)
    no('a shell has no conversation', { agent: 'shell' }, /shell/)
  }

  console.log('a crash loop stops, and says so')
  {
    const minute = 60_000
    const two = reviveVerdict(died({ lastRevives: [NOW - 12 * minute, NOW - 6 * minute], lastReviveAt: NOW - 6 * minute }))
    ok('the 3rd death in 15 minutes stays closed', two.revive === false && two.loop === true, JSON.stringify(two))
    ok('...in plain words', /2 times in the last 15 minutes/.test(two.why), two.why)
    const old = reviveVerdict(died({ lastRevives: [NOW - 40 * minute, NOW - 20 * minute, NOW - 2 * minute], lastReviveAt: NOW - 2 * minute }))
    ok('only revivals inside the window count: one recent is fine', old.revive === true, JSON.stringify(old))
    const quick = reviveVerdict(died({ lastRevives: [NOW - 10_000], lastReviveAt: NOW - 10_000 }))
    ok('a pane that died 10 s after its last reopen stays closed', quick.revive === false && quick.loop === true && /10 s/.test(quick.why), JSON.stringify(quick))
    ok('...but 31 s of life is enough', reviveVerdict(died({ lastRevives: [NOW - 31_000], lastReviveAt: NOW - 31_000 })).revive === true)
    ok('the limits are parameters', reviveVerdict(died({ lastRevives: [NOW - 5 * minute], lastReviveAt: NOW - 5 * minute, maxPerWindow: 1 })).revive === false)
    ok('a refusal that is not the loop guard is not flagged as one', reviveVerdict(died({ midTurn: false })).loop !== true)
  }
}

console.log(failed ? `\n${failed} failed` : '\ncli-revive: all good')
process.exit(failed ? 1 : 0)
