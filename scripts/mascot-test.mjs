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
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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
const {
  parse,
  notice,
  closeable,
  isDestructive,
  paneLine,
  paneWord,
  paneDoing,
  actedWords,
  agoWords,
  hideAfterMs,
  HIDE_SECONDS,
  humanMins,
  clampSpot,
  bubbleSpot,
  countdownWords,
  CLOSE_COUNTDOWN_MS,
  MIN_COUNTDOWN_MS,
  countdownEnd,
  KEEP_MINUTES,
  DEFAULT_MASCOT,
  dueDash,
  DASH_EVERY_MS,
  spriteReserve,
  SPRITE_GAP,
  RESERVE_MAX_FRAC
} =
  createRequire(import.meta.url)(outfile)

// The sprite itself. It is data rather than drawing code, which is the only reason it can
// be checked at all without a window.
const spriteFile = join(work, 'sprite.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/pets.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: spriteFile
})
const sprite = createRequire(import.meta.url)(spriteFile)

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
  asking: false,
  ...o
})

// A desk that looks like this one: something working, something finished, something the
// agent asked a question in, a mirror of the other machine - and, the case this whole
// module got wrong for weeks, a pane whose agent FINISHED a turn.
//
// `fleetState` calls that last one `needsYou`, the same word it uses for the pane holding
// a live question, so a rule written against the state refused both. On a real desk nearly
// every pane is that pane, which is why "close the idle ones" answered "nothing quiet
// enough to close" while eleven finished agents sat there holding 190 MB each. `asking` is
// the fact that actually separates them, and it comes from the pane's own question.
const desk = [
  pane({ id: 'a', pane: 1, name: 'PaneForge', state: 'working', memMb: 240, idleMs: 0 }),
  pane({ id: 'b', pane: 2, name: 'taskdriver', state: 'ready', memMb: 2100, idleMs: 3 * 60 * MIN }),
  pane({ id: 'c', pane: 3, name: 'assistant', state: 'ready', memMb: 1900, idleMs: 2 * 60 * MIN }),
  pane({ id: 'd', pane: 4, name: 'secondtonone', state: 'needsYou', asking: true, memMb: 300, idleMs: 90 * MIN }),
  pane({ id: 'e', pane: 5, name: 'crypto', state: 'ready', memMb: 180, idleMs: 5 * MIN, remote: true }),
  pane({ id: 'f', pane: 6, name: 'inbox-ops', state: 'needsYou', memMb: 900, idleMs: 4 * 60 * MIN })
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
  check('and says how many there are', /6 panes/.test(i.say), i.say)
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
  eq('and it is exactly the finished, local, quiet ones', i.ids.sort().join(','), 'b,c,f')
  check('a finished turn is one of them', i.ids.includes('f'), i.ids)
  check('and the pane holding a question is not', !i.ids.includes('d'), i.ids)
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
  eq('a count is read as a count', i.ids.sort().join(','), 'b,c,f')
}

{
  const i = parse('memory', desk)
  eq('memory is a report', i.kind, 'report')
  check('it totals the desk', /6 panes/.test(i.say), i.say)
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
  eq(
    'closeable skips working, mirrors and a live question - and KEEPS a finished turn',
    closeable(desk).map((p) => p.id).sort().join(','),
    'b,c,f'
  )
}

{
  // The unasked notice. It fires here: two finished panes, hours quiet, 4 GB between them.
  const n = notice(desk, { idleCloseOn: false })
  check('it speaks when idle panes hold real memory', !!n, n)
  eq('and offers the close as a press, never a fait accompli', n.action.kind, 'close')
  eq('over exactly the stale ones', n.action.ids.sort().join(','), 'b,c,f')
  check('the key is stable so it is said once', n.key === notice(desk, { idleCloseOn: false }).key)
  check('it walks to the pane it is about', desk.some((p) => p.id === n.about))
}

