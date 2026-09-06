// How hard a Codex pane thinks: the whole rule, and nothing that needs a window.
//
// The arithmetic is `src/shared/effort.ts` and is tested here directly, the same shape as
// `panemodel-test.mjs`: a main-side file imports its shared sibling extensionless, which
// only the app's own bundler resolves, so a bare `node` run can follow a value import
// into `src/shared` and never into `src/main`.
//
// Two of the fixtures are REAL and that is the point (a fixture without the shape of the
// real file proves nothing):
//   scripts/fixtures/codex-model-list.json   - the `model/list` answer `codex app-server`
//                                              gave on this Mac, codex-cli 0.153.4.
//   scripts/fixtures/codex-rollout-tail.jsonl - the three `turn_context` lines a real
//                                              three-turn conversation wrote, low -> high
//                                              -> medium, trimmed to the fields read here.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const {
  EFFORT_UP,
  EFFORT_DOWN,
  HIGH_HOLD_TURNS,
  PENDING_MAX_MS,
  autoTarget,
  classifyEffort,
  confirmEffort,
  decideBeforeTurn,
  effortChip,
  effortLaunchArgs,
  effortWords,
  ladderFromModelList,
  lastTurnContext,
  lastTurnEffort,
  planEffortKeys
} = await import('../src/shared/effort.ts')

const { buildArgs } = await import('../src/shared/agents.ts')

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

// ---------------------------------------------------------------------------
// The ladder, read from the real app-server answer.

const modelList = JSON.parse(readFileSync(join(here, 'fixtures/codex-model-list.json'), 'utf8'))

t('the real model/list answer gives gpt-6-astra its six levels', () => {
  assert.deepEqual(ladderFromModelList(modelList, 'gpt-6-astra'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ])
})

t('a shorter ladder is read as it stands', () => {
  assert.deepEqual(ladderFromModelList(modelList, 'gpt-5.5'), ['low', 'medium', 'high', 'xhigh'])
})

t('the bare result reads the same as the whole frame', () => {
  assert.deepEqual(
    ladderFromModelList(modelList.result, 'gpt-6-astra'),
    ladderFromModelList(modelList, 'gpt-6-astra')
  )
})

t('a model nobody listed, and rubbish, are undefined - never an empty ladder', () => {
  assert.equal(ladderFromModelList(modelList, 'gpt-9-nope'), undefined)
  assert.equal(ladderFromModelList(null, 'gpt-6-astra'), undefined)
  assert.equal(ladderFromModelList({ data: 'not a list' }, 'gpt-6-astra'), undefined)
  assert.equal(ladderFromModelList(modelList, ''), undefined)
})

t('a plain models[] array of strings reads too', () => {
  assert.deepEqual(
    ladderFromModelList(
      { models: [{ model: 'x-1', supportedReasoningEfforts: ['Low', 'high'] }] },
      'x-1'
    ),
    ['low', 'high']
  )
})

// ---------------------------------------------------------------------------
// The classification table.

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const table = [
  ['Rename the label on the close button', 'low'],
  ['fix the typo in the readme', 'low'],
  ['where is the busy reading done?', 'low'],
  ['show me the config file', 'low'],
  ['list the panes this build knows about', 'low'],
  ['run the linter and fix the indent', 'low'],
  ['bump the version comment', 'low'],
  ['change the wording on that toast', 'low'],
  ['Add the new chip to the session card and wire it to the config', 'medium'],
  ['Implement the change we discussed', 'medium'],
  ['Write a test for the new reader and hook it into the suite', 'medium'],
  ['Move the countdown into its own component', 'medium'],
  ['Why does this intermittent crash still happen after two fixes?', 'high'],
  ['diagnose the flaky test', 'high'],
  ['find the root cause of the deadlock', 'high'],
  ['the pane is still not working after your change', 'high'],
  ["that didn't work, try something else", 'high'],
  ['debug the memory leak in the sampler', 'high'],
  ['this is a regression from yesterday', 'high'],
  ['review the auth token handling for a vulnerability', 'high'],
  ['store the credential somewhere safe', 'high'],
  ['plan the migration of the desk file', 'high'],
  ['what are the tradeoffs between the two designs?', 'high'],
  ['the architecture of the remote link needs rethinking', 'high'],
  ['there is a race between the sweep and the write', 'high'],
  ['it hangs on the second turn', 'high']
]

