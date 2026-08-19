// What the mascot is allowed to do to somebody's panes.
//
// The bubble and the walk are decoration; this file is about the two things that can cost
// somebody work. A mascot that CLOSES a pane on a guessed match is worse than no mascot,
// and one that volunteers a suggestion every four seconds is one nobody reads by lunchtime.
// So the weight here is in the negatives: a number that names no pane, a word that half
// matches a project, a pane that is working or waiting for a person, another machine's
// pty, and a notice that must stay quiet because the app is already handling it.
//
//   node scripts/mascot-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-mascot-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'mascot.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/mascot.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { parse, notice, closeable, isDestructive, paneLine, humanMins, DEFAULT_MASCOT } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const MIN = 60_000
const pane = (o) => ({
  id: 'p',
  pane: 1,
  name: 'PaneForge',
  state: 'ready',
  memMb: 200,
  idleMs: 0,
  remote: false,
  ...o
})

// A desk that looks like this one: something working, something finished, something the
// agent asked a question in, and a mirror of the other machine.
const desk = [
  pane({ id: 'a', pane: 1, name: 'PaneForge', state: 'working', memMb: 240, idleMs: 0 }),
  pane({ id: 'b', pane: 2, name: 'taskdriver', state: 'ready', memMb: 2100, idleMs: 3 * 60 * MIN }),
  pane({ id: 'c', pane: 3, name: 'assistant', state: 'ready', memMb: 1900, idleMs: 2 * 60 * MIN }),
  pane({ id: 'd', pane: 4, name: 'secondtonone', state: 'needsYou', memMb: 300, idleMs: 90 * MIN }),
  pane({ id: 'e', pane: 5, name: 'crypto', state: 'ready', memMb: 180, idleMs: 5 * MIN, remote: true })
]

{
  // The ordinary thing somebody types. The number is the same one the sidebar prints and
  // the same one Ctrl+N reaches, which is why the mascot answers on it at all.
  const i = parse('close pane 2', desk)
  eq('close pane 2 is a close', i.kind, 'close')
  eq('close pane 2 picks exactly one', i.ids.join(','), 'b')
  check('a close is destructive', isDestructive(i))
  check('it says what is lost - nothing', /History/.test(i.say), i.say)
}

{
  // Same sentence in the other four wordings a person really uses.
  for (const s of ['close session 2', 'kill pane 2', 'close #2', 'close 2']) {
    const i = parse(s, desk)
    eq(`"${s}" closes pane 2`, i.kind === 'close' ? i.ids.join(',') : i.kind, 'b')
  }
}

{
  // THE refusal. Eight panes open and a typo naming a ninth must not resolve to the
  // nearest one - that is somebody's session for the price of a slipped finger.
  const i = parse('close pane 9', desk)
  eq('a pane that is not open closes nothing', i.kind, 'say')
  check('and says how many there are', /5 panes/.test(i.say), i.say)
}

{
  // A pane on the other machine. Closing it here frees nothing here and the pty is not
  // ours to end, so it is named and refused rather than silently skipped.
  const i = parse('close crypto', desk)
  eq('a mirrored pane is refused', i.kind, 'say')
  check('and says where it lives', /another machine/.test(i.say), i.say)
}

{
  // "the idle ones" is a description, not a name, and it must resolve through the same
  // refusals reclaim.ts uses: the working pane and the one holding a question stay.
  const i = parse('close the idle ones', desk)
  eq('idle ones is a close', i.kind, 'close')
  eq('and it is exactly the finished, local, quiet ones', i.ids.sort().join(','), 'b,c')
}

{
  // The question he actually asked out loud: which are the two big ones.
  const i = parse('what are the two biggest', desk)
  eq('biggest is a report, never a close', i.kind, 'report')
  eq('two of them, in size order', i.ids.join(','), 'b,c')
  check('with the readings in the words', /2\.1 GB|2100 MB/.test(i.say), i.say)
}

{
  // A report may never become an action. This is the line between "tell me" and "do it".
  const i = parse('what is pane 3', desk)
  eq('what is pane 3 reports', i.kind, 'report')
  check('a report is not destructive', !isDestructive(i))
}

{
  const i = parse('hand off pane 3', desk)
  eq('hand off is its own intent', i.kind, 'handoff')
  eq('on the pane named', i.ids.join(','), 'c')
  check('handoff is destructive too - it ends the pty here', isDestructive(i))
}