{
  // The three ways it must stay quiet. Each one alone is what turns a mascot into noise.
  eq('silent when the app already has a clock for this', notice(desk, { idleCloseOn: true }), null)
  // ...and the way it must NOT. Two stale panes was the old floor, and it was set while
  // `closeable` could not see a finished pane at all - so between the two rules this had
  // never once fired on a real desk. One finished agent is 190 MB whether it has company
  // or not, and a mascot that will not mention that is a mascot with nothing to say.
  {
    const one = notice([desk[0], desk[1]], { idleCloseOn: false })
    check('one stale pane is still worth a sentence', !!one && one.action.ids.join(',') === 'b', one)
    check('and it names that pane rather than counting', /\(2\)/.test(one.say), one.say)
  }
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
  // It arrives OFF, and silent. A pet is the one thing in this app that is decoration
  // before it is a reading, so it is asked for rather than arrived with - and the switch
  // that turns it on is beside the ten it can be. A config written while it was on by
  // default carries `enabled: true` explicitly and is untouched by this.
  eq('the mascot is off until somebody asks for one', DEFAULT_MASCOT.enabled, false)
  eq('and mute', DEFAULT_MASCOT.voice, false)
  eq('and it is the robot unless another is picked', DEFAULT_MASCOT.pet, 'bot')
  // ...and where the APP put it, not where a person did. A spot is only ever written by a
  // drag, so an unpinned mascot is what every desk that has not moved it still gets.
  eq('and unpinned', DEFAULT_MASCOT.spot ?? null, null)
}

{
  // A dropped sprite stays in the window. The pointer can leave it (a capture keeps the
  // events coming from off-screen), and a fraction outside 0..1 is a mascot nobody can
  // reach again - there is no way back to something drawn past the edge.
  eq('a drop inside is kept', clampSpot(0.4, 0.6).x, 0.4)
  eq('and its other half', clampSpot(0.4, 0.6).y, 0.6)
  eq('off the right edge comes back', clampSpot(1.4, 0.5).x, 0.98)
  eq('off the top comes back', clampSpot(0.5, -3).y, 0.02)
  eq('and a reading that is not a number is centred', clampSpot(NaN, 0.5).x, 0.5)
}