t(`the table classifies all ${table.length} asks`, () => {
  for (const [prompt, want] of table) {
    const got = classifyEffort(prompt, {})
    assert.equal(got.level, want, `${prompt} -> ${got.level} (${got.reason}), wanted ${want}`)
    assert.ok(got.reason.length > 3, 'every answer says why')
  }
})

t('a long ask with low words in it is still work', () => {
  const long =
    'rename the field, then thread it through the sweep, the snapshot and the phone client, ' +
    'and make the card draw it in both themes without a new colour anywhere, then pin the ' +
    'wording with a test so nobody has to look at the screen to know it is right'
  assert.equal(classifyEffort(long, {}).level, 'medium')
})

t('repeated failures alone reach high', () => {
  const got = classifyEffort('try the other approach', { failures: 2 })
  assert.equal(got.level, 'high')
  assert.equal(got.reason, 'repeated failed attempts')
})

t('continue does not downgrade an open investigation', () => {
  const got = classifyEffort('continue', { active: 'high', holdTurns: HIGH_HOLD_TURNS })
  assert.equal(got.level, 'high')
  assert.equal(got.holdTurns, HIGH_HOLD_TURNS - 1)
})

t('a short ordinary ask keeps High while the hold lasts, then lets go', () => {
  let hold = HIGH_HOLD_TURNS
  const seen = []
  for (let i = 0; i < 4; i++) {
    const got = classifyEffort('Now add the chip to the card as well', {
      active: 'high',
      holdTurns: hold
    })
    seen.push(got.level)
    hold = got.holdTurns
  }
  assert.deepEqual(seen, ['high', 'high', 'high', 'medium'])
})

t('a sentence saying it works ends the hold at once', () => {
  const got = classifyEffort('that works now, thanks', {
    active: 'high',
    holdTurns: HIGH_HOLD_TURNS
  })
  assert.notEqual(got.level, 'high')
  assert.equal(got.holdTurns, 0)
})

t('an explicit small ask ends the hold at once', () => {
  const got = classifyEffort('fix the typo in that comment', {
    active: 'high',
    holdTurns: HIGH_HOLD_TURNS
  })
  assert.equal(got.level, 'low')
  assert.equal(got.holdTurns, 0)
})

t('an uncertain ask is medium', () => {
  assert.equal(classifyEffort('handle the other case as well', {}).level, 'medium')
})

// ---------------------------------------------------------------------------
// Aiming at a ladder, and walking it.

t('the three levels map onto a full ladder unchanged', () => {
  assert.equal(autoTarget('low', LADDER), 'low')
  assert.equal(autoTarget('medium', LADDER), 'medium')
  assert.equal(autoTarget('high', LADDER), 'high')
})

t('a ladder missing a rung aims BELOW, never above', () => {
  assert.equal(autoTarget('high', ['low', 'xhigh']), 'low')
  assert.equal(autoTarget('medium', ['low', 'high']), 'low')
  assert.equal(autoTarget('low', ['medium', 'high']), undefined)
  assert.equal(autoTarget('high', ['fast', 'slow']), undefined)
})

t('the keys walk the ladder in the right direction', () => {
  assert.deepEqual(planEffortKeys('low', 'high', LADDER), {
    seq: EFFORT_UP + EFFORT_UP,
    presses: 2
  })
  assert.deepEqual(planEffortKeys('ultra', 'max', LADDER), { seq: EFFORT_DOWN, presses: 1 })
})

t('an unsupported level plans nothing at all', () => {
  assert.equal(planEffortKeys('low', 'ludicrous', LADDER), null)
  assert.equal(planEffortKeys('ludicrous', 'low', LADDER), null)
  assert.equal(planEffortKeys('low', 'low', LADDER), null)
})

// ---------------------------------------------------------------------------
// The decision at a turn boundary.

