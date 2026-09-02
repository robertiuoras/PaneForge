// The floor under every prompt this app writes.
//
// `docs/prompt-review-2026-09-02.md` counted six prompt-producing sites: one of them said
// what done looked like. The rules pinned here are the ones that stop that recurring - a
// forged prompt ALWAYS ends with a `Done means:` block, and the block is the last thing
// dropped when the budget is tight, never the first.
//
// The last half is PARITY with the real library: it reads Robert's own
// `claude-config/promptlib` off disk and asserts the parse gets something usable out of
// it, and SKIPS OUT LOUD when that machine has no library rather than passing on absence.

import assert from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const {
  forgePrompt,
  trimExample,
  readPromptlibTemplate,
  builtInTemplate,
  fencedUnder,
  discernment,
  MAX_PROMPT_CHARS,
  EXAMPLE_CHARS,
  MAX_EXAMPLES,
  DEFAULT_DONE
} = await import('../src/shared/promptForge.ts')

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
  console.log('ok -', name)
}

// ---------------------------------------------------------------------------
// The done block.

t('a prompt with no done given still ends with a done block', () => {
  const out = forgePrompt({ task: 'Fix the header.' })
  assert.match(out, /Done means:/)
  assert.ok(out.trimEnd().endsWith(DEFAULT_DONE), out.slice(-120))
})

t('the done block is the LAST thing on the page, after examples', () => {
  const out = forgePrompt({
    task: 'Fix the header.',
    examples: ['an example ask'],
    done: ['the header fits at 1280px']
  })
  assert.ok(out.indexOf('Done means:') > out.indexOf('an example ask'))
  assert.ok(out.trimEnd().endsWith('- the header fits at 1280px'))
})

t('every done line is carried, not just the first', () => {
  const out = forgePrompt({ task: 'x', done: ['one', 'two', 'three'] })
  for (const d of ['- one', '- two', '- three']) assert.match(out, new RegExp(d))
})

// ---------------------------------------------------------------------------
// Anchors and scope.

t('an anchor is present when given, and named as a place to start', () => {
  const out = forgePrompt({ task: 'x', anchors: ['src/main/sessions.ts queuePrompt'] })
  assert.match(out, /Start from:/)
  assert.match(out, /- src\/main\/sessions\.ts queuePrompt/)
})

t('no anchor given draws no anchor heading - an empty section is noise', () => {
  const out = forgePrompt({ task: 'x' })
  assert.doesNotMatch(out, /Start from:/)
  assert.doesNotMatch(out, /Stay inside:/)
})

t('blank and whitespace entries are dropped, not drawn as empty bullets', () => {
  const out = forgePrompt({ task: 'x', anchors: ['', '   ', 'real.ts'] })
  assert.strictEqual((out.match(/^- /gm) || []).length, 2) // one anchor, one default done
})

t('scope is carried as its own fence', () => {
  const out = forgePrompt({ task: 'x', scope: ['do not touch the schema'] })
  assert.match(out, /Stay inside:\n- do not touch the schema/)
})

// ---------------------------------------------------------------------------
// Examples.

t('at most two examples survive, however many are handed in', () => {
  const out = forgePrompt({ task: 'x', examples: ['AAA', 'BBB', 'CCC', 'DDD'] })
  assert.match(out, /AAA/)
  assert.match(out, /BBB/)
  assert.doesNotMatch(out, /CCC/)
  assert.strictEqual(MAX_EXAMPLES, 2)
})

t('one example says example, two say examples', () => {
  assert.match(forgePrompt({ task: 'x', examples: ['A'] }), /An example of a good ask/)
  assert.match(forgePrompt({ task: 'x', examples: ['A', 'B'] }), /Examples of a good ask/)
})

t('an example longer than EXAMPLE_CHARS is trimmed, and says it was', () => {
  const long = 'y'.repeat(EXAMPLE_CHARS * 3)
  const out = forgePrompt({ task: 'x', examples: [long] })
  assert.ok(!out.includes(long))
  assert.match(out, /…/)
  assert.ok(trimExample(long).length <= EXAMPLE_CHARS + 2, String(trimExample(long).length))
})

t('a trim prefers a late line break so the example is not cut mid-line', () => {
  const body = 'a'.repeat(Math.floor(EXAMPLE_CHARS * 0.9)) + '\n' + 'b'.repeat(400)
  assert.ok(trimExample(body).endsWith('\n…'))
})

t("the template's own examples are used when the caller hands none", () => {
  const out = forgePrompt({ task: 'x', template: { id: 't', guidance: [], examples: ['FROM TEMPLATE'] } })
  assert.match(out, /FROM TEMPLATE/)
})

t("caller examples override the template's", () => {
  const out = forgePrompt({
    task: 'x',
    examples: ['CALLER'],
    template: { id: 't', guidance: [], examples: ['TEMPLATE'] }
  })
  assert.match(out, /CALLER/)
  assert.doesNotMatch(out, /TEMPLATE/)
})

// ---------------------------------------------------------------------------
// The budget. The done block is never what is dropped.

