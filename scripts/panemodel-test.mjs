// What a Claude Code pane is really running, read off its own transcript.
//
// The parse lives in `src/shared/paneModel.ts` and is tested here directly, the same as
// `handoff-steps-test.mjs` tests `shared/handoffSteps.ts` and nothing under `src/main` -
// a main-side file imports its shared sibling extensionless, which only the app's own
// bundler resolves, not a bare `node` run. `src/main/paneModel.ts`'s cache contract (serve
// a cached reading only while the file's own mtime agrees with it) is instead pinned as a
// SOURCE assertion, the same way `handoff-steps-test.mjs` pins `handoffFor`'s.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { lastAssistantModel, resolveCatalogueValue, TAIL_BYTES } = await import(
  '../src/shared/paneModel.ts'
)

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

// ---------------------------------------------------------------------------
// Real-shaped fixture lines: shaped like real `~/.claude/projects/*/*.jsonl` rows - a
// "thinking" line with a long base64 signature, a "text" reply, a synthetic bookkeeping
// line, and a user line with no model at all - content redacted, shape kept.

const USER_LINE = JSON.stringify({
  parentUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
  isSidechain: false,
  type: 'user',
  uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
  timestamp: '2026-09-04T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'redacted' }] }
})

const thinkingLine = (model) =>
  JSON.stringify({
    parentUuid: 'bbbbbbbb-0000-4000-8000-000000000001',
    isSidechain: false,
    uuid: 'bbbbbbbb-0000-4000-8000-000000000002',
    timestamp: '2026-09-04T10:00:01.000Z',
    message: {
      model,
      id: 'msg_redacted',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '', signature: 'A'.repeat(2000) }]
    }
  })

const textLine = (model, text) =>
  JSON.stringify({
    parentUuid: 'cccccccc-0000-4000-8000-000000000001',
    isSidechain: false,
    uuid: 'cccccccc-0000-4000-8000-000000000002',
    timestamp: '2026-09-04T10:00:02.000Z',
    message: {
      model,
      id: 'msg_redacted2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }]
    }
  })

const syntheticLine = JSON.stringify({
  parentUuid: 'dddddddd-0000-4000-8000-000000000001',
  isSidechain: false,
  type: 'assistant',
  uuid: 'dddddddd-0000-4000-8000-000000000002',
  timestamp: '2026-09-04T10:00:03.000Z',
  message: { diagnostics: null, id: 'redacted', container: null, model: '<synthetic>', role: 'assistant' }
})

// ---------------------------------------------------------------------------
// The parse.

t('the last real assistant line wins, not the last line in the file', () => {
  const text = [
    USER_LINE,
    thinkingLine('claude-opus-5'),
    textLine('claude-opus-5', 'first reply'),
    USER_LINE,
    thinkingLine('claude-fable-5-1'),
    textLine('claude-fable-5-1', 'second reply')
  ].join('\n')
  assert.strictEqual(lastAssistantModel(text), 'claude-fable-5-1')
})

t('a synthetic bookkeeping line answers nothing about the model', () => {
  const text = [thinkingLine('claude-opus-5'), textLine('claude-opus-5', 'reply'), syntheticLine].join(
    '\n'
  )
  assert.strictEqual(lastAssistantModel(text), 'claude-opus-5')
})

t('no assistant line at all is undefined, never a crash', () => {
  assert.strictEqual(lastAssistantModel(''), undefined)
  assert.strictEqual(lastAssistantModel(USER_LINE), undefined)
  assert.strictEqual(lastAssistantModel(undefined), undefined)
})

t('a line the tail cut in half is skipped, not mis-parsed', () => {
  const whole = textLine('claude-fable-5-1', 'reply')
  const text = whole.slice(20) + '\n' + USER_LINE // first line is a torn fragment
  assert.strictEqual(lastAssistantModel(text), undefined)
})

t('garbage between real lines does not stop the scan', () => {
  const text = [textLine('claude-opus-5', 'reply'), '{not json', ''].join('\n')
  assert.strictEqual(lastAssistantModel(text), 'claude-opus-5')
})

// ---------------------------------------------------------------------------
// Mapping the real id onto this build's own catalogue value.

const CATALOGUE = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5',
  'opus',
  'sonnet',
  'haiku'
]

t('an exact catalogue match needs no trimming', () => {
  assert.strictEqual(resolveCatalogueValue('claude-opus-5', CATALOGUE), 'claude-opus-5')
  assert.strictEqual(resolveCatalogueValue('opus', CATALOGUE), 'opus')
})

t('a minor-version tail trims onto the catalogue entry', () => {
  assert.strictEqual(resolveCatalogueValue('claude-fable-5-1', CATALOGUE), 'claude-fable-5')
})

t('a dated tail trims onto the catalogue entry', () => {
  assert.strictEqual(resolveCatalogueValue('claude-haiku-4-5-20251001', CATALOGUE), 'claude-haiku-4-5')
})

t('a model the catalogue has never heard of gives up rather than guess', () => {
  assert.strictEqual(resolveCatalogueValue('claude-sonnet-4-6', CATALOGUE), undefined)
  assert.strictEqual(resolveCatalogueValue('', CATALOGUE), undefined)
})

t('TAIL_BYTES is a real cap, not the whole file', () => {
  assert.ok(TAIL_BYTES > 0 && TAIL_BYTES < 1024 * 1024)
})

console.log(`\n${pass} cases passed`)

// ---------------------------------------------------------------------------
// `main/paneModel.ts`'s cache: served only while the file's own mtime still matches the
// cached reading's, same contract `handoffFor` was fixed to keep (2026-09-04) after a
// wall-clock-only cache served a handoff that had already changed underneath it.
{
  const main = readFileSync(join(process.cwd(), 'src/main/paneModel.ts'), 'utf8')
  const served =
    /if \(hit && now - hit\.at < CACHE_MS\) \{[\s\S]*?statSync\(path\)\.mtimeMs === hit\.reading\.mtimeMs/.test(
      main
    )
  assert.ok(served, 'transcriptModel serves a cached reading only while the file has the same mtime')
  assert.ok(
    !/if \(hit && now - hit\.at < CACHE_MS\) return hit\.reading/.test(main),
    'a wall-clock-only cache hit must not be served'
  )
  assert.ok(/liveModelFor/.test(main) && /resolveCatalogueValue/.test(main), 'liveModelFor uses the shared mapping')
  console.log('ok   a changed transcript is read again inside the cache window')
}
