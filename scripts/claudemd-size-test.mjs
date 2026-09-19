// CLAUDE.md is loaded on every turn in this repo, on top of the global file. It has a
// 12,000-token cap and drifted to ~22,900 tokens (84.9 KB) by 2026-09-19 with nothing
// measuring it. This pins the cap: a rule, never its history - stories go to
// docs/design-notes.md, the verbatim long form to docs/claude-md-full-<date>.md.
//
// Tokens are estimated at 3.7 bytes per token, the house convention shared with
// claude-memory's claudemd-review.mjs (CHARS_PER_TOKEN = 3.7) so both gates read the same
// number. The @anthropic-ai/tokenizer counts this dense, backtick-heavy file ~18% higher
// (2026-09-19: 41,930 bytes = 11,332 est vs 13,428 real). The cap is judged on the estimate;
// the real figure is the one to quote when asked what a turn pays.
//
//   node scripts/claudemd-size-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'CLAUDE.md')
const BYTES_PER_TOKEN = 3.7
const CAP_TOKENS = 12_000

const bytes = statSync(file).size
const tokens = Math.round(bytes / BYTES_PER_TOKEN)
const text = readFileSync(file, 'utf8')
const headings = text.split('\n').filter((l) => l.startsWith('## ')).length

assert.ok(headings > 40, `only ${headings} sections - the file was gutted, not trimmed`)
assert.ok(
  tokens <= CAP_TOKENS,
  `CLAUDE.md is ${bytes} bytes (~${tokens} tokens) over the ${CAP_TOKENS}-token cap - move the story to docs/design-notes.md, keep the rule`,
)
console.log(`claudemd: ${bytes} bytes, ~${tokens} tokens, ${headings} sections (cap ${CAP_TOKENS})`)
