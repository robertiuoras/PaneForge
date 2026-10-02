#!/usr/bin/env node
// Pins `src/shared/reviewPush.ts` + its hook in `src/main/reviews.ts`: a finished chat that
// needs Robert is ONE push on his phone (TaskDriver notify), from either desk; a finished
// report that needs nobody, one he already looked at, one its opener will report, and a copy
// of the other desk's row never push. `npm run test:reviewpush`.
//
// Never posts anywhere: every post goes to a fake fetch that refuses the real URL.
import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-reviewpush-'))
const home = join(work, 'home')
const userData = join(work, 'userData')
mkdirSync(home, { recursive: true })
const require = createRequire(import.meta.url)

const stubs = (packaged) => ({
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\/profile$/ }, () => ({ path: 'profile', namespace: 'stub' }))
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents: `exports.app={getPath(){return ${JSON.stringify(userData)}},isPackaged:${packaged}}`, loader: 'js'
    }))
    // The real token file is never read: home is a temp folder.
    b.onLoad({ filter: /^os$/, namespace: 'stub' }, () => ({
      contents: `exports.homedir=()=>${JSON.stringify(home)};exports.hostname=()=>'testdesk.local'`, loader: 'js'
    }))
    b.onLoad({ filter: /^profile$/, namespace: 'stub' }, () => ({ contents: 'exports.profileName=()=>undefined', loader: 'js' }))
  }
})
let bundles = 0
async function bundle(entry, packaged = false) {
  const out = join(work, `b${++bundles}.cjs`)
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', plugins: [stubs(packaged)] })
  return require(out)
}

const R = await bundle('src/shared/reviewPush.ts')

// What a finished chat's reply really ends with (done-close rows carry the reply as `report`).
const DRAFT = 'Drafted the reply to Angie and left it in Gmail drafts.\n\n## Next steps\n1. Review the draft in Gmail (Robert)\n2. Robert: send it once the dates look right'
const row = (over = {}) => ({
  id: 'done_s12_1800000000', sessionId: 's12', nativeSessionId: 'native-12', kind: 'result', proof: 'unverified',
  report: DRAFT, prompt: 'draft the reply', evidence: [], links: [], notify: true,
  title: 'Angie reply', provider: 'claude', cwd: 'C:\\Users\\Gamer\\Desktop\\Projects\\clients', reportPath: '/x.html',
  createdAt: '2026-10-02T00:00:00.000Z', attention: true, ...over
})
const ctx = (over = {}) => ({ read: false, opener: undefined, machine: 'PC', host: () => 'testdesk', ...over })