t('a prompt over budget drops examples before anything else', () => {
  const out = forgePrompt({
    task: 'z'.repeat(MAX_PROMPT_CHARS - 400),
    examples: ['EX ONE', 'EX TWO'],
    done: ['it builds']
  })
  assert.ok(out.length <= MAX_PROMPT_CHARS, String(out.length))
  assert.match(out, /Done means:\n- it builds/)
})

t('a task alone over budget is truncated, and STILL carries the done block', () => {
  const out = forgePrompt({ task: 'q'.repeat(MAX_PROMPT_CHARS * 2), done: ['the suite is green'] })
  assert.ok(out.length <= MAX_PROMPT_CHARS, String(out.length))
  assert.ok(out.trimEnd().endsWith('- the suite is green'))
})

t('anchors and scope survive a budget squeeze - they are the cheap half', () => {
  const out = forgePrompt({
    task: 'z'.repeat(MAX_PROMPT_CHARS - 300),
    anchors: ['src/shared/promptForge.ts'],
    examples: ['a'.repeat(EXAMPLE_CHARS)]
  })
  assert.ok(out.length <= MAX_PROMPT_CHARS)
  assert.match(out, /src\/shared\/promptForge\.ts/)
})

// ---------------------------------------------------------------------------
// No library on disk.

t('no promptlib on disk still forges a prompt', () => {
  assert.strictEqual(readPromptlibTemplate('build-feature', ''), null)
  const out = forgePrompt({ task: 'Build the thing.', template: builtInTemplate('build-feature') })
  assert.match(out, /Done means:/)
  assert.match(out, /Judged on:/)
})

t('an id this app ships no copy of is simply no template', () => {
  assert.strictEqual(builtInTemplate('no-such-template'), null)
  assert.match(forgePrompt({ task: 'x', template: null }), /Done means:/)
})

// ---------------------------------------------------------------------------
// The parse.

const SAMPLE = `---
id: build-feature
---

## Template

\`\`\`
Build {WHAT} in {WHERE}.
\`\`\`

## Fill notes

not a fence.

## Discernment — check the reply for

1. Local evidence — a running server, a test — before any mention of pushing.
2. Files listed under Changes that match the scope you fenced.

## Harvested exemplars

\`\`\`
older harvested prompt
\`\`\`

\`\`\`
newer harvested prompt
\`\`\`
`

t('the template block and the harvested blocks are both read', () => {
  const tpl = readPromptlibTemplate('build-feature', SAMPLE)
  assert.deepStrictEqual(tpl.examples, [
    'Build {WHAT} in {WHERE}.',
    'newer harvested prompt',
    'older harvested prompt'
  ])
})

t('the shape comes first and the newest harvest second, so two survive', () => {
  const out = forgePrompt({ task: 'x', template: readPromptlibTemplate('build-feature', SAMPLE) })
  assert.match(out, /Build \{WHAT\} in \{WHERE\}\./)
  assert.match(out, /newer harvested prompt/)
  assert.doesNotMatch(out, /older harvested prompt/)
})

t('discernment becomes the judged-on lines', () => {
  assert.deepStrictEqual(discernment(SAMPLE).length, 2)
  assert.match(readPromptlibTemplate('build-feature', SAMPLE).guidance[0], /Local evidence/)
})

t('CRLF parses the same - the library is checked out with CRLF on the PC', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  assert.deepStrictEqual(readPromptlibTemplate('build-feature', crlf).examples.length, 3)
})

t('a heading with no fence under it contributes no example', () => {
  assert.deepStrictEqual(fencedUnder(SAMPLE, /^Fill notes/), [])
})

// ---------------------------------------------------------------------------
// Parity with the real library.

const lib = process.env.PF_PROMPTLIB || join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'promptlib')
const tplDir = join(lib, 'templates')
if (!existsSync(tplDir)) {
  console.log('SKIP - promptlib is not on this machine:', tplDir)
} else {
  const files = readdirSync(tplDir).filter((f) => f.endsWith('.md'))
  t(`every one of the ${files.length} real templates parses to a usable exemplar`, () => {
    assert.ok(files.length >= 10, `only ${files.length} templates`)
    for (const f of files) {
      const id = f.replace(/\.md$/, '')
      const tpl = readPromptlibTemplate(id, readFileSync(join(tplDir, f), 'utf8'))
      assert.ok(tpl, `${id} parsed to nothing`)
      assert.ok(tpl.examples.length >= 1, `${id} has no example block`)
      assert.ok(tpl.guidance.length >= 1, `${id} has no discernment checks`)
    }
  })

  t('a real template forges a prompt inside budget', () => {
    const tpl = readPromptlibTemplate('build-feature', readFileSync(join(tplDir, 'build-feature.md'), 'utf8'))
    const out = forgePrompt({
      task: 'Build the offload switch in Settings.',
      template: tpl,
      anchors: ['src/renderer/src/components/SettingsDialog.tsx'],
      done: ['npm run test:settingsearch is green']
    })
    assert.ok(out.length <= MAX_PROMPT_CHARS, String(out.length))
    assert.match(out, /Done means:/)
  })
}

console.log(`\n${pass} checks passed`)