{
  // The sprite is a grid, and a row one cell short does not draw a wonky fox - it shifts
  // every colour after it left on that row, which reads as corruption rather than as a
  // typo. Nothing in the drawing code can notice; this is where it is caught.
  const { PETS, GRID, CLASS_OF, layersOf, petFor, runsOf } = sprite
  eq('there are ten pets', PETS.length, 10)
  eq('and no two share an id', new Set(PETS.map((p) => p.id)).size, PETS.length)
  eq('an id nothing answers falls back rather than drawing nothing', petFor('nope').id, PETS[0].id)

  // Every layer of every pet is a square grid, and a row one cell short does not draw a
  // wonky pet - it shifts every colour after it left on that row, which reads as
  // corruption rather than as a typo. Nothing in the drawing code can notice; this is
  // where it is caught.
  let square = 'none'
  let known = 'none'
  for (const pet of PETS) {
    for (const layer of layersOf(pet)) {
      if (layer.length !== GRID) square = pet.id
      for (const row of layer) {
        if (row.length !== GRID) square = pet.id
        for (const c of row) if (c !== '.' && !(c in CLASS_OF)) known = `${pet.id}:${c}`
      }
    }
  }
  eq('every layer of every pet is a square grid', square, 'none')
  eq('and uses no colour the stylesheet has never heard of', known, 'none')

  // A pet standing still is not one frame, and a pose identical to its neighbour is dead
  // art that reads as a still picture. A pet is allowed to leave a slot OUT - it is simply
  // stiller - but a slot it declares has to move.
  const dead = []
  for (const pet of PETS) {
    const a = pet.art
    const distinct = (arr) => new Set(arr.map((x) => x.join('|'))).size
    if (a.arms && distinct([a.arms.a, a.arms.b, a.arms.c]) !== 3) dead.push(`${pet.id}.arms`)
    if (a.treads && distinct([a.treads.a, a.treads.b]) !== 2) dead.push(`${pet.id}.treads`)
    if (a.antenna && distinct([a.antenna.mast, a.antenna.tilt]) !== 2) dead.push(`${pet.id}.antenna`)
    if (a.beacon && distinct([a.beacon.on, a.beacon.off]) !== 2) dead.push(`${pet.id}.beacon`)
    if (a.eyes && distinct([a.eyes.ahead, a.eyes.look]) !== 2) dead.push(`${pet.id}.eyes`)
    // ...and a pet that declares nothing at all is a picture, not a pet.
    if (!a.arms && !a.treads && !a.antenna && !a.beacon && !a.eyes) dead.push(`${pet.id}.still`)
    // A blink is a shutter over the eyes: a pet with eyes and no blink stares for ever.
    if (a.eyes && !a.blink) dead.push(`${pet.id}.blink`)
  }
  eq('and every pose a pet declares really moves', dead.join(',') || 'none', 'none')

  // Runs, not cells: the whole point of the walk is that a row of eight identical cells is
  // one rect. A per-cell version passes every other check here and quadruples the DOM.
  for (const pet of PETS) {
    const rects = runsOf(pet.art.body)
    check(`${pet.id} is drawn as runs`, rects.length < 110, rects.length)
    check(`${pet.id} keeps every run on the grid`, rects.every((r) => r.x + r.w <= GRID && r.y < GRID), pet.id)
  }

  // A SLOT defined and never drawn is dead art nobody will notice for a year. The drawing
  // is generic now - one component for ten pets - so what is checked is that every slot
  // the art can carry has a branch in the component that draws it.
  const drawn = readFileSync(join(root, 'src/renderer/src/components/Mascot.tsx'), 'utf8')
  const missing = ['A.arms', 'A.treads', 'A.antenna', 'A.beacon', 'A.eyes', 'A.blink', 'A.body']
    .filter((ref) => !drawn.includes(ref))
  eq('every slot is drawn', missing.join(',') || 'none', 'none')

  // ...and the stylesheet has to carry a rule for each of the classes the drawing hangs the
  // animation on, or a pose is on screen for ever or never.
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  const classless = [
    'm-arm-a', 'm-arm-b', 'm-arm-c',
    'm-treads-a', 'm-treads-b',
    'm-antenna', 'm-antenna-tilt', 'm-beacon-on',
    'm-eye-ahead', 'm-eye-look', 'm-lid',
    'm-shell', 'm-shell-d', 'm-shell-l', 'm-visor', 'm-accent'
  ].filter((c) => !css.includes(`.${c}`))
  eq('and every layer has a rule', classless.join(',') || 'none', 'none')

  // The dash. It is the one thing a pet does that is not a reading, so every refusal is
  // load-bearing: the negatives here are the test, not the positive.
  const ready = { enabled: true, roam: true, pinned: false, saying: false, visible: true, sinceMs: DASH_EVERY_MS }
  check('a pet with nothing to say runs', dueDash(ready), ready)
  check('one that is talking does not', !dueDash({ ...ready, saying: true }), 'saying')
  check('nor one somebody put somewhere', !dueDash({ ...ready, pinned: true }), 'pinned')
  check('nor one behind a minimised window', !dueDash({ ...ready, visible: false }), 'hidden')
  check('nor one with roam off', !dueDash({ ...ready, roam: false }), 'roam')
  check('nor one that ran a moment ago', !dueDash({ ...ready, sinceMs: 1000 }), 'too soon')
  check('and never one that is switched off', !dueDash({ ...ready, enabled: false }), 'off')

  // IT DOES NOT FLOAT. The first sprite bobbed on a 4.2s `translateY` loop and that is the
  // first thing anybody said about it, so a vertical loop coming back is a regression and
  // not a taste change. The sprite still MOVES - it walks to the card of the pane it is
  // talking about, and every so often it runs along the bottom - but both of those are a
  // `left`/`top` transition on the layer, not a loop on the drawing.
  const spriteCss = css.slice(css.indexOf('---- the mascot'))
  check('the sprite has no vertical loop left in it', !/translateY/.test(spriteCss), 'translateY')
  check('and no bob keyframes', !/mascot-bob/.test(css), 'mascot-bob')
}

