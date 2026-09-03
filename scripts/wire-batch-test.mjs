// The rule that stopped the mirrored screen stuttering.
//
// The device link used to put every scrap of output a program printed into its own
// encrypted message. Measured on this Mac 2026-09-03, one pane running
// `git --no-pager log -p -n 300` at 120x40 emitted 29,813 scraps in 1.24 seconds -
// 24,102 a second, median 96 bytes - and replaying that exact recording through the real
// connection cost 29,813 messages, 234ms of sender work and 6,005,172 bytes on the wire.
// Gathered into 16ms it was 83 messages, 48ms and 4,459,212 bytes, with every byte of the
// output still delivered in the same order.
//
// What is pinned here is the part that can silently go wrong: joining text out of order,
// losing the last words of a pane, or handing a device the same text twice.
//
//   node scripts/wire-batch-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'wire-batch.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/wireBatch.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { WireBatch, WIRE_BATCH_MS, WIRE_MAX_PENDING } = await import(pathToFileURL(outfile).href)

let failures = 0
function ok(cond, what) {
  if (cond) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}`)
}

console.log('wire batching')

// Nothing goes out early, and what does go out is the whole of it in order.
{
  const b = new WireBatch()
  ok(b.push('p1', 'he', 0).length === 0, 'a scrap of output waits rather than going out on its own')
  ok(b.push('p1', 'llo', 5).length === 0, 'a second scrap in the same window also waits')
  ok(b.due(10).length === 0, 'nothing is released before the wait is up')
  const out = b.due(WIRE_BATCH_MS)
  ok(out.length === 1 && out[0].id === 'p1' && out[0].data === 'hello', 'the scraps go out as one message, joined in the order they arrived')
  ok(b.idle, 'nothing is left waiting once it has gone out')
}

// Two panes are never mixed together.
{
  const b = new WireBatch()
  b.push('p1', 'one', 0)
  b.push('p2', 'two', 0)
  b.push('p1', '!', 1)
  const out = b.due(WIRE_BATCH_MS).sort((a, c) => a.id.localeCompare(c.id))
  ok(out.length === 2, 'two panes make two messages')
  ok(out[0].data === 'one!' && out[1].data === 'two', 'each pane carries only its own output')
}

// A firehose is not held back.
{
  const b = new WireBatch()
  const big = 'x'.repeat(WIRE_MAX_PENDING)
  const out = b.push('p1', big, 0)
  ok(out.length === 1 && out[0].data === big, 'a burst too big to hold goes out immediately')
  ok(b.idle, 'and nothing of it is left behind')
}

// A pane ending, and a device asking for one pane's history, must not lose or duplicate.
{
  const b = new WireBatch()
  b.push('p1', 'last words', 0)
  b.push('p2', 'still going', 0)
  const one = b.drain('p1')
  ok(one.length === 1 && one[0].data === 'last words', 'one pane can be released on its own')
  ok(b.drain('p1').length === 0, 'releasing the same pane twice sends nothing twice')
  const rest = b.drain()
  ok(rest.length === 1 && rest[0].id === 'p2', 'everything still waiting is released together')
  ok(b.idle, 'and the queue is empty afterwards')
}

// The caller only needs a timer while something is waiting.
{
  const b = new WireBatch()
  ok(b.nextDue(0) === null, 'no wait is needed when nothing is waiting')
  b.push('p1', 'a', 100)
  ok(b.nextDue(100) === WIRE_BATCH_MS, 'the wait is a full window for output that just arrived')
  ok(b.nextDue(100 + WIRE_BATCH_MS + 5) === 0, 'output past its window is due now, never a negative wait')
  b.forget('p1')
  ok(b.idle, 'output for a pane nobody watches any more is dropped')
}

// The whole point: far fewer messages, byte for byte the same output.
{
  const b = new WireBatch()
  let sent = ''
  let messages = 0
  let printed = ''
  for (let i = 0; i < 30000; i++) {
    const scrap = `line ${i}\r\n`
    printed += scrap
    // 24,102 scraps a second is one every 0.0415ms, which is the measured rate.
    const now = i * 0.0415
    for (const f of b.push('p1', scrap, now)) {
      messages++
      sent += f.data
    }
    for (const f of b.due(now)) {
      messages++
      sent += f.data
    }
  }
  for (const f of b.drain()) {
    messages++
    sent += f.data
  }
  ok(sent === printed, 'every byte the program printed arrives, in order')
  ok(messages < 200, `30,000 scraps become far fewer messages (${messages})`)
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
