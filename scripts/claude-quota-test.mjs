import assert from 'node:assert/strict'
import { claudeQuotaBlock, currentClaudeQuotaBlock, guardClaudeUsage } from '../src/main/claudeQuota.ts'

const at = '2026-09-24T04:59:59Z'
const payload = (primary, secondary, fable = 0) => [{
  provider: 'claude',
  usage: {
    primary: { usedPercent: primary, resetsAt: at },
    secondary: { usedPercent: secondary, resetsAt: at },
    extraRateWindows: [{ title: 'Fable only', window: { usedPercent: fable, resetsAt: at } }]
  }
}]

assert.equal(claudeQuotaBlock(payload(10, 99)), null)
assert.equal(claudeQuotaBlock(payload(100, 20))?.scope, 'five-hour')
assert.equal(claudeQuotaBlock(payload(10, 100))?.scope, 'weekly')
assert.equal(claudeQuotaBlock(payload(10, 20, 100), 'claude-fable-5-1')?.scope, 'fable')
assert.equal(claudeQuotaBlock(payload(10, 20, 100), 'claude-sonnet-5'), null)
assert.equal(claudeQuotaBlock({ nope: true }), null)
assert.match(claudeQuotaBlock(payload(10, 100))?.message ?? '', /Choose Codex or wait for the reset/)

// Non-Claude and asleep cards never touch the live monitor or refuse the operation.
await guardClaudeUsage('codex')
await guardClaudeUsage('claude', undefined, true)

if (process.argv.includes('--live')) {
  const live = await currentClaudeQuotaBlock(undefined, true)
  assert.ok(live, 'the live Claude quota should currently refuse a new request')
  console.log(`live Claude guard: ${live.scope} ${live.usedPercent}% -> refused`)
}

console.log('claude quota guard: ok')
