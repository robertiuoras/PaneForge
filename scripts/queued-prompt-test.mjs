// A prompt that has been sent to a pane may never be lost.
//
// The incident this pins: two `pf open --prompt` briefs were queued into one pane that was
// mid-turn, the pane was recreated twenty minutes later, and both briefs were gone with no
// line anywhere saying so. Every assertion below is about the difference between a prompt
// PROVEN typed and one that merely stopped being waited for.

import assert from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-queued-'))
const bundle = join(out, 'queuedPrompts.mjs')
buildSync({ entryPoints: ['src/shared/queuedPrompts.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bundle })
const { PREVIEW_CHARS, carryOver, clearQueued, dropLine, newQueueKey, noteQueued, owedTo, preview, readStore, sentLine } =
  await import(pathToFileURL(bundle).href)

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

// The ledger as the app uses it: a file on disk, and nothing else remembering.
const file = join(out, 'queued-prompts.json')
const save = (store) => writeFileSync(file, JSON.stringify(store, null, 2))
const load = () => {
  try {
    return readStore(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}
const accept = (id, text, at = Date.now()) => {
  const row = { id, key: newQueueKey(id, at), text, at }
  save(noteQueued(load(), row))
  return row.key
}

// ---------------------------------------------------------------------------
// 1. A queued prompt survives the object that was waiting on it.

t('a prompt is on disk the moment it is accepted', () => {
  save({})
  const key = accept('s7', 'read the brief and build it')
  assert.equal(Object.keys(load()).length, 1)
  assert.equal(load()[key].text, 'read the brief and build it')
})

t('the pane is recreated and the prompt is still owed', () => {
  save({})
  accept('s7', 'first brief', 1)
  accept('s7', 'second brief', 2)
  // The manager is gone - this is a fresh read of the file, exactly what a launch does.
  const owed = owedTo(load(), 's7')
  assert.equal(owed.length, 2)
  assert.deepEqual(owed.map((r) => r.text), ['first brief', 'second brief'])
})

t('a submitted prompt is NOT re-queued', () => {
  save({})
  const key = accept('s7', 'this one went in')
  save(clearQueued(load(), key))
  assert.deepEqual(owedTo(load(), 's7'), [])
})

t('a restored pane is issued a new id and inherits what the old one was owed', () => {
  save({})
  accept('s7', 'still owed', 1)
  const moved = carryOver(load(), 's7', 's10')
  save(moved.store)
  assert.deepEqual(moved.prompts.map((r) => r.text), ['still owed'])
  assert.deepEqual(owedTo(load(), 's7'), [], 'the old id owes nothing once it is carried over')
  assert.deepEqual(owedTo(load(), 's10').map((r) => r.text), ['still owed'])
})

t('carrying over twice cannot type one prompt twice', () => {
  save({})
  accept('s7', 'once only', 1)
  save(carryOver(load(), 's7', 's10').store)
  const again = carryOver(load(), 's7', 's11')
  assert.deepEqual(again.prompts, [], 'the row moved, so the second restore finds nothing')
  assert.equal(owedTo(load(), 's10').length, 1)
})

t('a pane owing nothing carries nothing', () => {
  save({})
  assert.deepEqual(carryOver(load(), 'sX', 'sY').prompts, [])
})

// ---------------------------------------------------------------------------
// A half-written or hand-edited file must never stop the app, and must never invent a
// prompt: an unreadable ledger reads as empty, and a row with no text is not a prompt.

t('a broken ledger reads as empty rather than throwing', () => {
  writeFileSync(file, '{ not json')
  assert.deepEqual(load(), {})
})

t('rows without a pane or without text are dropped', () => {
  const store = readStore({ a: { id: 's1', text: 'keep' }, b: { id: 's1' }, c: { text: 'no pane' }, d: 7 })
  assert.deepEqual(Object.keys(store), ['a'])
  assert.equal(store.a.at, 0, 'a row with no moment still loads')
})

// ---------------------------------------------------------------------------
// 4. A prompt that is dropped for any reason is findable afterwards.

t('a lost prompt writes its first characters, and says it was lost', () => {
  const line = dropLine({ id: 's7', key: 'k', text: 'read the brief at /tmp/brief.md and build it', at: 0 }, 'unsent')
  assert.match(line, /s7/)
  assert.match(line, /LOST/)
  assert.match(line, /unsent/)
  assert.match(line, /read the brief at \/tmp\/brief\.md/)
})

t('every drop reason has words a person can read', () => {
  for (const why of ['unsent', 'abandoned', 'gone', 'expired', 'replaced']) {
    const line = dropLine({ id: 's7', key: 'k', text: 'x', at: 0 }, why)
    assert.match(line, new RegExp(why))
    assert.ok(line.length > 20, `${why} says something`)
  }
})

t('a long prompt is capped and marked, a short one is whole', () => {
  const long = 'x'.repeat(500)
  assert.equal(preview(long).length, PREVIEW_CHARS + 1)
  assert.equal(preview('short one'), 'short one')
  assert.equal(preview('two\n\nlines  here'), 'two lines here', 'a log line is one line')
})

t('a submitted prompt is written down too, so the log reads as a ledger', () => {
  const line = sentLine({ id: 's7', key: 'k', text: 'the brief', at: 0 })
  assert.match(line, /submitted/)
  assert.match(line, /the brief/)
  assert.doesNotMatch(line, /LOST/)
})

// ---------------------------------------------------------------------------
// 2. A brief never queues behind somebody else's turn.

const soo = join(out, 'sendOrOpen.mjs')
buildSync({ entryPoints: ['src/shared/sendOrOpen.ts'], bundle: true, format: 'esm', platform: 'node', outfile: soo })
const { sendOrOpen } = await import(pathToFileURL(soo).href)

const idle = { id: 's7', status: 'idle' }

t('no pane on that folder opens one', () =>
  assert.equal(sendOrOpen({ prompt: 'do the thing', pane: null }).action, 'open'))

t('an idle pane with nothing queued takes the prompt', () => {
  const v = sendOrOpen({ prompt: 'do the thing', pane: idle })
  assert.equal(v.action, 'send')
  assert.equal(v.id, 's7')
  assert.match(v.why, /idle/)
})

t('a pane mid-turn gets its own pane instead - the measured failure', () => {
  assert.equal(sendOrOpen({ prompt: 'brief', pane: { ...idle, status: 'working' } }).action, 'open')
  assert.equal(sendOrOpen({ prompt: 'brief', pane: { ...idle, runSince: Date.now() } }).action, 'open')
})

t('a pane already holding a queued prompt gets its own pane', () => {
  const v = sendOrOpen({ prompt: 'brief', pane: { ...idle, queued: 1 } })
  assert.equal(v.action, 'open')
  assert.match(v.why, /already holding a prompt/)
})

t('a pane waiting on a person, drafting or still starting gets its own pane', () => {
  assert.equal(sendOrOpen({ prompt: 'b', pane: { ...idle, ask: { options: [] } } }).action, 'open')
  assert.equal(sendOrOpen({ prompt: 'b', pane: { ...idle, drafting: true } }).action, 'open')
  assert.equal(sendOrOpen({ prompt: 'b', pane: { ...idle, status: 'starting' } }).action, 'open')
  assert.equal(sendOrOpen({ prompt: 'b', pane: { ...idle, status: 'exited' } }).action, 'open')
})

t('going to a chat with no prompt still goes to the busy pane', () => {
  assert.equal(sendOrOpen({ pane: { ...idle, status: 'working' } }).action, 'send')
  assert.equal(sendOrOpen({ prompt: '   ', pane: { ...idle, status: 'working' } }).action, 'send')
})

t('every answer says why, in words with no machinery in them', () => {
  for (const pane of [null, idle, { ...idle, status: 'working' }, { ...idle, queued: 2 }]) {
    const why = sendOrOpen({ prompt: 'b', pane }).why
    assert.ok(why.length > 8, 'there is a sentence')
    assert.doesNotMatch(why, /lane|worktree|queuePrompt|runSince/, why)
  }
})

console.log(`\n${pass} checks passed`)