const base = () => ({
  mode: 'auto',
  ladder: LADDER,
  confirmed: 'medium',
  reason: 'routine implementation',
  holdTurns: 0
})

t('a hard ask before a quiet turn plans the change', () => {
  const got = decideBeforeTurn(base(), 'why does this still crash?', { busy: false, now: 1000 })
  assert.equal(got.target, 'high')
  assert.equal(got.refused, undefined)
})

t('a busy pane is never touched, and the prompt still goes', () => {
  const got = decideBeforeTurn(base(), 'why does this still crash?', { busy: true, now: 1000 })
  assert.equal(got.target, undefined)
  assert.equal(got.refused, 'busy')
  assert.equal(got.reason, 'kept: the pane was busy')
})

t('a change still in flight blocks the next one - no oscillation', () => {
  const state = { ...base(), pending: { level: 'high', at: 1000 } }
  const soon = decideBeforeTurn(state, 'rename that label', { busy: false, now: 1500 })
  assert.equal(soon.target, undefined)
  assert.equal(soon.refused, 'pending')
  // ...and it is a hold, not a wedge: past the window the pane decides again.
  const later = decideBeforeTurn(state, 'rename that label', {
    busy: false,
    now: 1000 + PENDING_MAX_MS + 1
  })
  assert.equal(later.target, 'low')
})

t('no ladder and no first reply each refuse by name', () => {
  const noLadder = decideBeforeTurn(
    { mode: 'auto', reason: '', confirmed: 'medium' },
    'anything',
    { busy: false, now: 1 }
  )
  assert.equal(noLadder.refused, 'no-ladder')
  const noLevel = decideBeforeTurn({ mode: 'auto', reason: '', ladder: LADDER }, 'anything', {
    busy: false,
    now: 1
  })
  assert.equal(noLevel.refused, 'unknown-level')
  assert.equal(noLevel.reason, "waiting for Codex's first reply")
})

t('the launch level is the starting point until the first reply confirms one', () => {
  const got = decideBeforeTurn(
    { mode: 'auto', reason: '', ladder: LADDER, launched: 'medium' },
    'why is this flaky?',
    { busy: false, now: 1 }
  )
  assert.equal(got.target, 'high')
})

t('a hand-set level beats the rule until Auto is asked for again', () => {
  const manual = { mode: 'manual', manual: 'high', ladder: LADDER, confirmed: 'low', reason: '' }
  const got = decideBeforeTurn(manual, 'rename that label', { busy: false, now: 1 })
  assert.equal(got.target, 'high')
  // ...and once it has landed there is nothing left to press.
  const settled = decideBeforeTurn({ ...manual, confirmed: 'high' }, 'rename that label', {
    busy: false,
    now: 1
  })
  assert.equal(settled.target, undefined)
  assert.equal(settled.refused, undefined)
})

t('a hand-set level this model does not offer changes nothing', () => {
  const got = decideBeforeTurn(
    { mode: 'manual', manual: 'ultra', ladder: ['low', 'medium'], confirmed: 'low', reason: '' },
    'anything',
    { busy: false, now: 1 }
  )
  assert.equal(got.target, undefined)
  assert.equal(got.refused, 'unknown-level')
})

t('aiming at the level it is already on presses nothing', () => {
  const got = decideBeforeTurn(base(), 'add the chip to the card', { busy: false, now: 1 })
  assert.equal(got.target, undefined)
  assert.equal(got.refused, undefined)
  assert.equal(got.reason, 'routine implementation')
})

// ---------------------------------------------------------------------------
// Confirmation - the rollout is the only evidence.

t('the rollout confirms the level and clears what was in flight', () => {
  const next = confirmEffort({ ...base(), pending: { level: 'high', at: 1 } }, 'high', 2)
  assert.equal(next.confirmed, 'high')
  assert.equal(next.pending, undefined)
})

t('a change that did not land is said plainly, not claimed', () => {
  const next = confirmEffort({ ...base(), pending: { level: 'high', at: 1 } }, 'medium', 2)
  assert.equal(next.confirmed, 'medium')
  assert.equal(next.reason, 'Codex answered medium, kept it')
})

