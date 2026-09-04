// A pane whose program has gone closes itself - and the four times it must not.
//
// Robert, 2026-09-04: "i also dont want to see a session like exited especially a remote
// one its too confusing why exited ... id rather it closed instead of showing that you
// know so when i open again from history it just works".

import { exitPlan, exitWords, LINGER_MS } from '../src/shared/exitClose.ts'

let failed = 0
function ok(what, cond, extra) {
  console.log(`${cond ? 'ok' : 'FAIL'}  ${what}${cond || extra === undefined ? '' : ` - ${extra}`}`)
  if (!cond) failed++
}

const ran = { printed: true }

console.log('a program that ended takes its card with it')
{
  const p = exitPlan({ ...ran, exitCode: 0 })
  ok('a clean exit closes the pane', p.close)
  ok('and says so plainly', p.why === 'it finished', p.why)
  ok('after a beat, so the last lines can be read', p.after === LINGER_MS, p.after)

  const bad = exitPlan({ ...ran, exitCode: 137 })
  ok('a failure closes it too', bad.close)
  ok('and the number is IN the sentence, not on a card by itself', /code 137/.test(bad.why), bad.why)
}

console.log('...and the four times it stays')
{
  ok('a pane put to sleep is not a pane that exited', !exitPlan({ ...ran, asleep: true, exitCode: 0 }).close)
  ok('one being moved to the other machine keeps its card', !exitPlan({ ...ran, handingOff: true, exitCode: 0 }).close)
  // Every pty dies on the way out. Closing panes then would write an empty desk over the
  // one that has to come back.
  ok('the app quitting closes nothing', !exitPlan({ ...ran, quitting: true, exitCode: 0 }).close)
  // The one case where the card is the only evidence: an agent that could not start.
  const never = exitPlan({ printed: false, exitCode: 1 })
  ok('a pane that never printed a byte stays', !never.close)
  ok('and says it never started', never.why === 'it never started', never.why)
}

console.log('the list says what went')
{
  const say = exitWords('taskdriver', exitPlan({ ...ran, exitCode: 0 }))
  ok('the sentence names the pane', say.startsWith('taskdriver'), say)
  ok('and reads as one sentence', /taskdriver closed - it finished/.test(say), say)
  // Plain words: this is read by somebody who has never used a terminal.
  ok('no jargon in it', !/\b(pty|sigterm|exit code|process)\b/i.test(say), say)
}

console.log(failed ? `\n${failed} failed` : '\nexitclose: all good')
process.exit(failed ? 1 : 0)