// ---- the rule ---------------------------------------------------------------------------
{
  const p = R.reviewPush(row(), ctx())
  assert.ok(p, 'a person step left: one push')
  assert.equal(p.title, 'Needs you: Review the draft in Gmail (Robert)')
  assert.equal(p.body, 'clients - Angie reply (PC)\n- Robert: send it once the dates look right', 'body: project, chat, machine, then the further steps')
  assert.equal(p.dedupe_key, 'paneforge-review:testdesk:done_s12_1800000000')
  assert.deepEqual([p.kind, p.category, p.source, p.priority], ['agent', 'agents', 'paneforge', 'normal'])
  assert.equal('href' in p, false, 'no href: a tap opens TaskDriver like the limit-wave push')
  assert.equal(R.reviewPush(row(), ctx()).dedupe_key, p.dedupe_key, 'the key is the same on every retry')
  assert.equal(R.reviewPush(row(), ctx({ machine: 'Mac' })).body.split('\n')[0], 'clients - Angie reply (Mac)')
  assert.equal(R.reviewPush(row({ cwd: '/Users/r/Projects/site/' }), ctx()).body.split('\n')[0], 'site - Angie reply (PC)', 'posix folder, trailing slash')

  const long = R.reviewPush(row({ report: `Done.\n\n## Next steps\n1. Robert: ${'approve the very long thing '.repeat(10)}` }), ctx())
  assert.ok(long.title.length <= 140 && long.title.endsWith('…'), `title clipped to 140: ${long.title.length}`)

  const decision = R.reviewPush(row({ kind: 'decision', report: 'Pick a plan: keep the $20 tier or move to $50.\n\nBoth are costed below.', title: 'Plan price' }), ctx())
  assert.equal(decision?.title, 'Decision for you: Plan price')
  assert.equal(decision.body, 'clients - Plan price (PC)\nPick a plan: keep the $20 tier or move to $50.', 'a decision says what is being decided')
  const blocked = R.reviewPush(row({ kind: 'blocked', report: 'The Vercel token was refused.\n\n## Next steps\n1. Robert: run vercel login on the PC', title: 'Deploy' }), ctx())
  assert.equal(blocked?.title, 'Blocked: Deploy')
  assert.equal(blocked.body, 'clients - Deploy (PC)\nThe Vercel token was refused.\n- Robert: run vercel login on the PC')

  // Nothing for the person: nothing on the phone (~70 a day of these, measured 2026-10-02).
  assert.equal(R.reviewPush(row({ report: 'Built it and the tests pass.\n\n## Next steps\n- None' }), ctx()), null, 'Next steps: None')
  assert.equal(R.reviewPush(row({ report: 'Built it.\n\n## Next steps\n1. Run the PC suite\n2. Merge the lane' }), ctx()), null, 'steps an agent can take are not his')
  assert.equal(R.reviewPush(row({ report: 'Built it.' }), ctx()), null, 'no steps at all')
  assert.equal(R.reviewPush(row(), ctx({ read: true })), null, 'he looked at the pane after it finished')
  assert.equal(R.reviewPush(row({ reviewedAt: '2026-10-02T00:01:00.000Z' }), ctx()), null, 'marked reviewed (Review or a GuardDeck receipt)')
  assert.equal(R.reviewPush(row({ origin: { id: 'mac', name: 'Mac', platform: 'darwin' } }), ctx()), null, "the other desk's copy: its owner pushes")
  assert.equal(R.reviewPush(row(), ctx({ opener: 'boss' })), null, 'an opener collects the summary and reports the steps')
  assert.equal(R.reviewPush(row({ notify: false }), ctx()), null, 'a row that asked for no card')
  assert.equal(R.reviewPush(row({ pushedAt: '2026-10-02T00:02:00.000Z' }), ctx()), null, 'already on his phone')
  assert.equal(R.reviewPush(row({ kind: 'decision', notify: false }), ctx()), null)
  let asked = 0
  R.reviewPush(row({ report: 'Built it.' }), ctx({ host: () => { asked++; return 'x' } }))
  assert.equal(asked, 0, 'the device name is asked only for a row that pushes')
}

// ---- delivery: once, retried, logged ------------------------------------------------------
{
  const payload = R.reviewPush(row(), ctx())
  const run = (answers) => {
    const posts = [], waits = [], log = [], marks = []
    let pushed
    return {
      posts, waits, log, marks,
      deps: {
        post: async (p) => { posts.push(p); const a = answers.shift(); if (a instanceof Error) throw a; return a },
        wait: async (ms) => { waits.push(ms) },
        pushedAt: () => pushed,
        markPushed: (id, at) => { marks.push(id); pushed = at },
        log: (line) => log.push(line),
        now: () => new Date('2026-10-02T01:00:00.000Z')
      }
    }
  }
  const ok = run([true])
  assert.equal(await R.deliverReviewPush('done_s12_1800000000', payload, ok.deps), 'sent')
  assert.equal(ok.posts.length, 1)
  assert.deepEqual(ok.marks, ['done_s12_1800000000'], 'pushedAt persisted on the row')
  assert.equal(await R.deliverReviewPush('done_s12_1800000000', payload, ok.deps), 'already')
  assert.equal(ok.posts.length, 1, 'a row with pushedAt is never posted again')
  assert.match(ok.log[0], /^2026-10-02T01:00:00\.000Z ok try 1\/3 paneforge-review:testdesk:done_s12_1800000000 "Needs you: Review the draft in Gmail \(Robert\)"$/)

  const bad = run([false, new Error('ECONNRESET'), false])
  assert.equal(await R.deliverReviewPush('r_bad', payload, bad.deps), 'failed')
  assert.equal(bad.posts.length, 3, 'three tries')
  assert.deepEqual(bad.waits, [10_000, 60_000], 'backoff before the second and third')
  assert.deepEqual(bad.marks, [], 'a failed push is never marked sent')
  assert.equal(bad.log.filter((l) => / failed try \d\/3 /.test(l)).length, 3, 'every attempt logged')
  assert.match(bad.log.at(-1), / gave up after 3 tries paneforge-review:testdesk:done_s12_1800000000$/)

  const late = run([false, true])
  assert.equal(await R.deliverReviewPush('r_late', payload, late.deps), 'sent')
  assert.equal(late.posts.length, 2)

  // A second notice while the first is still posting does not post again.
  let release
  const slow = run([])
  slow.deps.post = (p) => { slow.posts.push(p); return new Promise((r) => { release = r }) }
  const first = R.deliverReviewPush('r_slow', payload, slow.deps)
  assert.equal(await R.deliverReviewPush('r_slow', payload, slow.deps), 'in-flight')
  release(true)
  assert.equal(await first, 'sent')
  assert.equal(slow.posts.length, 1)
}