t('a blank reading changes nothing', () => {
  const state = { ...base(), pending: { level: 'high', at: 1 } }
  assert.equal(confirmEffort(state, '', 2), state)
})

// ---------------------------------------------------------------------------
// Reading a real rollout tail.

const rollout = readFileSync(join(here, 'fixtures/codex-rollout-tail.jsonl'), 'utf8')

t('the newest turn of a real rollout is the one read', () => {
  assert.equal(lastTurnEffort(rollout), 'medium')
  const twoTurns = rollout.split('\n').slice(0, 2).join('\n')
  assert.equal(lastTurnEffort(twoTurns), 'high')
})

t('a line the tail cut in half is skipped, not mis-read', () => {
  const cut = rollout.slice(40)
  assert.equal(lastTurnEffort(cut), 'medium')
  assert.equal(lastTurnEffort(''), undefined)
  assert.equal(lastTurnEffort('{"type":"turn_context","payload":{}}'), undefined)
})

t('the same line says which model ran the turn', () => {
  // A pane launched with no --model flag has no other way of knowing which ladder it is
  // on: the CLI picked the model out of the person's own config.
  assert.equal(lastTurnContext(rollout).model, 'gpt-6-astra')
  assert.equal(lastTurnContext(rollout).effort, 'medium')
  assert.equal(lastTurnContext(''), undefined)
})

t('the older field name reads too', () => {
  assert.equal(
    lastTurnEffort('{"type":"turn_context","payload":{"reasoning_effort":"xhigh"}}'),
    'xhigh'
  )
})

// ---------------------------------------------------------------------------
// Words on the card, and the launch flag.

// What the card is handed: the CONFIRMED level, the words, and the model's own levels.
const reading = (over = {}) => ({
  mode: 'auto',
  level: 'medium',
  reason: 'routine implementation',
  ladder: LADDER,
  ...over
})

t('every state says something a person can read', () => {
  assert.equal(effortWords(reading()), 'Auto: Medium · routine implementation')
  assert.equal(
    effortWords(reading({ level: 'high', reason: 'kept while the problem is open' })),
    'Auto: High · kept while the problem is open'
  )
  assert.equal(effortWords(reading({ mode: 'manual', level: 'high' })), 'Manual: High')
  assert.equal(
    effortWords(reading({ level: undefined })),
    "Auto: waiting for Codex's first reply"
  )
  assert.equal(
    effortWords(reading({ ladder: undefined })),
    'Auto: Codex did not list its levels'
  )
  assert.equal(effortChip(reading()), 'Auto · Medium')
  assert.equal(effortChip(reading({ mode: 'manual', level: 'high' })), 'Manual · High')
  assert.equal(effortChip(reading({ level: undefined })), 'Auto')
})

t('no word on the card is machinery', () => {
  const words = [
    effortWords(reading()),
    effortWords(reading({ mode: 'manual', level: 'high' })),
    effortWords(reading({ level: undefined })),
    effortWords(reading({ ladder: undefined })),
    effortChip(reading({ level: 'low' }))
  ].join(' ')
  for (const jargon of ['ladder', 'pending', 'rollout', 'pty', 'ansi', 'config']) {
    assert.ok(!words.toLowerCase().includes(jargon), `${jargon} reached the card`)
  }
})

t('the launch flag is a pair, and nothing when no level is asked for', () => {
  assert.deepEqual(effortLaunchArgs('medium'), ['-c', 'model_reasoning_effort="medium"'])
  assert.deepEqual(effortLaunchArgs(), [])
  assert.deepEqual(effortLaunchArgs('  '), [])
})

t('only a Codex pane is launched with the level', () => {
  const codex = { id: 'codex', bin: 'codex', args: [] }
  const claude = { id: 'claude', bin: 'claude', args: [] }
  assert.deepEqual(buildArgs(codex, { effort: 'medium' }), ['-c', 'model_reasoning_effort="medium"'])
  assert.deepEqual(buildArgs(claude, { effort: 'medium' }), [])
  assert.deepEqual(buildArgs(codex, {}), [])
})

console.log(`\neffort: ${pass} checks passed`)
