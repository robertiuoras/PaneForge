// What the agents on this machine spent, counted from their own transcripts.
//
// The rows below are REAL lines, copied out of a live Claude Code transcript and a
// Codex rollout rather than written to suit the parser - which is the whole point of
// the first check: Claude Code writes the same assistant message three times while it
// streams, each copy carrying the finished usage block, so counting rows instead of
// messages trebles the day. Measured 2026-09-19 on
// ~/.claude/projects/-Users-robertiuoras-Projects-toolstash: msg_011CfAyw8AnjN4n3NffTQrzz,
// three rows a second apart, identical usage.
//
//   node scripts/token-tally-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-tokentally-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'tally.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/tokenTally.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { readTokenRow, tallyTokens, dayStart, weekStart, formatTokens } = createRequire(
  import.meta.url
)(out)

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`)
  if (!ok) failed++
}

const now = Date.now()
const at = (ms) => new Date(ms).toISOString()

/** A real assistant row, with only the timestamp moved. */
function claudeRow(ms, id, usage) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    requestId: 'req_011CfAyw7enQvEekKD2yPb4i',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 44167,
        cache_read_input_tokens: 23991,
        output_tokens: 482,
        output_tokens_details: { thinking_tokens: 204 },
        service_tier: 'standard',
        ...usage
      }
    }
  })
}
const ONE = 2 + 44167 + 23991 + 482

// ---------- one message, however many rows it was written as ----------
{
  const noon = dayStart(now) + 12 * 3_600_000
  const streamed = [
    claudeRow(noon, 'msg_a'),
    claudeRow(noon + 1000, 'msg_a'),
    claudeRow(noon + 2000, 'msg_a')
  ].map(readTokenRow)
  check('a streamed message is read three times', streamed.every((r) => r && r.tokens === ONE))
  const spend = tallyTokens(streamed, now)
  check('and counted once', spend.today === ONE, String(spend.today))
  check('cache is part of what was spent', ONE > 60_000, String(ONE))

  const two = tallyTokens([...streamed, ...[claudeRow(noon, 'msg_b')].map(readTokenRow)], now)
  check('two messages are two spends', two.today === ONE * 2, String(two.today))
}

// ---------- which day it lands in ----------
{
  const today = readTokenRow(claudeRow(dayStart(now) + 60_000, 'msg_t'))
  const yesterday = readTokenRow(claudeRow(dayStart(now) - 60_000, 'msg_y'))
  const lastMonth = readTokenRow(claudeRow(weekStart(now) - 86_400_000, 'msg_o'))
  const spend = tallyTokens([today, yesterday, lastMonth], now)
  check('today is since local midnight', spend.today === ONE, String(spend.today))
  check('the week carries yesterday too', spend.week === ONE * 2, String(spend.week))
  check('anything older than the window is out', spend.week === ONE * 2)
  check('the week starts six days back, so today is in it', weekStart(now) === dayStart(now, 6))
}

// ---------- codex ----------
{
  const row = readTokenRow(
    JSON.stringify({
      type: 'event_msg',
      timestamp: at(dayStart(now) + 3_600_000),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 12345 },
          model_context_window: 272000
        }
      }
    })
  )
  check('a codex turn is a spend', row && row.tokens === 12345, JSON.stringify(row))
  // A rate-limit-only update carries no usage and must not read as a turn costing zero.
  const empty = readTokenRow(
    JSON.stringify({ type: 'event_msg', timestamp: at(now), payload: { type: 'token_count', info: null } })
  )
  check('a token_count with no usage is not a spend', empty === null)
}

// ---------- a file being appended to while it is read ----------
{
  check('half a line is skipped, never thrown', readTokenRow('{"type":"assist') === null)
  check('a blank line is skipped', readTokenRow('  ') === null)
  check('a row with no usage is skipped', readTokenRow('{"type":"user","message":{"role":"user"}}') === null)
  check(
    'a row from the future is not counted',
    tallyTokens([readTokenRow(claudeRow(now + 86_400_000, 'msg_f'))], now).week === 0
  )
}

// ---------- how it reads on a card ----------
{
  check('millions', formatTokens(1_480_000) === '1.5M', formatTokens(1_480_000))
  check('tens of millions lose the decimal', formatTokens(12_400_000) === '12M', formatTokens(12_400_000))
  check('thousands', formatTokens(340_500) === '341k', formatTokens(340_500))
  check('under a thousand is itself', formatTokens(912) === '912')
  check('nothing spent is 0, never NaN', formatTokens(0) === '0' && formatTokens(NaN) === '0')
}

console.log(failed ? `\n${failed} FAILED` : '\nall good')
process.exit(failed ? 1 : 0)