// ---- the hook in reviews.ts: the installed app's gate, the row, the log -------------------
const posts = []
globalThis.fetch = async (url, init) => {
  assert.notEqual(String(url), 'https://app.taskdriver.ai/api/app/admin/notify', 'a test never posts to the real TaskDriver')
  posts.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) })
  return { ok: true }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)) }
const native = { title: 'Angie reply', provider: 'claude', cwd: join(work, 'clients'), nativeSessionId: 'native-12' }
const input = (id, over = {}) => ({
  id, sessionId: 's12', nativeSessionId: 'native-12', kind: 'result', proof: 'unverified', report: DRAFT,
  prompt: 'draft the reply', completedAt: '2026-10-01T00:00:00.000Z', closeSession: true, notify: true, ...over
})
delete process.env.PF_DEVICE
process.env.TASKDRIVER_INGEST_TOKEN = 'secret-test-token-1234'
{
  delete process.env.PF_TASKDRIVER_NOTIFY_URL
  const dev = await bundle('src/main/reviews.ts', false)
  dev.recordReview(input('dev_copy'), native, true)
  dev.sendReviewNotice('dev_copy')
  await settle()
  assert.equal(posts.length, 0, 'a plain dev copy never pushes')
}
process.env.PF_TASKDRIVER_NOTIFY_URL = 'http://127.0.0.1:9/notify'
const rowFile = (id) => JSON.parse(readFileSync(join(userData, 'reviews', `${id}.json`), 'utf8'))
{
  const app = await bundle('src/main/reviews.ts', false)
  const held = app.recordReview(input('done_s12_1'), native, true)
  await settle()
  assert.equal(posts.length, 0, 'held: nothing before the pane has closed')
  app.sendReviewNotice('done_s12_1', false)
  await settle()
  assert.equal(posts.length, 1, 'the pane closed: one push')
  assert.equal(posts[0].url, 'http://127.0.0.1:9/notify')
  assert.equal(posts[0].auth, 'Bearer secret-test-token-1234')
  assert.equal(posts[0].body.title, 'Needs you: Review the draft in Gmail (Robert)')
  assert.equal(posts[0].body.dedupe_key, 'paneforge-review:testdesk:done_s12_1', 'host from the machine name, .local dropped')
  assert.match(posts[0].body.body, /^clients - Angie reply \((PC|Mac)\)\n- Robert: send it once the dates look right$/)
  assert.ok(rowFile('done_s12_1').pushedAt, 'pushedAt persisted on the row')
  app.sendReviewNotice('done_s12_1', false)
  app.recordReview(input('done_s12_1'), native, false)
  await settle()
  assert.equal(posts.length, 1, 'a second sweep and a retried record: still one (pushedAt is not part of the duplicate digest)')
  assert.equal(held.pushedAt, undefined)

  app.recordReview(input('done_s13_1', { sessionId: 's13' }), native, true)
  app.sendReviewNotice('done_s13_1', true)
  app.recordReview(input('done_s14_1', { sessionId: 's14' }), native, true)
  app.sendReviewNotice('done_s14_1', false, 'boss')
  app.recordReview(input('done_s15_1', { sessionId: 's15', report: 'Built it.\n\n## Next steps\n- None' }), native, true)
  app.sendReviewNotice('done_s15_1', false)
  await settle()
  assert.equal(posts.length, 1, 'looked at, reported by its opener, nothing left: no push')

  // An explicit decision report (pf-ctl review) is not held: it pushes as it is recorded.
  app.recordReview(input('decision_s16', { sessionId: 's16', kind: 'decision', report: 'Which logo goes on the invoice?', proof: 'claimed' }), native)
  await settle()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].body.title, 'Decision for you: Angie reply')

  const log = readFileSync(join(userData, 'phone-push.log'), 'utf8')
  assert.equal(log.trim().split('\n').length, 2, 'one line per attempt')
  assert.match(log, / ok try 1\/3 paneforge-review:testdesk:done_s12_1 "Needs you: Review the draft in Gmail \(Robert\)"/)
  assert.ok(!log.includes('secret-test-token'), 'the token is never logged')
}
{
  // A restart: a fresh module, the same rows on disk.
  const again = await bundle('src/main/reviews.ts', false)
  again.sendReviewNotice('done_s12_1', false)
  await settle()
  assert.equal(posts.length, 2, 'after a restart: still one push for the row')
}
{
  // The installed app pushes with no test endpoint (the real URL is refused by the fake).
  delete process.env.PF_TASKDRIVER_NOTIFY_URL
  const installed = await bundle('src/main/reviews.ts', true)
  const before = posts.length
  // Answered here and never sent: a refusal would leave its 10 s and 60 s retries running.
  const reached = []
  const fake = globalThis.fetch
  globalThis.fetch = async (url) => { reached.push(String(url)); return { ok: true } }
  installed.recordReview(input('done_s17_1', { sessionId: 's17' }), native, true)
  installed.sendReviewNotice('done_s17_1', false)
  await settle()
  globalThis.fetch = fake
  assert.deepEqual(reached, ['https://app.taskdriver.ai/api/app/admin/notify'], 'the installed app reaches for TaskDriver')
  assert.equal(posts.length, before)
  assert.ok(rowFile('done_s17_1').pushedAt)
}

