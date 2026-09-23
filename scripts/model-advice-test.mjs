// A Claude Code pane's first ask suggests a lighter or stronger model, or says nothing.
//
// `shared/modelAdvice.ts` is a pure rule, tested here directly - but it imports its
// Codex signal lists from `shared/effort.ts` (the reuse the spec asked for, so this
// suite passing proves nothing about Codex's own behaviour; `test:effort` still has to
// pass on its own for that), and a bare `node` run cannot follow an extensionless
// sibling import from one shared file into another. Same fix as `mascot-test.mjs`:
// esbuild bundles the one file this suite needs into something node can just run.

import { buildSync } from 'esbuild'
import assert from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-model-advice-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'modelAdvice.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/modelAdvice.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { judgeModelAdvice, modelFamily } = createRequire(import.meta.url)(outfile)

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const FABLE = 'claude-fable-5-1'

// ---------------------------------------------------------------------------
// modelFamily: the part of a name that never changes underneath a version bump.

t('every family reads off the id or the bare alias', () => {
  assert.equal(modelFamily('claude-opus-5-5'), 'opus')
  assert.equal(modelFamily('opus'), 'opus')
  assert.equal(modelFamily('claude-sonnet-5'), 'sonnet')
  assert.equal(modelFamily('claude-fable-5-1'), 'fable')
  assert.equal(modelFamily('claude-haiku-4-5'), 'haiku')
  assert.equal(modelFamily('gpt-6-astra'), 'other')
})

// ---------------------------------------------------------------------------
// 15+ real-shaped prompts, each with the tier (or null) they must read as.

t('a small fix mentioning a typo is light, and keeps the model', () => {
  const a = judgeModelAdvice({ prompt: 'fix the typo in README', model: OPUS, effort: 'high' })
  assert.equal(a.tier, 'light')
  assert.equal(a.to.family, undefined)
  assert.equal(a.to.effort, 'low')
})

t('a pure lookup on Opus is offered Sonnet', () => {
  const a = judgeModelAdvice({
    prompt: 'what is the port the dev server uses?',
    model: OPUS,
    effort: 'medium'
  })
  assert.equal(a.tier, 'light')
  assert.equal(a.to.family, 'sonnet')
  assert.equal(a.to.effort, 'low')
})

t('the same lookup on Sonnet keeps Sonnet - already the lighter family', () => {
  const a = judgeModelAdvice({
    prompt: 'what is the port the dev server uses?',
    model: SONNET,
    effort: 'medium'
  })
  assert.equal(a.tier, 'light')
  assert.equal(a.to.family, undefined)
})

t('a rename with one file path is light, not a lookup, so the model stays', () => {
  const a = judgeModelAdvice({ prompt: 'rename foo to bar in utils.ts', model: SONNET, effort: 'medium' })
  assert.equal(a.tier, 'light')
  assert.equal(a.to.family, undefined)
})

t('a repeated failure naming "why" and "again" is heavy', () => {
  const a = judgeModelAdvice({
    prompt: 'why does the build fail on windows again',
    model: SONNET,
    effort: 'medium'
  })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.to.family, 'opus')
  assert.equal(a.to.effort, 'high')
})

t('the same hard ask on Opus already at high effort gets no card', () => {
  const a = judgeModelAdvice({
    prompt: 'why does the build fail on windows again',
    model: OPUS,
    effort: 'high'
  })
  assert.equal(a, null)
})

t('a pasted 5-line stack trace is heavy', () => {
  const prompt = [
    "TypeError: Cannot read properties of undefined (reading 'foo')",
    '    at Object.<anonymous> (/app/src/index.js:10:5)',
    '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
    '    at Module._extensions..js (node:internal/modules/cjs/loader:1159:10)',
    '    at Module.load (node:internal/modules/cjs/loader:981:32)'
  ].join('\n')
  const a = judgeModelAdvice({ prompt, model: SONNET, effort: 'medium' })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.reason, 'a pasted error')
})