{
  // Where the bubble goes. This is the whole of the "the chatbox is off screen, and so is
  // the fox" bug: it used to be a flex CHILD of the sprite's box, which is centred on the
  // spot, so saying anything widened that box by a bubble and moved the fox half a bubble
  // sideways - and at the fox's own default corner (x = 0.06) the left half of the words
  // was simply outside the window. The placer is in shared/ so it can be checked with no
  // window at all, and every case below is one a real desk produces.
  const vw = 1400
  const vh = 900
  const at = (fx, fy, w = 300, h = 90) =>
    bubbleSpot({ cx: fx * vw, cy: fy * vh, sprite: 48, width: w, height: h, vw, vh })

  const home = at(0.06, 0.86)
  check('a bubble at the fox home corner starts on screen', home.left >= 0, home.left)
  check('and ends on screen', home.left + home.width <= vw, home.left + home.width)
  check('and is above the fox there', home.above, home)

  const right = at(0.97, 0.5)
  check('one at the right edge is pulled back in', right.left + right.width <= vw, right)

  // The one it cannot get right by clamping alone: a fox near the TOP has no room above,
  // so the bubble has to change sides rather than sit on the sprite.
  const top = at(0.5, 0.02)
  check('a fox at the top gets its bubble below it', !top.above, top)
  check('and never above the window', top.top >= 0, top.top)

  // A tall bubble in a short window fits nowhere - it must still be readable from the top
  // rather than clamped over the fox.
  const tall = bubbleSpot({ cx: 700, cy: 300, sprite: 48, width: 300, height: 700, vw, vh: 400 })
  check('a bubble taller than the window starts on screen', tall.top >= 0, tall.top)

  // A narrow window: the max is the WINDOW's, never the message's.
  const narrow = bubbleSpot({ cx: 100, cy: 300, sprite: 48, width: 0, height: 80, vw: 220, vh: 700 })
  check('a narrow window caps the width', narrow.max <= 200, narrow.max)
  check('and still starts on screen', narrow.left >= 0, narrow.left)
}

{
  // The countdown. It is the answer to "the app closed a pane and the only record was a
  // console line nobody has open": the sentence names the pane, says how long is left, and
  // says what closing costs - which here is nothing, because History reopens the
  // conversation AND the screen.
  const w = countdownWords(['pane 2 (taskdriver)'], 7400, 'idle')
  check('it counts in whole seconds', /in 8s/.test(w), w)
  check('and names the pane', /pane 2 \(taskdriver\)/.test(w), w)
  check('and says nothing is lost', /History/.test(w), w)
  const many = countdownWords(['pane 2 (a)', 'pane 3 (b)'], 1200, 'pressure')
  check('several panes are counted and named', /2 panes/.test(many) && /pane 3 \(b\)/.test(many), many)
  check('and the reason is the one that triggered it', /out of memory/.test(many), many)
  eq('a deadline already passed reads as zero', /in 0s/.test(countdownWords(['x'], -50, 'idle')), true)

  // Both numbers are the feature. A count too short to read is a close with a flicker in
  // front of it, and a "keep it open" that expires in a minute is the same question again
  // sixty seconds later, for ever - which is what gets a feature switched off.
  check('the count is long enough to read and reach', CLOSE_COUNTDOWN_MS >= 10_000, CLOSE_COUNTDOWN_MS)
  // A keep is measured against the clock it silences: comfortably longer than
  // `IDLE_CLOSE_MINUTES` (5 - written out here because this file loads its subject through
  // esbuild and cannot import a second shared module), and short enough that the card is
  // still a clock somebody can act on. An hour beside a five-minute deadline drew
  // `closes 60m` on a pane whose real deadline was five.
  check(
    'and keeping a pane holds well past the idle clock, without becoming an afternoon',
    KEEP_MINUTES >= 10 && KEEP_MINUTES <= 15,
    KEEP_MINUTES
  )

  // The other thing the ladder does by itself, and the one that had no countdown at all:
  // a pane MOVED to the other machine. `runHandoffs` reported into a console nobody has
  // open, so a pane left the desk with nothing on screen saying so - while a close, the
  // more recoverable of the two, counted down and could be stopped.
  const moved = countdownWords(['taskdriver pane 1'], 12_000, 'pressure', 'Desk PC')
  check('a move counts down like a close', /in 12s/.test(moved), moved)
  check('and says it is a move, not a close', /^Moving /.test(moved) && !/Closing/.test(moved), moved)
  // Where it went is the one fact that cannot be recovered from this screen afterwards.
  check('and names the machine it is going to', /Desk PC/.test(moved), moved)
  // A mid-turn pane is queued by the far end rather than killed, and the sentence has to
  // say so or the press reads as "lose the answer being written".
  check('and says a mid-turn pane travels when the turn ends', /turn ends/.test(moved), moved)
  // The control: with no device named nothing about the old sentence may change.
  const closing = countdownWords(['taskdriver pane 1'], 12_000, 'pressure')
  check('a close still reads exactly as it did', /^Closing /.test(closing) && !/Moving/.test(closing), closing)
}

