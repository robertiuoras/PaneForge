#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'pf-prompt-review-'))
const out = join(temp, 'prompt-review.cjs')

await build({
  entryPoints: [join(repo, 'src/main/promptReview.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [{
    name: 'electron-stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
        contents: `exports.app={getPath(){return ${JSON.stringify(temp)}}}`,
        loader: 'js'
      }))
    }
  }]
})

const api = createRequire(import.meta.url)(out)
const now = new Date(2026, 8, 20, 12).getTime()
const day = 24 * 60 * 60 * 1000
const session = { id: 'pane_1', title: 'Daily review', cwd: '/work/project', agent: 'codex' }
api.recordPromptReview(session, 'exact first line\nexact second line', now - 1_000)
api.recordPromptReview({ ...session, id: 'pane_2', agent: 'claude' }, 'older this week', now - 2 * day)
api.recordPromptReview({ ...session, id: 'pane_old' }, 'outside the week', now - 8 * day)

assert.deepEqual(api.promptsForSession('pane_1').map((x) => x.text), ['exact first line\nexact second line'])
assert.deepEqual(api.promptsForSession('pane_2').map((x) => x.text), ['older this week'])
assert.deepEqual(api.promptsForSession('../escape'), [])

const tokens = { today: 123, week: 456, at: now }
const history = [{ ...session, startedAt: now - 500, bytes: 0 }, { ...session, id: 'silent', agent: 'antigravity', startedAt: now - 400, bytes: 0 }]
let report = api.promptReview(tokens, now, history)
assert.equal(report.todayCount, 1)
assert.equal(report.weekCount, 2)
assert.equal(report.todaySessions, 2)
assert.deepEqual(report.weekAgents, ['antigravity', 'claude', 'codex'])
assert.equal(report.prompts[0].text, 'exact first line\nexact second line')
assert.equal(report.prompts.some((x) => x.text === 'outside the week'), false)
assert.deepEqual(report.tokens, tokens)

api.removePromptReview('pane_1')
report = api.promptReview(tokens, now, history)
assert.equal(report.todayCount, 0)
assert.equal(report.todaySessions, 2)
assert.equal(report.weekCount, 1)
assert.doesNotThrow(() => api.removePromptReview('../escape'), 'an invalid deletion target is ignored')

rmSync(temp, { recursive: true, force: true })
console.log('exact prompt review ledger: ok')