{
  // A name is matched longest-first so a short one cannot win inside a longer one.
  const two = [pane({ id: 'x', pane: 1, name: 'service' }), pane({ id: 'y', pane: 2, name: 'service-a' })]
  const i = parse('close service-a', two)
  eq('the longer name wins its own sentence', i.kind === 'close' ? i.ids.join(',') : i.kind, 'y')
}

{
  // A count is not a pane number. "close the 2 idle ones" must not become "close pane 2".
  const i = parse('close the 2 idle ones', desk)
  eq('a count is read as a count', i.ids.sort().join(','), 'b,c')
}

{
  const i = parse('memory', desk)
  eq('memory is a report', i.kind, 'report')
  check('it totals the desk', /5 panes/.test(i.say), i.say)
  check('and names the top few', i.ids.length <= 3 && i.ids[0] === 'b', i.ids)
}

{
  // A description it understood but that matched nothing is not the same as a sentence it
  // could not read, and answering both with "I did not understand" throws away the half
  // that was right - measured in a real window, on a desk with no panes open.
  const none = parse('what are the two biggest', [])
  eq('a description on an empty desk says so', none.kind, 'say')
  check('and does not claim to be confused', /No panes open/.test(none.say), none.say)
  const cold = parse('close the idle ones', [pane({ state: 'working', idleMs: 0 })])
  check('nothing quiet enough is its own answer', /Nothing quiet enough/.test(cold.say), cold.say)
}

{
  eq('an empty line asks rather than acts', parse('   ', desk).kind, 'say')
  eq('and so does something it cannot read', parse('write me a poem', desk).kind, 'say')
  check('help lists what it knows', /close the idle ones/.test(parse('help', desk).say))
}

{
  // closeable is the same set reclaim.ts would take, and it is what every suggestion is
  // built from - so the mascot can never OFFER something the sweep itself would refuse.
  eq('closeable skips working, needsYou and mirrors', closeable(desk).map((p) => p.id).sort().join(','), 'b,c')
}

{
  // The unasked notice. It fires here: two finished panes, hours quiet, 4 GB between them.
  const n = notice(desk, { idleCloseOn: false })
  check('it speaks when idle panes hold real memory', !!n, n)
  eq('and offers the close as a press, never a fait accompli', n.action.kind, 'close')
  eq('over exactly the stale ones', n.action.ids.sort().join(','), 'b,c')
  check('the key is stable so it is said once', n.key === notice(desk, { idleCloseOn: false }).key)
  check('it walks to the pane it is about', desk.some((p) => p.id === n.about))
}

{
  // The four ways it must stay quiet. Each one alone is what turns a mascot into noise.
  eq('silent when the app already has a clock for this', notice(desk, { idleCloseOn: true }), null)
  eq(
    'silent for one pane - not worth a sentence',
    notice([desk[0], desk[1]], { idleCloseOn: false }),
    null
  )
  eq(
    'silent when the panes are cheap',
    notice(
      desk.map((p) => ({ ...p, memMb: 40 })),
      { idleCloseOn: false }
    ),
    null
  )
  eq(
    'silent when they are only minutes old',
    notice(
      desk.map((p) => ({ ...p, idleMs: 2 * MIN })),
      { idleCloseOn: false }
    ),
    null
  )
}

{
  // A pane whose memory the sampler has not read yet says so rather than printing 0 MB -
  // a confident zero next to a pane holding 2 GB is the reading nobody would question.
  const l = paneLine(pane({ memMb: null, pane: 7, name: 'x' }))
  check('an unmeasured pane says so', /not measured yet/.test(l), l)
  check('and never invents a number', !/0 MB/.test(l), l)
}

{
  eq('minutes read as minutes', humanMins(45 * MIN), '45 min')
  eq('and hours as hours', humanMins(150 * MIN), '2h 30m')
  eq('with no stray minutes on the hour', humanMins(120 * MIN), '2h')
}

{
  // It arrives silent. The app's standing law is that nothing it decided itself may take
  // the screen, and a voice is that intrusion through the other sense.
  eq('the mascot is on', DEFAULT_MASCOT.enabled, true)
  eq('and mute', DEFAULT_MASCOT.voice, false)
}

console.log(`mascot: ${checks} checks passed`)