{
  // The most obvious opening sentence anybody types, and the one question the pet could
  // not answer: everything else here needs a pane named or described first, so "what is
  // open" fell through to "I only know this machine".
  const all = parse('what is open', desk)
  eq('the whole desk is an answer', all.kind, 'report')
  eq('...covering every pane', all.ids.length, desk.length)
  check('...and it counts them', /panes/.test(all.say), all.say)
  eq('an empty desk says so rather than reporting nothing', parse('what is open', []).kind, 'say')

  // A pane NUMBER beside a dev server is which SERVER, not an offer to close the pane.
  // Answering "stop the dev server in pane 2" with "close pane 2?" is the app offering the
  // larger of the two things it was asked for.
  const devs = [
    { pid: 41, pane: 2, label: 'dev', port: 3000, where: 'taskdriver' },
    { pid: 42, pane: 5, label: 'dev', port: 3007, where: 'crypto' }
  ]
  const inPane = parse('stop the dev server in pane 2', desk, devs)
  eq('a dev server is stopped, not a pane', inPane.kind, 'stopDev')
  eq('...and it is the one in that pane', inPane.pids.join(','), '41')
  // The control: the same sentence with no server in it is still about the pane.
  eq('a pane with no server in the sentence is still a pane', parse('close pane 2', desk).kind, 'close')
  // Two servers and nothing to separate them is a question, never a guess.
  eq('...and an ambiguous one asks', parse('stop the dev server', desk, devs).kind, 'say')
}

{
  // Which pane, and what it was in the middle of. "Closed a pane, about 190 MB back" is
  // the sentence this replaces: it names neither the conversation that went nor when, and
  // both are the only things somebody wants when a pane they were using is not there.
  const p = pane({ pane: 1, name: 'taskdriver', doing: 'fix the login redirect' })
  eq('the number leads, then the place', paneWord(p), '(1) taskdriver')
  check('and the subject rides with it', /was working on "fix the login redirect"/.test(paneDoing(p)), paneDoing(p))
  // Never invented. A pane nobody has typed a real ask into is named and nothing more.
  eq('a pane with no recorded ask says nothing about one', paneDoing(pane({ pane: 4, name: 'vrb' })), '(4) vrb')

  // Which COPY of the project. Three lanes of one repo were three panes all called
  // `PaneForge`, so a sentence about one of them was equally true of the other two - the
  // one fact that separates them was the only one left out.
  eq(
    'a lane is named as well as the project',
    paneWord(pane({ pane: 3, name: 'PaneForge', where: 'lane a' })),
    '(3) PaneForge lane a'
  )
  // ...and a trunk pane is NOT given "main checkout": `place.ts`'s own rule is that a bare
  // project name already means the project's own checkout, and adding it to every sentence
  // is two words that say nothing on the common case.
  eq(
    'and a trunk pane is left alone',
    paneWord(pane({ pane: 3, name: 'PaneForge', where: '' })),
    '(3) PaneForge'
  )
  // Reading back its own sentence has to work, or "close (3) PaneForge lane a" - which is
  // the exact string the pet just printed - is a pane it cannot find.
  {
    const back = parse('close (3) PaneForge lane a', [pane({ id: 'p3', pane: 3, name: 'PaneForge' })])
    eq('the bracketed number it prints is a number it can read', back.kind, 'close')
    eq('...and it is that pane', back.ids.join(','), 'p3')
  }

  const one = actedWords('closed', [{ word: paneWord(p), doing: p.doing }], 190, 3 * MIN)
  check('a close names the pane', /\(1\) taskdriver/.test(one), one)
  check('...says what it was working on', /login redirect/.test(one), one)
  check('...says how long ago', /3 min ago/.test(one), one)
  check('...and still says what it gave back', /190 MB/.test(one), one)
  check('and that nothing is lost', /History/.test(one), one)

  // Several go on their own lines: the whole point is WHICH conversations went, and four
  // of them comma-joined into one sentence is a paragraph nobody reads in a corner bubble.
  const many = actedWords(
    'closed',
    [
      { word: '(1) taskdriver', doing: 'fix the login redirect' },
      { word: '(4) PaneForge lane a', doing: 'the mascot bubble' }
    ],
    380,
    45_000
  )
  check('several panes are counted', /2 panes/.test(many), many)
  check('...listed one per line', many.split('\n').length === 3, many)
  check('...and named', /\(4\) PaneForge lane a/.test(many) && /\(1\) taskdriver/.test(many), many)

  // A subject long enough to be a paragraph is cut rather than allowed to fill the window.
  // The report afterwards names the machine too - `where` is optional, so a caller that
  // does not know it still gets the sentence this had before.
  const movedTo = actedWords('moved', [{ word: 'taskdriver pane 1' }], undefined, 0, 'Desk PC')
  check('a move is reported with the machine named', /Moved/.test(movedTo) && /Desk PC/.test(movedTo), movedTo)
  check('and says the pane is still on screen as a mirror', /mirror/.test(movedTo), movedTo)
  const movedAnon = actedWords('moved', [{ word: 'taskdriver pane 1' }])
  check('an unnamed machine still reports the move', /paired device/.test(movedAnon), movedAnon)

  const long = actedWords('closed', [{ word: 'x pane 1', doing: 'a'.repeat(400) }], 10, 0)
  check('a very long ask is cut', long.length < 260, long.length)
}

