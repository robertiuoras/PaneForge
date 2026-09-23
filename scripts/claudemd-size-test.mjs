// AGENTS.md is the repo's instruction file for every coding agent; CLAUDE.md is `@AGENTS.md`
// plus the Claude-only lines, so a Claude turn loads both and a Codex turn loads AGENTS.md.
// The pair has a 12,000-token cap: CLAUDE.md alone drifted to ~22,900 tokens (84.9 KB) by
// 2026-09-19 with nothing measuring it. A rule, never its history - stories go to
// docs/design-notes.md, the verbatim long form to docs/claude-md-full-<date>.md, and a
// section too long for AGENTS.md to docs/agents/<topic>.md, which AGENTS.md must link.
//
// Tokens are estimated at 3.7 bytes per token, the house convention shared with
// claude-memory's claudemd-review.mjs (CHARS_PER_TOKEN = 3.7) so both gates read the same
// number. The @anthropic-ai/tokenizer counts this dense, backtick-heavy text ~18% higher
// (2026-09-19: 41,930 bytes = 11,332 est vs 13,428 real). The cap is judged on the estimate;
// the real figure is the one to quote when asked what a turn pays. Codex stops reading
// AGENTS.md at 32 KiB, so that file has its own byte cap.
//
//   node scripts/claudemd-size-test.mjs

import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const claude = join(root, 'CLAUDE.md')
const agents = join(root, 'AGENTS.md')
const topicDir = join(root, 'docs', 'agents')
const BYTES_PER_TOKEN = 3.7
const CAP_TOKENS = 12_000
const CODEX_CAP_BYTES = 32 * 1024

const claudeText = readFileSync(claude, 'utf8')
const agentsText = readFileSync(agents, 'utf8')
assert.equal(claudeText.split('\n')[0], '@AGENTS.md', 'CLAUDE.md must start with @AGENTS.md or Claude never reads AGENTS.md')

const agentsBytes = statSync(agents).size
const bytes = statSync(claude).size + agentsBytes
const tokens = Math.round(bytes / BYTES_PER_TOKEN)
assert.ok(
  tokens <= CAP_TOKENS,
  `CLAUDE.md + AGENTS.md are ${bytes} bytes (~${tokens} tokens) over the ${CAP_TOKENS}-token cap - move the story to docs/design-notes.md, keep the rule`,
)
assert.ok(agentsBytes <= CODEX_CAP_BYTES, `AGENTS.md is ${agentsBytes} bytes; Codex stops reading at ${CODEX_CAP_BYTES}`)

const topics = existsSync(topicDir) ? readdirSync(topicDir).filter((f) => f.endsWith('.md')) : []
for (const f of topics) assert.ok(agentsText.includes(`docs/agents/${f}`), `docs/agents/${f} is not linked from AGENTS.md, so no agent will ever read it`)

const count = (t) => t.split('\n').filter((l) => l.startsWith('## ')).length
const headings = count(agentsText) + topics.reduce((n, f) => n + count(readFileSync(join(topicDir, f), 'utf8')), 0)
assert.ok(headings > 40, `only ${headings} sections - the rules were gutted, not trimmed`)

console.log(`claudemd: ${bytes} bytes loaded per turn, ~${tokens} tokens (cap ${CAP_TOKENS}); AGENTS.md ${agentsBytes} bytes; ${headings} sections across AGENTS.md + ${topics.length} topic files`)