t('a numbered list of 3 tasks is heavy', () => {
  const prompt = [
    'Please do the following:',
    '1. Add a loading state to the table',
    '2. Wire the export button to the API',
    '3. Cover both with a test'
  ].join('\n')
  const a = judgeModelAdvice({ prompt, model: SONNET, effort: 'medium' })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.reason, 'a multi-step list')
})

t('a 700-character spec is heavy on length alone', () => {
  const prompt = 'Build a settings page that lets somebody pick a theme. '.repeat(13)
  assert.ok(prompt.length > 600)
  const a = judgeModelAdvice({ prompt, model: SONNET, effort: 'medium' })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.reason, 'a long ask')
})

t('"continue" alone is nothing to judge', () => {
  assert.equal(judgeModelAdvice({ prompt: 'continue', model: OPUS, effort: 'high' }), null)
})

t('"yes" alone is nothing to judge', () => {
  assert.equal(judgeModelAdvice({ prompt: 'yes', model: SONNET, effort: 'low' }), null)
})

t('an ambiguous short ask with no distinguishing signal gets no card', () => {
  assert.equal(judgeModelAdvice({ prompt: 'update the header', model: OPUS, effort: 'medium' }), null)
})

t('a security word is heavy even without a question or a file', () => {
  const a = judgeModelAdvice({
    prompt: 'review this for an auth token leak before we ship it',
    model: SONNET,
    effort: 'medium'
  })
  assert.equal(a.tier, 'heavy')
})

t('a migration named outright is heavy even with no question mark', () => {
  const a = judgeModelAdvice({
    prompt: 'migrate the auth module to the new session store',
    model: OPUS,
    effort: 'low'
  })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.to.family, undefined)
  assert.equal(a.to.effort, 'high')
})

t('a Fable pane on a hard ask stays on Fable', () => {
  const a = judgeModelAdvice({
    prompt: 'investigate why the export race only happens on windows',
    model: FABLE,
    effort: 'medium'
  })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.to.family, undefined)
})

t('a Haiku pane on a hard ask is offered Opus', () => {
  const a = judgeModelAdvice({
    prompt: 'investigate why the export race only happens on windows',
    model: 'claude-haiku-4-5',
    effort: 'medium'
  })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.to.family, 'opus')
})

t('three or more distinct file paths reads as work across several files', () => {
  const a = judgeModelAdvice({
    prompt: 'wire these together: src/a.ts, src/b.ts and src/c.ts',
    model: SONNET,
    effort: 'medium'
  })
  assert.equal(a.tier, 'heavy')
  assert.equal(a.reason, 'work across several files')
})

// ---------------------------------------------------------------------------
// Codex's own suite must still pass on its own - see `test:effort`. Import assurance:
// the exact fixtures effort-test.mjs uses give the same reading through the export this
// file reuses.

t('the exported HIGH/LOW/CONTINUATION lists are the ones Codex classifies with', () => {
  const src = readFileSync(new URL('../src/shared/effort.ts', import.meta.url), 'utf8')
  assert.match(src, /export const HIGH:/)
  assert.match(src, /export const LOW =/)
  assert.match(src, /export const CONTINUATION =/)
})

// ---------------------------------------------------------------------------
// Source check: `engaged` is read BEFORE it is ever set on this keystroke.

t('main reads live.meta.engaged before the block that sets it', () => {
  const src = readFileSync(new URL('../src/main/sessions.ts', import.meta.url), 'utf8')
  const adviseAt = src.indexOf('this.adviseModel(live, live.typed)')
  const setAt = src.indexOf('live.meta.engaged = true')
  assert.ok(adviseAt > 0, 'the advice call is in sessions.ts')
  assert.ok(setAt > 0, 'the engaged flip is in sessions.ts')
  assert.ok(adviseAt < setAt, 'the read must come before the write it is about')
})

console.log(`model-advice: ${pass} checks passed`)