{
  // How long ago, said the way somebody says it. Below a minute it rounds to five seconds:
  // a number changing every second in the corner of an eye is motion, not information.
  eq('a moment ago reads as just now', agoWords(4000), 'just now')
  eq('half a minute is seconds', agoWords(31_000), '30s ago')
  eq('a few minutes is minutes', agoWords(3 * MIN), '3 min ago')
  check('hours are hours', /h/.test(agoWords(150 * MIN)), agoWords(150 * MIN))
  eq('and a negative clock never prints one', agoWords(-5000), 'just now')
}

{
  // The bubble takes itself away. A config written before this existed never chose, so it
  // gets the default rather than 0 - an absent field reading as "never hide" would leave
  // every existing desk exactly as it was and the setting would look like it did nothing.
  eq('an old config gets the default', hideAfterMs({}), HIDE_SECONDS * 1000)
  eq('a minute is a minute', hideAfterMs({ hideSeconds: 60 }), 60_000)
  eq('zero means until it is pressed away', hideAfterMs({ hideSeconds: 0 }), 0)
  eq('a silly small number is held to the floor', hideAfterMs({ hideSeconds: 1 }), 5000)
  eq('and a silly large one to the ceiling', hideAfterMs({ hideSeconds: 99_999 }), 3_600_000)
  eq('junk reads as the default', hideAfterMs({ hideSeconds: Number.NaN }), HIDE_SECONDS * 1000)

  // The load-bearing half: a hide that also took the COUNTDOWN away would pass every check
  // above and would remove the one press that stops a pane being closed. It is a source
  // assertion because the exemption is a guard in an effect, not arithmetic.
  const drawn = readFileSync(join(root, 'src/renderer/src/components/Mascot.tsx'), 'utf8')
  check(
    'the hide timer stands down for a countdown',
    /const ms = hideAfterMs\(cfg\)\r?\n\s*if \(!ms \|\| soon\) return/.test(drawn),
    'the hide effect must return early while `soon` is set'
  )
  check(
    'and it restarts while somebody is typing at it',
    /\}, \[bubble\?\.key, open, typing, cfg\.hideSeconds, soon\]\)/.test(drawn),
    'typing must be a dependency of the hide timer'
  )
  check(
    'the acted sentence is rebuilt as it is drawn, not stored',
    // `\s*`: the call wraps once it carries the machine the pane moved to.
    /actedWords\(\s*bubble\.acted\.what/.test(drawn),
    'the bubble must re-render its "ago" rather than keeping the string it was said with'
  )
}

