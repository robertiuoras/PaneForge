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
  humanMins,
  clampSpot,
  bubbleSpot,
  countdownWords,
  CLOSE_COUNTDOWN_MS,
  KEEP_MINUTES,
  DEFAULT_MASCOT
} =
  createRequire(import.meta.url)(outfile)

// The sprite itself. It is data rather than drawing code, which is the only reason it can
// be checked at all without a window.
const spriteFile = join(work, 'sprite.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/botSprite.ts'],
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
    check('and it names that pane rather than counting', /pane 2/.test(one.say), one.say)
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
  // It arrives silent. The app's standing law is that nothing it decided itself may take
  // the screen, and a voice is that intrusion through the other sense.
  eq('the mascot is on', DEFAULT_MASCOT.enabled, true)
  eq('and mute', DEFAULT_MASCOT.voice, false)
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
  const { ALL_LAYERS, GRID, CLASS_OF, ARMS, TREADS, ANTENNA, BEACON, EYES, BODY, runsOf } = sprite
  let square = true
  let known = true
  for (const layer of ALL_LAYERS) {
    if (layer.length !== GRID) square = false
    for (const row of layer) {
      if (row.length !== GRID) square = false
      for (const c of row) if (c !== '.' && !(c in CLASS_OF)) known = false
    }
  }
  eq('every layer is a square grid', square, true)
  eq('and uses no colour the stylesheet has never heard of', known, true)

  // Standing still is not one frame: three arm heights, two tread poses, two antenna
  // poses, two beacon states and two visor positions, each on its own clock. A pose
  // identical to another is dead art that reads as a still picture.
  const distinct = (o) => new Set(Object.values(o).map((a) => a.join('|'))).size
  eq('the arms settle over three drawings', distinct(ARMS), 3)
  eq('the treads tick between two', distinct(TREADS), 2)
  eq('the antenna has two poses', distinct(ANTENNA), 2)
  eq('the beacon two', distinct(BEACON), 2)
  eq('and the visor two', distinct(EYES), 2)

  // Runs, not cells: the whole point of the walk is that a row of eight identical cells is
  // one rect. A per-cell version passes every other check here and quadruples the DOM.
  const rects = runsOf(BODY)
  eq('the chassis is drawn as runs', rects.length < 90, true)
  eq('and every run has width', rects.every((r) => r.w >= 1), true)
  const widest = Math.max(...rects.map((r) => r.w))
  eq('with at least one long one', widest >= 6, true)
  eq('and none off the grid', rects.every((r) => r.x + r.w <= GRID && r.y < GRID), true)

  // A pose defined and never drawn is dead art nobody will notice for a year. Every one of
  // them has to appear in the component that draws the sprite.
  const drawn = readFileSync(join(root, 'src/renderer/src/components/Mascot.tsx'), 'utf8')
  const missing = [
    ...Object.keys(ARMS).map((k) => `ARMS.${k}`),
    ...Object.keys(TREADS).map((k) => `TREADS.${k}`),
    ...Object.keys(ANTENNA).map((k) => `ANTENNA.${k}`),
    ...Object.keys(BEACON).map((k) => `BEACON.${k}`),
    ...Object.keys(EYES).map((k) => `EYES.${k}`)
  ].filter((ref) => !drawn.includes(ref))
  eq('every pose is drawn', missing.join(',') || 'none', 'none')

  // ...and the stylesheet has to carry a rule for each of the classes the drawing hangs the
  // animation on, or a pose is on screen for ever or never.
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  const classless = [
    'm-arm-a', 'm-arm-b', 'm-arm-c',
    'm-treads-a', 'm-treads-b',
    'm-antenna', 'm-antenna-tilt', 'm-beacon-on',
    'm-eye-ahead', 'm-eye-look', 'm-lid',
    'm-shell', 'm-shell-d', 'm-shell-l', 'm-visor'
  ].filter((c) => !css.includes(`.${c}`))
  eq('and every layer has a rule', classless.join(',') || 'none', 'none')

  // IT DOES NOT FLOAT. The old sprite bobbed on a 4.2s `translateY` loop and that is the
  // first thing anybody said about it, so a vertical loop coming back is a regression and
  // not a taste change. The sprite still MOVES - it walks to the card of the pane it is
  // talking about - but that is a `left`/`top` transition on the layer, not a loop on the
  // drawing, and it is a sentence rather than scenery.
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
  check('and keeping a pane holds for an hour', KEEP_MINUTES >= 30, KEEP_MINUTES)
}

console.log(`mascot: ${checks} checks passed`)
