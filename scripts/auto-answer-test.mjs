#!/usr/bin/env node
// Answering an agent's question without a person.
//
// The positives are cheap and the negatives are the whole test. Pressing "Yes" on a
// permission prompt is a formality; pressing "Yes, and don't ask again" answers every
// future question of that shape, pressing "No, tell Claude what to do differently" leaves
// the CLI holding an empty composer, and pressing one of four design options is the app
// deciding the work. Each of those is a different kind of damage and each has a case here.
//
// The fixtures are the option shapes these CLIs really draw - Claude Code's permission
// prompt, its resume prompt, and an AskUserQuestion with four real answers - reduced to
// what `readAsk` hands on. `npm run test:choices` owns the reading; this owns the choosing.

import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const out = mkdtempSync(join(tmpdir(), 'pf-autoanswer-'))
await build({
  entryPoints: [join(root, 'src/shared/autoAnswer.ts')],
  outfile: join(out, 'autoAnswer.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { pickAnswer, dueForAuto, autoAnswerAt, askKeyOf, PRESS_COOLDOWN_MS, DEFAULT_AUTO_ANSWER } = await import(
  pathToFileURL(join(out, 'autoAnswer.mjs')).href
)

let n = 0
const ok = (what, fn) => {
  fn()
  n++
  console.log(`  ok  ${what}`)
}

const ask = (selected, ...labels) => ({
  question: 'q',
  selected,
  options: labels.map((label, i) => ({ n: i + 1, label }))
})
const ON = { ...DEFAULT_AUTO_ANSWER, enabled: true }
// It ships ON now, so "off" is a config somebody switched off rather than the default.
const OFF = { ...DEFAULT_AUTO_ANSWER, enabled: false }
const ANY = { ...ON, anyQuestion: true }

// ---------------------------------------------------------------------------
// The everyday one: a permission prompt, answered.
// ---------------------------------------------------------------------------
const PERMISSION = ask(
  1,
  'Yes',
  "Yes, and don't ask again for Edit commands in /Users/robert/Projects/PaneForge",
  'No, and tell Claude what to do differently (esc)'
)

ok('a permission prompt picks the plain Yes', () => {
  const pick = pickAnswer(PERMISSION, ON)
  assert.equal(pick?.n, 1)
  assert.match(pick.why, /Yes/)
})

ok('the widening option is never the one picked', () => {
  // Not merely "not first": it must never be reachable, whatever the arrow is on and
  // whichever mode is set. It is the one press that cannot be undone by noticing.
  for (const cfg of [ON, ANY]) {
    for (const sel of [1, 2, 3]) {
      const pick = pickAnswer({ ...PERMISSION, selected: sel }, cfg)
      assert.notEqual(pick?.n, 2, `mode=${cfg.anyQuestion} sel=${sel}`)
    }
  }
})

ok('every wording of "and stop asking me" is refused, not just this desk\'s', () => {
  // Matching the two strings Claude Code prints today makes the guard a note about one
  // CLI's release. These are the same sentence and every one of them must be unreachable.
  for (const label of [
    "Yes, and don't ask me again",
    "Yes, and don't ever ask again",
    'Yes, and never ask again',
    'Yes, and do not ask me again for this folder',
    'Yes, and stop asking about this again',
    'Yes, allow always'
  ]) {
    const a = ask(1, label, 'No')
    assert.equal(pickAnswer(a, ON), null, label)
    assert.equal(pickAnswer(a, ANY), null, `${label} (anyQuestion)`)
  }
})

ok('a prompt whose only yes widens permission is left alone', () => {
  const a = ask(1, 'Yes, allow always', 'No')
  assert.equal(pickAnswer(a, ON), null)
  // Even borrowing the CLI's default: the default IS the widening option here.
  assert.equal(pickAnswer(a, ANY), null)
})

ok('the resume prompt continues', () => {
  const pick = pickAnswer(ask(1, 'Continue this conversation', 'Start a new one'), ON)
  assert.equal(pick?.n, 1)
})

// ---------------------------------------------------------------------------
// The refusals.
// ---------------------------------------------------------------------------
ok('off answers nothing', () => {
  assert.equal(pickAnswer(PERMISSION, OFF), null)
})

ok('what it ships as', () => {
  // On, with a wait long enough to READ the countdown - that pane-side clock is the whole
  // reason this may be on by default. `anyQuestion` stays off: that one answers questions
  // somebody is being asked to DECIDE.
  assert.equal(DEFAULT_AUTO_ANSWER.enabled, true, 'it ships on')
  assert.equal(DEFAULT_AUTO_ANSWER.anyQuestion, false, 'the wider one stays off')
  assert.ok(DEFAULT_AUTO_ANSWER.waitMs >= 3000, 'the wait is readable, not a formality')
  assert.equal(DEFAULT_AUTO_ANSWER.defaultsV2, true, 'the migration marker is set')
})

ok('a design question waits for a person', () => {
  const design = ask(
    1,
    'Taskbar icon',
    'Alt-Tab entry',
    'Task Manager list',
    'Tray / system clock area'
  )
  assert.equal(pickAnswer(design, ON), null)
  // ...unless the wider setting is on, and then it is the CLI's own arrow, not a guess.
  const pick = pickAnswer({ ...design, selected: 3 }, ANY)
  assert.equal(pick?.n, 3)
  assert.match(pick.why, /default/)
})

ok('two yes-shaped answers are a choice, not an obvious one', () => {
  assert.equal(pickAnswer(ask(1, 'Yes, rebase', 'Yes, merge', 'Cancel'), ON), null)
})

ok('a default that stops and asks for a sentence is not taken', () => {
  // Picking it turns a pane that was merely waiting into one that is waiting AND has
  // lost the question it was waiting on.
  const a = ask(3, 'Yes', 'Yes, and always', 'No, tell Claude what to do differently')
  assert.equal(pickAnswer(a, ANY)?.n, 1, 'the plain yes still wins over the arrow')
  const noYes = ask(2, 'Keep the current plan', 'No, tell Claude what to do differently')
  assert.equal(pickAnswer(noYes, ANY), null)
})

// ---------------------------------------------------------------------------
// The BEST option, not the first one. Every agent CLI here marks its own preference in
// the label when it has one, and that marker is a statement from the tool rather than a
// guess by this app - so it outranks a yes-shaped word and it outranks the arrow.
// ---------------------------------------------------------------------------
ok('the option the CLI marks recommended is the one taken, not the first', () => {
  const a = ask(1, 'Rewrite the file', 'Patch it in place (recommended)', 'Skip')
  for (const cfg of [ON, ANY]) {
    const pick = pickAnswer(a, cfg)
    assert.equal(pick?.n, 2, `mode=${cfg.anyQuestion}`)
    assert.match(pick.why, /recommend/i)
  }
})

ok('a recommendation outranks the arrow, wherever the arrow is', () => {
  for (const sel of [1, 2, 3]) {
    const a = ask(sel, 'Taskbar icon', 'Alt-Tab entry [default]', 'Tray area')
    assert.equal(pickAnswer(a, ANY)?.n, 2, `sel=${sel}`)
  }
})

ok('a recommendation may not lift an option over a refusal', () => {
  // The marker raises rank. It can never reach past the two guards, in either mode.
  const widens = ask(1, "Yes, and don't ask again (recommended)", 'No')
  assert.equal(pickAnswer(widens, ON), null)
  assert.equal(pickAnswer(widens, ANY), null)
  const stops = ask(1, 'Do it', 'No, tell Claude what to do differently (recommended)')
  assert.equal(pickAnswer(stops, ON)?.n, 1, 'the plain yes is still the answer')
  assert.equal(pickAnswer(stops, ANY)?.n, 1)
})

ok('the WORD is not the marker - prose describing an option is not an endorsement', () => {
  // The first version read `\b(recommended|suggested)\b` and `\bthe default\b` anywhere in
  // the label, which is prose and not a marking. Each of these describes what the option
  // DOES, and each would have been pressed five seconds later as though the CLI had said
  // to. A marker is punctuated - (), [], or a trailing dash at the very end.
  // None of these leads with a yes-shaped word, so the ONLY thing that could pick them is
  // the marker rule - which is what makes this a test of the marker and not of GOES.
  // ("Use the default database" would be picked, correctly, by the yes rule instead.)
  for (const label of [
    'Keep the default permissions',
    'Overwrite with the suggested fix',
    'Delete files not in the recommended set',
    'Restore the default database'
  ]) {
    const a = ask(1, label, 'Configure it by hand')
    assert.equal(pickAnswer(a, ON), null, label)
  }
  // ...and a real trailing marker still counts.
  assert.equal(pickAnswer(ask(1, 'Patch it in place - recommended', 'Rewrite it'), ON)?.n, 1)
})

ok('two recommendations are a choice again', () => {
  // A tool recommending two things has not stated an answer, and picking between them is
  // the invention this file exists to refuse.
  const a = ask(1, 'Squash (recommended)', 'Rebase (recommended)', 'Cancel')
  assert.equal(pickAnswer(a, ON), null)
})

ok('"keep the current X" stops, the same as "keep current X"', () => {
  // The guard read `keep current` and the CLIs write `Keep the current plan`, so the one
  // wording anybody actually sees walked straight past it.
  const a = ask(2, 'Keep the current plan', 'No, tell Claude what to do differently')
  assert.equal(pickAnswer(a, ON), null)
  assert.equal(pickAnswer(a, ANY), null)
})

ok('"no" leading an answer is never read as yes', () => {
  assert.equal(pickAnswer(ask(1, 'No - I already said yes to that', 'Stop'), ON), null)
})

ok('an empty question answers nothing', () => {
  assert.equal(pickAnswer({ question: '', selected: 1, options: [] }, ANY), null)
})

// ---------------------------------------------------------------------------
// The timing. Every case here is a way the app ends up arguing with a widget, and each
// one is cheap to state and expensive to find in a live pane.
// ---------------------------------------------------------------------------
const T = 1_000_000
const state = (over = {}) => ({
  askKey: 'k1',
  askSince: T,
  autoKey: '',
  autoAt: 0,
  autoRun: 0,
  ...over
})

ok('a question is answered once it has settled, and not before', () => {
  assert.equal(dueForAuto(state(), ON, T + ON.waitMs - 1), false)
  assert.equal(dueForAuto(state(), ON, T + ON.waitMs), true)
  assert.equal(dueForAuto(state(), OFF, T + 60_000), false, 'off is off')
})

ok('the arrow moving restarts the wait', () => {
  // The pane restarts askSince on any frame change, arrow included: somebody moving the
  // selection at the desk must not have the press land from where they moved away.
  const moved = state({ askSince: T + 900 })
  assert.equal(dueForAuto(moved, ON, T + 1200), false)
  assert.equal(dueForAuto(moved, ON, T + 900 + ON.waitMs), true)
})

ok('the same question is never pressed twice', () => {
  assert.equal(dueForAuto(state({ autoKey: 'k1', autoAt: T }), ON, T + 600_000), false)
  // A different question on the same pane is a new question, cooldown permitting.
  assert.equal(
    dueForAuto(state({ askKey: 'k2', autoKey: 'k1', autoAt: T }), ON, T + 600_000),
    true
  )
})

ok('a press is not followed by another while its own keys are still landing', () => {
  // This is the race the arrow-inclusive signature used to open: our own arrows change
  // the frame, which restarts the settle clock, which lets a second sequence interleave.
  // The question is already settled by T, so the cooldown is the ONLY thing left holding
  // the press - which is what this case is about. Written with `askSince: T` it silently
  // measured the settle instead the moment the shipped wait grew past the cooldown.
  const mid = state({ askKey: 'k2', askSince: T - ON.waitMs, autoKey: 'k1', autoAt: T })
  assert.equal(dueForAuto(mid, ON, T + PRESS_COOLDOWN_MS - 1), false)
  assert.equal(dueForAuto(mid, ON, T + PRESS_COOLDOWN_MS), true)
})

ok('a pane may not do this for ever', () => {
  const spent = state({ autoRun: ON.maxRun })
  assert.equal(dueForAuto(spent, ON, T + 600_000), false)
  assert.equal(dueForAuto({ ...spent, autoRun: ON.maxRun - 1 }, ON, T + 600_000), true)
})

ok('no question, nothing to answer', () => {
  assert.equal(dueForAuto(state({ askKey: '' }), ON, T + 600_000), false)
  assert.equal(dueForAuto(state({ askSince: 0 }), ON, T + 600_000), false)
})

// ---------------------------------------------------------------------------
// The hold. The wait is the window in which somebody who disagrees reaches the pane, and
// that argument is empty while they are already at the desk reading it - so the seconds
// are only spent AWAY from the window. The load-bearing half is that looking away starts
// the whole wait again rather than resuming a part-spent one.
// ---------------------------------------------------------------------------
ok('a question is not answered while somebody is at the window', () => {
  // Settled long ago, but the hold was stamped a moment ago: nothing is pressed.
  const here = state({ askHold: T + 500_000 })
  assert.equal(dueForAuto(here, ON, T + 500_000), false)
  assert.equal(dueForAuto(here, ON, T + 500_000 + ON.waitMs - 1), false)
  assert.equal(dueForAuto(here, ON, T + 500_000 + ON.waitMs), true, 'the full wait, from the look away')
})

ok('the countdown drawn is the countdown pressed, hold included', () => {
  // The one defect the countdown exists to prevent: two start lines, so the pane promises
  // seconds the presser does not keep.
  const s = { ...state({ askHold: T + 9_000 }), askKey: askKeyOf(PERMISSION) }
  const at = autoAnswerAt(s, ON, PERMISSION)
  assert.equal(at, T + 9_000 + ON.waitMs)
  assert.equal(dueForAuto(s, ON, at - 1), false)
  assert.equal(dueForAuto(s, ON, at), true)
})

ok('a hold older than the wait changes nothing', () => {
  // The control: askHold is a start line, never a veto. A window left half an hour ago
  // must not hold a question that settled after it.
  const gone = state({ askSince: T + 60_000, askHold: T })
  assert.equal(dueForAuto(gone, ON, T + 60_000 + ON.waitMs), true)
  assert.equal(dueForAuto(state(), ON, T + ON.waitMs), true, 'no hold at all is the old behaviour')
})

ok('the identity of a question leaves the arrow out', () => {
  const a = ask(1, 'Yes', 'No')
  const b = ask(2, 'Yes', 'No')
  assert.equal(askKeyOf(a), askKeyOf(b), 'the arrow moved; the question did not')
  assert.notEqual(askKeyOf(a), askKeyOf(ask(1, 'Yes', 'Maybe')))
  assert.equal(askKeyOf(null), '')
})

// ---------------------------------------------------------------------------
// The wiring, at source level: the decision above is worth nothing if nothing calls it,
// and the two guards that keep it from arguing with a widget live in sessions.ts.
// ---------------------------------------------------------------------------
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')

ok('the sweep is wired and the decision above is the one it asks', () => {
  assert.match(sessions, /sweepAutoAnswer\(live\)/, 'called from the sweep')
  assert.match(sessions, /dueForAuto\(live, cfg, Date\.now\(\)\)/, 'the timing is the tested one')
  // The hold is a start line nothing computes on its own: without this stamp every case
  // above passes and the shipped app counts down while somebody reads the question.
  assert.match(sessions, /live\.askHold = Date\.now\(\)/, 'the hold is actually stamped')
  assert.match(sessions, /deskFocused\(\)/, 'and off the one focus probe, not a second one')

  // The migration, which is the only part of this that touches a config somebody already
  // has. A switch that cannot be kept off is worse than no switch: `setConfig` merges a
  // patch at the top level, so a caller sending only `holdWhileWatching` drops
  // `defaultsV3` and the early return stops firing - which is why this is keyed on the
  // FIELD being absent rather than on the marker.
  const config = readFileSync(join(root, 'src/main/config.ts'), 'utf8')
  assert.match(
    config,
    /if \(raw\?\.holdWhileWatching === undefined\)\s*\n?\s*merged\.holdWhileWatching/,
    'the hold is written only where the saved config has no answer to it'
  )

  // The held row is a branch no window test reaches - `test:askrender` turns the hold OFF
  // on purpose, because with it on that test would pass or fail on whether the probe's
  // window happened to be focused. So its shape is pinned here instead: held returns
  // early, draws no seconds, and subscribes to no tick.
  const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
  assert.match(pane, /useNow\(held \? Infinity : 1000, at\)/, 'held wakes the app for nothing')
  assert.match(pane, /if \(held\)\s*\n?\s*return \(/, 'held is its own row, not a countdown')
  assert.match(
    pane,
    /Waiting while you are here[\s\S]{0,200}pane-ask-auto-pick/,
    'and it still names the option it would press'
  )
  // The keys go through `choose`, which re-checks the question before every one of them.
  // The `'app'` hand is part of the pin, not decoration: A7 counts how often a PERSON
  // stepped in, and a question this code answered for you may not read as one you did.
  assert.match(sessions, /this\.choose\(live\.meta\.id, pick\.n, 'app'\)/)
})

ok('the state the guards read is actually written', () => {
  // A guard is half of a rule. Checking only the comparison lets the assignment that
  // makes it true be deleted, at which point every question is answered over and over
  // and this file still passes - which is the shape of green that costs the most.
  assert.match(sessions, /live\.autoKey = live\.askKey/, 'the pressed question is recorded')
  assert.match(sessions, /live\.autoAt = Date\.now\(\)/, 'and when')
  assert.match(sessions, /live\.autoRun\+\+/, 'and the run counter moves')
  assert.match(sessions, /s\.askKey = askKeyOf\(ask\)/, 'the identity is kept per frame')
  assert.match(sessions, /s\.askSince = sig \? now : 0/, 'and the settle clock')
})

ok('the run counter is given back by work resuming, not by a repaint', () => {
  // A chooser mid-repaint reads as no question for a frame, so resetting on "no question"
  // hands the budget back several times during ONE question and maxRun bounds nothing.
  const reset = sessions.slice(sessions.indexOf('s.askKey = askKeyOf(ask)'))
  const busyGate = reset.indexOf('if (busy) {')
  const counter = reset.indexOf('s.autoRun = 0')
  assert.ok(busyGate >= 0 && counter > busyGate && counter - busyGate < 800, 'reset sits under `if (busy)`')
})

// ---------------------------------------------------------------------------
// The countdown. A press that arrives with no warning is indistinguishable from the pane
// answering itself, so the pane says when and what - and the only way that stays true is
// if the clock it draws is the clock the presser keeps.

ok('the countdown is the settle window, and it agrees with the presser', () => {
  const s = state({ askKey: askKeyOf(PERMISSION), askSince: T })
  const at = autoAnswerAt(s, ON, PERMISSION)
  assert.equal(at, T + ON.waitMs, 'the clock is askSince + waitMs')
  assert.equal(dueForAuto(s, ON, at - 1), false, 'a second early, the presser refuses')
  assert.equal(dueForAuto(s, ON, at), true, 'and on the tick it presses')
})

ok('a cooldown still running pushes the clock out, not just the press', () => {
  // Settled before T, so the cooldown is the later of the two and is what the clock has to
  // show. With `askSince: T` this case measured the settle instead the moment the shipped
  // wait grew past the cooldown - a green test about the wrong number.
  const s = state({ askKey: askKeyOf(PERMISSION), askSince: T - ON.waitMs, autoAt: T + 500 })
  const at = autoAnswerAt(s, ON, PERMISSION)
  assert.equal(at, T + 500 + PRESS_COOLDOWN_MS)
  assert.equal(dueForAuto(s, ON, at), true)
})

ok('no clock is drawn for anything that will not be pressed', () => {
  const s = () => state({ askKey: askKeyOf(PERMISSION), askSince: T })
  assert.equal(autoAnswerAt(s(), OFF, PERMISSION), 0, 'the setting is off')
  assert.equal(autoAnswerAt(s(), ON, null), 0, 'there is no question')
  // The one this exists for: a question with no obvious answer is LEFT for a person, and
  // a countdown over it would be a clock that never fires - which reads as the app having
  // given up rather than as it deliberately not deciding.
  const design = ask(1, 'Use a modal', 'Use a drawer', 'Use a new page')
  assert.equal(autoAnswerAt(state({ askKey: askKeyOf(design), askSince: T }), ON, design), 0)
  const pressed = state({ askKey: askKeyOf(PERMISSION), askSince: T, autoKey: askKeyOf(PERMISSION) })
  assert.equal(autoAnswerAt(pressed, ON, PERMISSION), 0, 'already answered')
  const spent = state({ askKey: askKeyOf(PERMISSION), askSince: T, autoRun: ON.maxRun })
  assert.equal(autoAnswerAt(spent, ON, PERMISSION), 0, 'out of automatic presses')
})

// ---------------------------------------------------------------------------
// The screen that ENDS a multi-question ask. Every question in the set was already
// answered - by hand, or by this file - and nothing is sent until this list is.
// ---------------------------------------------------------------------------
ok('a review screen is submitted', () => {
  const review = ask(1, 'Submit answers', 'Cancel')
  const pick = pickAnswer(review, ON)
  assert.ok(pick, 'a set of answered questions must not sit on its own last screen')
  assert.equal(pick.n, 1)
})

ok('...and Cancel is never the one taken', () => {
  // Not merely "not preferred": Cancel throws away every answer on the screens before
  // it, so it has to be refused outright rather than out-ranked.
  assert.equal(pickAnswer(ask(2, 'Cancel', 'Submit answers'), ON).n, 2)
  // The arrow sitting on Cancel is not a signal to take it, in either mode.
  assert.equal(pickAnswer(ask(1, 'Cancel', 'Submit answers'), ANY).n, 2)
})

ok('...and a submit that also widens permission is still refused', () => {
  assert.equal(pickAnswer(ask(1, "Submit answers and don't ask again", 'Cancel'), ON), null)
})

ok('the plan is refreshed from the TIMER as well as from a frame', () => {
  // A frame only arrives when the screen changes, so computing it there alone means
  // turning the setting on over a question already on screen shows no countdown at all
  // and then presses out of nowhere. Measured that way against a live trust prompt.
  assert.match(sessions, /private refreshAutoPlan\(live: Live\)/)
  assert.match(sessions, /if \(this\.refreshAutoPlan\(live\)\) this\.emitSessions\(\)/, 'from the sweep')
  assert.match(sessions, /this\.refreshAutoPlan\(s\)/, 'and from the frame path')
})

ok('a held question has NO deadline anywhere, not just no seconds in the pane', () => {
  // The pane was the only consumer that looked at `autoAnswerHeld` beside the number. The
  // card's `AskClock` and the desk's tick both read `autoAnswerAt` alone, so a hold that
  // moved the deadline instead of clearing it left the card counting down and the tick
  // sounding once a second at somebody who had just clicked onto the pane to answer it.
  assert.match(sessions, /const at = heldNow \? 0 : due/, 'the hold clears the deadline at the source')
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(app, /s\.autoAnswerAt && \(!min \|\| s\.autoAnswerAt < min\)/, 'the tick reads the number alone')
  // Whitespace-tolerant: the card's title line grew a `hold` branch and prettier broke the
  // ternary over several lines, which turned a wiring assertion into a formatting one.
  assert.match(
    app,
    /<AskClock at=\{s\.autoAnswerAt\} \/>/,
    'so does the card'
  )
})

ok('a person arriving at a pane takes its close countdown with them', () => {
  // `stillCloseable` is what the "went back to work" effect keys on, and a click changes
  // none of it - so clicking a pane restarted its idle clock and left the 15s count
  // running underneath, closing or moving the pane being read.
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  const touch = app.slice(app.indexOf('const touchPane = useCallback'), app.indexOf('const togglePin'))
  assert.ok(touch, 'touchPane is where a press on a pane lands')
  assert.match(touch, /closeSoonsRef\.current/, 'it reads the live countdowns')
  // The stack, since 2026-09-01: it takes down the ONE card that named this pane and
  // leaves every other card counting.
  assert.match(touch, /find\(\(c\) => c\.ids\.includes\(id\)\)/, 'and only the one that NAMED it')
  assert.match(touch, /setCloseSoons\(\(list\) => list\.filter/)
  // A move countdown holds the sweep lock. Dropping the count without giving it back is
  // how `stopMove` shipped as a control that worked once and then moved nothing ever.
  assert.match(touch, /if \(soon\.move\) handoffSweeping\.current = false/)
})

ok('two decisions are two cards, and answering one leaves the other counting', () => {
  // It was one card full stop: `armCloseRef` began `if (closeSoonRef.current) return`, so
  // a second pane coming due inside the first one's fifteen seconds was dropped without a
  // word and re-armed from the top by the next sweep - which reads as one countdown that
  // ran down and jumped back up, with neither pane closing (Robert, 2026-09-01).
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  const arm = app.slice(app.indexOf('armCloseRef.current = (plan'), app.indexOf('const doSoonNow'))
  assert.ok(arm, 'armCloseRef is where a close countdown starts')
  assert.doesNotMatch(
    arm,
    /if \(closeSoonRef\.current\) return/,
    'a countdown already up may not refuse a countdown about a DIFFERENT pane'
  )
  assert.match(arm, /armed\.has\(p\.id\)/, 'only a pane already counting is left alone')
  assert.match(arm, /setCloseSoons\(\(list\) => \[/, 'the new one joins the stack')

  const card = readFileSync(join(root, 'src/renderer/src/components/MoveSoon.tsx'), 'utf8')
  assert.match(card, /soons\.map\(\(soon\) =>/, 'and the corner draws one card per decision')
  assert.match(card, /key=\{soonKey\(soon\)\}/, 'each keyed by the panes it names')

  // One sound for a stretch of countdowns, not one per card: "just 1 sound is fine for
  // coutndown because when i check i should see both will close".
  assert.match(
    app,
    /const anySoon = closeSoons\.length > 0/,
    'the alert is keyed on the stack being occupied, not on each card'
  )
  // Two matches rather than one spanning a line break: a regex with a bare \n in it does
  // not match the same file checked out with CRLF endings (`npm run test:crlf`).
  assert.match(app, /playAction\('move', soundSet\.current\)/, 'the alert is still the move chime')
  assert.match(app, /\}, \[anySoon\]\)/, 'and its effect depends on nothing but that')
})

rmSync(out, { recursive: true, force: true })
console.log(`\n${n} checks passed`)