{
  // The rung above the close. With the handoff on and a device online these panes are
  // going to MOVE, so offering to close them is the app asking to do the worse of the two
  // things it had already decided to do better.
  const stale = [
    pane({ id: 'a', state: 'ready', idleMs: 90 * 60_000, memMb: 300 }),
    pane({ id: 'b', state: 'ready', idleMs: 90 * 60_000, memMb: 300 })
  ]
  check('it offers to close idle panes when nothing else will', notice(stale, { idleCloseOn: false }) !== null)
  eq('and says nothing when the handoff is going to move them', notice(stale, { idleCloseOn: false, willMove: true }), null)
}

{
  // What a pane must keep clear so the sprite covers no drawn line. The measurements are
  // this desk's own: window 1335x872, one pane's `.xterm-screen` at 299,58 -> 1312,868,
  // and the sprite 48px at 6%/83% of the window - 56,726 -> 104,774.
  const screen = { left: 299, top: 58, right: 1312, bottom: 868 }
  const sprite = { left: 56, top: 726, right: 104, bottom: 774 }
  eq('a sprite over the sidebar costs the pane nothing', spriteReserve(sprite, screen), 0)
  eq('no mascot at all costs nothing', spriteReserve(null, screen), 0)

  // The same sprite once the sidebar is hidden and the pane reaches the window edge.
  const wide = { left: 8, top: 58, right: 1312, bottom: 868 }
  eq(
    'standing in a pane, the rows stop above it',
    spriteReserve(sprite, wide),
    868 - 726 + SPRITE_GAP
  )
  check(
    'and the reserve really does clear the sprite',
    wide.bottom - spriteReserve(sprite, wide) <= sprite.top
  )
  // A terminal gives rows back, never pixels: 146px of a 15px grid is nine rows and a
  // remainder, and keeping the remainder left the last line 2px inside the sprite in a
  // real window. The control is that the unrounded answer really would have failed.
  eq('a reserve is rounded up to a whole row', spriteReserve(sprite, wide, 15) % 15, 0)
  check(
    'and the rounded reserve clears the sprite where the raw one did not',
    wide.bottom - spriteReserve(sprite, wide, 15) <= sprite.top
  )

  // The refusals, which are the half that keeps this from eating somebody's pane.
  eq(
    'a sprite below the last row reserves nothing',
    spriteReserve({ left: 8, top: 900, right: 56, bottom: 948 }, wide),
    0
  )
  eq(
    'a sprite dragged high in a pane reserves nothing rather than half the pane',
    spriteReserve({ left: 8, top: 200, right: 56, bottom: 248 }, wide),
    0
  )
  // The control for that refusal: the same sprite one pixel inside the cap is taken.
  const cap = Math.floor(wide.bottom - (wide.bottom - wide.top) * RESERVE_MAX_FRAC) + SPRITE_GAP + 1
  check(
    'a sprite just inside the cap is still cleared',
    spriteReserve({ left: 8, top: cap, right: 56, bottom: cap + 48 }, wide) > 0
  )
  eq(
    'a pane with no height on screen reserves nothing',
    spriteReserve(sprite, { left: 8, top: 58, right: 1312, bottom: 58 }),
    0
  )
}

// The countdown ends when the CARD said it would, so the number only ever goes down.
{
  const NOWC = 1_000_000
  eq(
    'a pane due in eleven seconds counts eleven, not fifteen',
    countdownEnd(NOWC, [NOWC + 11_000]) - NOWC,
    11_000
  )
  eq(
    'a pane due in three seconds is pushed out to something readable',
    countdownEnd(NOWC, [NOWC + 3_000]) - NOWC,
    MIN_COUNTDOWN_MS
  )
  eq(
    'a pane already overdue gets the whole count rather than none',
    countdownEnd(NOWC, [NOWC - 90_000]) - NOWC,
    CLOSE_COUNTDOWN_MS
  )
  eq('and a plan with no deadline at all is the same', countdownEnd(NOWC, [undefined]) - NOWC, CLOSE_COUNTDOWN_MS)
  eq(
    'never longer than the count: the latest deadline wins but is capped',
    countdownEnd(NOWC, [NOWC + 5_000, NOWC + 900_000]) - NOWC,
    CLOSE_COUNTDOWN_MS
  )
  check('the countdown can never end before it can be read', MIN_COUNTDOWN_MS <= CLOSE_COUNTDOWN_MS)
}

console.log(`mascot: ${checks} checks passed`)
