#!/usr/bin/env node
// Pins `src/shared/reviewPush.ts`: a finished chat that left something for the person sends
// ONE phone push through TaskDriver; anything already seen, reviewed, pushed, copied from the
// other machine, or with nothing left for the person sends none. `npm run test:reviewpush`.
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-reviewpush-'))
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/reviewPush.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: join(work, 'p.cjs'), logLevel: 'error' })
const P = createRequire(join(work, 'x.cjs'))('./p.cjs')

let failed = 0
let passed = 0
function ok(name, cond, detail) {
  if (cond) passed++
  else {
    failed++
    console.log(`FAIL ${name}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`)
  }
}

// The shape of a real done-close row's report: a reply ending in a Next steps list.
const REPLY = `Draft is in Gmail drafts, subject "Quote for the deck".

Next steps:
1. Robert: read the draft in Gmail and press Send.
2. Robert: approve the $40 hosting charge on https://vercel.com/account/billing.`
const row = (over = {}) => ({
  id: 'done_s12-abc_1790900000', sessionId: 's12-abc', nativeSessionId: 'n1', kind: 'result', proof: 'unverified',
  report: REPLY, prompt: 'draft the quote email', notify: true, title: 'Quote email', provider: 'claude',
  cwd: '/Users/robertiuoras/Projects/clients', reportPath: '/x.html', createdAt: '2026-10-02T00:00:00.000Z',
  attention: false, paneNumber: 7, ...over
})

{
  const p = P.reviewPush(row(), 'mac')
  ok('person steps -> one push', !!p, p)
  ok('title is the first step', p?.title === 'For you: read the draft in Gmail and press Send.', p?.title)
  ok('body names the chat, machine and the other step', /^Chat 7 on the Mac \(clients, "Quote email"\) finished\. Also for you: approve the \$40/.test(p?.body ?? ''), p?.body)
  ok('dedupe key is per machine and row', p?.dedupe_key === 'paneforge-review-mac-done_s12-abc_1790900000', p?.dedupe_key)
  ok('opens the PaneForge tab in the app', p?.href === '/paneforge')
  ok('TaskDriver contract fields', p?.kind === 'agent' && p?.category === 'agents' && p?.source === 'paneforge' && p?.title.length <= 140 && p?.body.length <= 500, p)
  ok('data carries the row', p?.data?.reviewId === row().id && p?.data?.machine === 'mac' && p?.data?.paneNumber === 7, p?.data)
  ok('PC row says PC', /on the PC/.test(P.reviewPush(row(), 'pc')?.body ?? ''))
}
{
  const done = row({ report: 'All done. Tests 40/40 green, pushed.\n\nNext steps: None' })
  ok('nothing left for the person -> no push', P.reviewPush(done, 'mac') === null)
  ok('looked at when it finished -> no push', P.reviewPush(row(), 'mac', true) === null)
  ok('already reviewed -> no push', P.reviewPush(row({ reviewedAt: '2026-10-02T00:01:00.000Z' }), 'mac') === null)
  ok('already pushed -> no push', P.reviewPush(row({ pushSentAt: '2026-10-02T00:01:00.000Z' }), 'mac') === null)
  ok('a copy of the other machine\'s row -> no push (owner sends it)', P.reviewPush(row({ origin: { id: 'pc', name: 'PC', platform: 'win32' } }), 'mac') === null)
  ok('a pane with an opener -> no push (the opener reports its steps)', P.reviewPush(row(), 'mac', false, 's1-opener') === null)
  ok('no opener -> still pushes', P.reviewPush(row(), 'mac', false, undefined) !== null)
  ok('notify off -> no push', P.reviewPush(row({ notify: false }), 'mac') === null)
  ok('shell job -> no push', P.reviewPush(row({ provider: 'shell' }), 'mac') === null)
}
{
  const b = P.reviewPush(row({ kind: 'blocked', report: 'Sign in to Stripe on the Mac.\nThe key expired.' }), 'mac')
  ok('blocked -> its first line', b?.title === 'Stuck, needs you: Sign in to Stripe on the Mac.', b?.title)
  const d = P.reviewPush(row({ kind: 'decision', report: '\nPick plan A or B for the menu.' }), 'mac')
  ok('decision -> its first line', d?.title === 'Your call: Pick plan A or B for the menu.', d?.title)
  const long = P.reviewPush(row({ report: `Next steps:\n1. Robert: ${'x'.repeat(400)}` }), 'mac')
  ok('long step clipped to 140', long?.title.length === 140, long?.title.length)
}

console.log(`review-push: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