// ---- doneClose hands the reading through: read, and the opener ---------------------------
{
  const main = await bundle('src/main/doneClose.ts', true)
  const shared = await bundle('src/shared/doneClose.ts')
  const NOW = 1_800_000_000_000
  const transcript = join(work, 'pane.jsonl')
  const line = (type, content) => JSON.stringify({ type, isSidechain: false, message: { role: type, content } })
  writeFileSync(transcript, [line('user', 'draft the reply'), line('assistant', [{ type: 'text', text: DRAFT }])].join('\n'))
  const reading = { id: 'p1', agent: 'claude', printed: NOW - 600_000, status: 'idle', lastKeyboard: NOW - 400_000, turnEndedAt: NOW - shared.AUTO_CLOSE_QUIET_MS - 1000, reply: undefined, runningAgents: 0 }
  const calls = []
  const deps = {
    enabled: () => true,
    readings: () => [reading],
    transcriptFor: () => transcript,
    resumeIdFor: () => 'native-1',
    history: () => [],
    titleOf: () => ({ title: 'Angie reply', cwd: '/Users/r/Projects/clients', agent: 'claude' }),
    otherwiseBusy: () => null,
    record: (i, n) => ({ ...i, ...n, reportPath: '/x', createdAt: 'now', attention: false }),
    notify: (...args) => calls.push(args),
    close: () => ({ closed: true }),
    noteClose: () => {},
    writeNotice: () => {},
    activity: () => {},
    openerOf: () => 'boss',
    finished: () => {},
    now: () => NOW
  }
  assert.deepEqual(main.sweepDoneClose(deps), ['p1'])
  assert.deepEqual(calls, [[shared.doneReviewId('p1', reading.turnEndedAt), false, 'boss']], 'notify(reviewId, read, opener)')
}

console.log(`review-push: ok (${posts.length} captured posts, none to the real URL)`)
