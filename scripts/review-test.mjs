#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { testChrome } from './test-chrome.mjs'
import { closeTestChrome } from './close-test-chrome.mjs'
import { Link } from './ui-lab.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

function closeAfterResultFromSource() {
  const source = readFileSync(join(repo, 'src/main/sessions.ts'), 'utf8')
  const start = source.indexOf('  closeAfterResult(id: string, reportedAt: number)')
  const end = source.indexOf('\n  killAll()', start)
  assert.ok(start >= 0 && end > start, 'closeAfterResult method is present')
  const method = source.slice(start, end).replace(
    /closeAfterResult\(id: string, reportedAt: number\): \{ closed: boolean; reason\?: string \} \{/,
    'function closeAfterResult(id, reportedAt) {'
  )
  // The flags it names come from `shared/doneClose.ts`, handed in as the one free name.
  return Function('closeHeldBy', `${method}; return closeAfterResult`)(doneClose.closeHeldBy)
}

function fakeManager(meta, busyUntil = 0) {
  const kills = []
  return {
    kills,
    sessions: new Map([['pane_1', { meta, busyUntil }]]),
    kill(id) { kills.push(id) }
  }
}
const temp = mkdtempSync(join(tmpdir(), 'pf-review-'))
const require = createRequire(import.meta.url)

async function reviewApi(name, { production = false } = {}) {
  const out = join(temp, `${name}.cjs`)
  await build({
    entryPoints: [join(repo, 'src/main/reviews.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    define: production ? { 'process.platform': '"darwin"' } : undefined,
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'stub' }))
        b.onResolve({ filter: /^\.\/profile$/ }, () => ({ path: 'profile', namespace: 'stub' }))
        b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
          contents: `exports.app={getPath(){return ${JSON.stringify(temp)}},isPackaged:${production}}`, loader: 'js'
        }))
        b.onLoad({ filter: /^os$/, namespace: 'stub' }, () => ({
          contents: `exports.homedir=()=>${JSON.stringify(temp)}`, loader: 'js'
        }))
        b.onLoad({ filter: /^profile$/, namespace: 'stub' }, () => ({ contents: 'exports.profileName=()=>undefined', loader: 'js' }))
      }
    }]
  })
  return require(out)
}

const api = await reviewApi('reviews')
const native = { title: 'Pane title', provider: 'codex', cwd: temp, nativeSessionId: 'native_1' }
const input = {
  id: 'done_1', sessionId: 'pane_1', nativeSessionId: 'native_1', kind: 'result',
  report: '<done>', prompt: 'fix it', proof: 'measured', evidence: ['test passed'],
  links: [{ label: 'site', url: 'https://example.test/a' }],
  completedAt: '2026-01-01T00:00:00.000Z', capturedAt: '2026-01-01T00:00:01.000Z',
  closeSession: true, workPreserved: true, noRemainingWork: true
}

const first = api.recordReview(input, native)
assert.equal(first.nativeSessionId, 'native_1')
assert.match(readFileSync(first.reportPath, 'utf8'), /&lt;done&gt;/)
assert.equal(api.recordReview(input, native).id, first.id)
rmSync(first.reportPath)
api.recordReview(input, native)
assert.ok(existsSync(first.reportPath), 'an idempotent retry repairs an interrupted HTML write')
assert.throws(() => api.recordReview({ ...input, report: 'different' }, native), /Conflicting duplicate/)
assert.throws(() => api.recordReview({ ...input, id: 'future_1', completedAt: '2999-01-01T00:00:00.000Z' }, native), /future/)
assert.throws(() => api.recordReview({ ...input, id: 'bad_link', links: [{ label: 'bad', url: 'http:javascript:alert(1)' }] }, native), /Invalid|Unsupported/)
assert.throws(() => api.recordReview({ ...input, id: 'bad_evidence', evidence: [''] }, native), /Invalid review evidence/)

assert.equal(api.acknowledgeReview('done_1', true).clearedAttention, true)
assert.ok(api.listReviews()[0].reviewedAt)
assert.equal(api.acknowledgeReview('done_1', false).clearedAttention, false)
assert.equal(api.listReviews()[0].attention, true)
const decision = api.recordReview({ ...input, id: 'decision_1', kind: 'decision', proof: 'claimed' }, native)
assert.equal(api.acknowledgeReview(decision.id, true).clearedAttention, false)
assert.equal(api.listReviews().find(r => r.id === decision.id).attention, true)
assert.equal(api.reviewOpenTarget('done_1', -1), first.reportPath)
assert.equal(api.reviewOpenTarget('done_1', 0), 'https://example.test/a')

const report = `## Findings

**Finished** and *checked*, with \`inline code\`.

> A retained quotation.

- First item
- [Evidence](https://example.test/proof?q=1&v=2)
  - Nested item

1. First step
2. Second step

| Check | Result |
| --- | --- |
| Build | Passed |

\`\`\`sh
# literal comment
echo '<script>'
\`\`\`

<script>alert('bad')</script>
[Unsafe](javascript:alert%281%29)
![Picture](https://example.test/image.png)
[Executable](file:///tmp/bad.command)
`
const formatted = api.recordReview({ ...input, id: 'formatted', report }, native)
const page = readFileSync(formatted.reportPath, 'utf8')
for (const fragment of ['<h2>Findings</h2>', '<strong>Finished</strong>', '<em>checked</em>', '<blockquote>', '<ul>', '<ol>', '<table>', '<pre><code class="language-sh">', '&lt;script&gt;', 'href="https://example.test/proof?q=1&amp;v=2"']) assert.ok(page.includes(fragment), `rendered report retains ${fragment}`)
assert.ok(!page.includes('<script>') && !page.includes('<img ') && !page.includes('href="javascript:') && !page.includes('href="file:///tmp/bad.command"'), 'report content cannot inject HTML, tracking images or executable links')
const sourceFile = join(temp, 'reviews', 'formatted.json')
const retainedSource = readFileSync(sourceFile, 'utf8')
writeFileSync(formatted.reportPath, '<p>old raw formatting</p>')
api.reviewOpenTarget('formatted', -1)
assert.equal(readFileSync(formatted.reportPath, 'utf8'), page, 'opening an existing report refreshes HTML from its retained report')
assert.equal(readFileSync(sourceFile, 'utf8'), retainedSource, 'rendering preserves the source record and its review state')
assert.equal(api.reviewOpenTarget('formatted', 'https://example.test/proof?q=1&v=2'), 'https://example.test/proof?q=1&v=2')
assert.equal(api.reviewOpenTarget('formatted', 'https://example.test/not-in-report'), null)
assert.equal(api.reviewOpenTarget('formatted', 'javascript:alert(1)'), null)
assert.equal(api.reviewOpenTarget('formatted', 'file:///tmp/bad.command'), null)

// Render the actual Review component and the actual saved page in an isolated PC
// test browser. No installed app, user desktop, retained report or agent is touched.
const componentJs = join(temp, 'review-dialog.js')
await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import ReviewDialog from './src/renderer/src/components/ReviewDialog'; createRoot(document.getElementById('root')).render(React.createElement(ReviewDialog,{onClose(){},onHistory(){},onReopen(){}}));`,
    resolveDir: repo, loader: 'tsx'
  },
  outfile: componentJs, bundle: true, platform: 'browser', format: 'iife',
  tsconfig: join(repo, 'tsconfig.web.json'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent'
})
const dialogHtml = join(temp, 'review-dialog.html')
const css = readFileSync(join(repo, 'src/renderer/src/styles.css'), 'utf8')
writeFileSync(dialogHtml, `<!doctype html><meta charset="utf-8"><style>:root{--text:#eee;--muted:#aaa;--accent:#f0a868;--line:#444;--surface-2:#222}body{margin:0}${css}</style><div id="root"></div><script>window.opened=[];window.api={listReviews:async()=>({reviews:${JSON.stringify([formatted]).replace(/</g, '\\u003c')}}),openReview:async(id,url)=>{window.opened.push([id,url]);return {opened:true}}};</script><script src="review-dialog.js"></script>`)
const chromePath = testChrome()
assert.ok(chromePath, 'rendering checks require the PC test browser')
const profile = join(temp, 'chrome-profile')
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let ws
try {
  const socket = await new Promise((resolve, reject) => {
    let stderr = ''
    const timeout = setTimeout(() => reject(new Error('Review test Chrome did not start')), 10_000)
    chrome.on('error', (error) => { clearTimeout(timeout); reject(error) })
    chrome.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Review test Chrome exited ${code}`)) })
    chrome.stderr.on('data', (data) => {
      stderr += data
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
  })
  ws = new WebSocket(socket)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject) })
  const browser = new Link(ws)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  // Link's page methods have no session argument; scope this link to the owned target.
  const send = browser.send.bind(browser)
  browser.send = (method, params = {}) => {
    const id = ++browser.seq
    return new Promise((res, rej) => {
      browser.pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  for (const [view, html] of [['Review', dialogHtml], ['saved page', formatted.reportPath]]) {
    const { pathToFileURL } = await import('node:url')
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: false })
    await browser.send('Page.navigate', { url: pathToFileURL(html).href })
    await browser.evaluate(`new Promise((resolve,reject)=>{const limit=Date.now()+5000;function ready(){if(document.querySelector(${JSON.stringify(view === 'Review' ? '.review-markdown' : '.report')})){resolve(true);return}const row=document.querySelector('.review-row');if(row&&row.getAttribute('aria-expanded')!=='true')row.click();if(Date.now()>limit){reject(new Error('report did not render'));return}requestAnimationFrame(ready)}ready()})`)
    const metrics = await browser.evaluate(`(() => {
      const report = document.querySelector(${JSON.stringify(view === 'Review' ? '.review-markdown' : '.report')})
      const list = report.querySelector('ul'), code = report.querySelector('pre'), quote = report.querySelector('blockquote')
      const bounds = report.getBoundingClientRect()
      return { h: report.querySelector('h2')?.textContent, bold: report.querySelector('strong')?.textContent,
        ul: report.querySelectorAll('ul').length, ol: report.querySelectorAll('ol').length,
        table: report.querySelector('table')?.rows.length, code: code?.textContent,
        marker: getComputedStyle(list).listStyleType, quoteBorder: parseFloat(getComputedStyle(quote).borderLeftWidth),
        width: bounds.width, right: bounds.right, unsafe: !!report.querySelector('script,img,a[href^="javascript:"],a[href$=".command"]') }
    })()`)
    assert.equal(metrics.h, 'Findings', `${view}: headings render`)
    assert.equal(metrics.bold, 'Finished', `${view}: bold renders`)
    assert.ok(metrics.ul === 2 && metrics.ol === 1 && metrics.table === 2, `${view}: nested lists and tables render`)
    assert.ok(metrics.code.includes("# literal comment\necho '<script>'"), `${view}: fenced code stays literal`)
    assert.ok(metrics.marker !== 'none' && metrics.quoteBorder > 0, `${view}: list markers and quotation styling are visible`)
    assert.ok(metrics.width > 0 && metrics.right <= 561 && !metrics.unsafe, `${view}: safe report fits a narrow view`)
    if (view === 'Review') {
      await browser.evaluate(`document.querySelector('.review-markdown a[href^="https://example.test/proof"]').click()`)
      assert.deepEqual(await browser.evaluate('window.opened'), [['formatted', 'https://example.test/proof?q=1&v=2']], 'inline link uses the validated Review opening path')
    }
    console.log(`review rendering passed: ${view} headings, bold, nested lists, quotes, links, tables and code observed at 560px`)
  }
  browser.send = send
} finally {
  await closeTestChrome(chrome, profile, ws)
}

mkdirSync(join(temp, 'history'), { recursive: true })
writeFileSync(join(temp, 'history', 'old_1.log'), 'retained')
const old = api.listReviews([{ id: 'old_1', title: 'Old', cwd: temp, agent: 'claude', startedAt: 1, endedAt: 2, bytes: 0, askLines: ['original ask'], resumeId: 'chat_1' }]).find(r => r.kind === 'closed')
assert.equal(old.prompt, 'original ask')
assert.equal(old.proof, 'unverified')
assert.equal(old.completedAt, undefined)

const doneCloseOut = join(temp, 'doneclose.cjs')
await build({ entryPoints: [join(repo, 'src/shared/doneClose.ts')], outfile: doneCloseOut, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
const doneClose = require(doneCloseOut)
const closeAfterResult = closeAfterResultFromSource()
const reportedAt = Date.now()
const safeMeta = { status: 'idle', lastKeyboard: reportedAt, drafting: false, ask: undefined, owedPrompt: false, handingOff: false }
for (const [patch, reason] of [
  [{ status: 'busy' }, /busy/], [{ job: 'job' }, /busy/], [{ drafting: true }, /draft/],
  [{ ask: { text: 'answer' } }, /question/], [{ owedPrompt: true }, /queued prompt/],
  [{ handingOff: true }, /handoff/], [{ lastKeyboard: reportedAt + 1 }, /newer user input/],
  // Each flag by name (s93, 27 Sep: one sentence for seven flags hid which one held it).
  [{ handoffOpen: 5 }, /^session has a handoff with open steps$/],
  [{ drafting: true, owedPrompt: true }, /^session has a draft, a queued prompt$/]
]) {
  const manager = fakeManager({ ...safeMeta, ...patch })
  assert.match(closeAfterResult.call(manager, 'pane_1', reportedAt).reason, reason)
  assert.deepEqual(manager.kills, [])
}
// A minute, not a millisecond: under load the next Date.now() is already past +1 and the
// busy refusal reads as a clean close (flaked 1 in 4 on 2026-09-23).
const busyManager = fakeManager(safeMeta, Date.now() + 60_000)
assert.match(closeAfterResult.call(busyManager, 'pane_1', reportedAt).reason, /busy/)
const safeManager = fakeManager(safeMeta)
assert.deepEqual(closeAfterResult.call(safeManager, 'pane_1', reportedAt), { closed: true })
assert.deepEqual(safeManager.kills, ['pane_1'])

const arm = { sessionId: 'pane_1', nativeSessionId: 'native_1', capturedAt: 100 }
assert.equal(api.reviewCloseArmAction(arm, { nativeSessionId: 'native_1', lastKeyboard: 100, idle: false }), 'wait')
assert.equal(api.reviewCloseArmAction(arm, { nativeSessionId: 'native_1', lastKeyboard: 100, idle: true }), 'close')
assert.equal(api.reviewCloseArmAction(arm, { nativeSessionId: 'native_2', lastKeyboard: 100, idle: true }), 'cancel')
assert.equal(api.reviewCloseArmAction(arm, { nativeSessionId: 'native_1', lastKeyboard: 101, idle: true }), 'cancel')
assert.equal(api.reviewCloseArmAction(arm, { nativeSessionId: 'native_1', lastKeyboard: 100, pendingWork: true, idle: true }), 'cancel')

const prod = await reviewApi('production', { production: true })
const sent = prod.recordReview({ ...input, id: 'notice_1', notify: true }, native)
const notice = join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_1.json')
assert.ok(existsSync(notice), 'production notifications are spooled once')
// What GuardDeck's next-prompt box hands to `pf continue`; the older four fields stay.
const spooled = JSON.parse(readFileSync(notice, 'utf8')).result
assert.deepEqual(spooled, {
  id: 'notice_1', kind: 'result', reportPath: sent.reportPath,
  sessionId: 'pane_1', resumeId: 'native_1', cwd: temp, agent: 'codex', machine: 'mac',
  // Contract v1: the pane is on no desk and has no rollout, so only `app` is known.
  app: 'paneforge'
})
assert.equal(prod.recordReview({ ...input, id: 'notice_1', notify: true }, native).noticeSentAt, sent.noticeSentAt)
// A shell (a compute job's observer) has no conversation, so no id to continue it by.
prod.recordReview({ ...input, id: 'notice_shell', notify: true }, { ...native, provider: 'shell' })
const shellNotice = JSON.parse(readFileSync(join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_shell.json'), 'utf8')).result
assert.equal(shellNotice.resumeId, undefined)
assert.equal(shellNotice.agent, 'shell')
// `hold`: a finished chat's row is written before its pane closes, its card only after
// (s93, 27 Sep: a card for a pane whose close was then refused). A retry holds too.
const heldPath = join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_held.json')
const held = prod.recordReview({ ...input, id: 'notice_held', notify: true }, native, true)
prod.recordReview({ ...input, id: 'notice_held', notify: true }, native, true)
assert.ok(!existsSync(heldPath) && !held.noticeSentAt, 'held: the row, no card')
prod.sendReviewNotice('notice_held')
assert.ok(existsSync(heldPath), 'sent once the pane has closed')
prod.recordReview({ ...input, id: 'notice_quiet', notify: false }, native, true)
prod.sendReviewNotice('notice_quiet')
assert.ok(!existsSync(join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_quiet.json')), 'a row that asked for no card gets none')

// Only an explicit Review acknowledgement or GuardDeck reviewed receipt suppresses
// a new delivery. Focus is used for close timing, never written as a review receipt.
for (const via of ['review', 'guarddeck']) {
  const id = `notice_reviewed_${via}`
  prod.recordReview({ ...input, id, notify: true }, native, true)
  if (via === 'review') prod.acknowledgeReview(id, true)
  else writeFileSync(join(temp, '.claude', 'guarddeck', 'result-receipts', `${id}.json`), JSON.stringify({ id, reviewedAt: new Date().toISOString() }))
  prod.sendReviewNotice(id)
  assert.ok(!existsSync(join(temp, '.claude', 'guarddeck', 'notices', `paneforge-review-${id}.json`)), `${via}: an explicitly reviewed result gets no duplicate card`)
  assert.equal(prod.listReviews().find(r => r.id === id).attention, false)
}
prod.acknowledgeReview('notice_reviewed_review', false)
prod.sendReviewNotice('notice_reviewed_review')
assert.ok(existsSync(join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_reviewed_review.json')), 'marking unread permits delivery again')

// Execute the held-card close callback used by reviews:record, retries and kill.
// Both paths must keep the receipt absent even when the pane was looked at.
const mainSource = readFileSync(join(repo, 'src/main/index.ts'), 'utf8')
const callbackStart = mainSource.indexOf('function cardAfterClose(')
const callbackEnd = mainSource.indexOf("\nipcMain.handle('reviews:record'", callbackStart)
assert.ok(callbackStart >= 0 && callbackEnd > callbackStart)
const callbackSource = mainSource.slice(callbackStart, callbackEnd).replace(
  'function cardAfterClose(paneId: string): (closed: boolean) => void',
  'function cardAfterClose(paneId)'
)
const heldCards = new Map()
let endedAt = 100
const cardAfterClose = Function('heldCards', 'manager', 'sendReviewNotice', `${callbackSource}; return cardAfterClose`)(
  heldCards, { turnRead: () => ({ endedAt, read: true }) }, prod.sendReviewNotice
)
prod.recordReview({ ...input, id: 'notice_looked', notify: true }, native, true)
heldCards.set('pane_1', { reviewId: 'notice_looked', turn: endedAt })
cardAfterClose('pane_1')(false)
assert.equal(heldCards.has('pane_1'), true, 'a refused close retains the held card')
const lookedNotice = join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_looked.json')
assert.ok(!existsSync(lookedNotice))
cardAfterClose('pane_1')(true)
assert.ok(existsSync(lookedNotice), 'a looked-at held result delivers after the real close')
assert.ok(!existsSync(join(temp, '.claude', 'guarddeck', 'result-receipts', 'notice_looked.json')), 'the close does not fabricate an acknowledgement')
assert.equal(prod.listReviews().find(r => r.id === 'notice_looked').attention, true, 'the delivered looked-at report remains unread')
heldCards.set('pane_1', { reviewId: 'notice_reviewed_guarddeck', turn: endedAt })
cardAfterClose('pane_1')(true)
assert.ok(!existsSync(join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_reviewed_guarddeck.json')), 'the held path respects an actual review receipt')
prod.recordReview({ ...input, id: 'notice_stale', notify: true }, native, true)
heldCards.set('pane_1', { reviewId: 'notice_stale', turn: endedAt })
endedAt++
cardAfterClose('pane_1')(true)
assert.equal(heldCards.has('pane_1'), false, 'an old turn is dropped without delivery')
assert.ok(!existsSync(join(temp, '.claude', 'guarddeck', 'notices', 'paneforge-review-notice_stale.json')))

// ---- finished-chat report contract v1: card number, app, context, session tokens ----------
// The maths on its own, over transcripts copied from real ones (every word redacted). The
// expected numbers were measured with an independent Python pass over the same fixtures.
const sharedOut = join(temp, 'shared-reviews.cjs')
await build({ entryPoints: [join(repo, 'src/shared/reviews.ts')], outfile: sharedOut, bundle: true, platform: 'node', format: 'cjs' })
const shared = require(sharedOut)
const fixture = (name) => readFileSync(join(repo, 'scripts', 'fixtures', name), 'utf8')
const claudeLines = fixture('review-tokens-claude.jsonl').split('\n')
// 7 messages streamed over 12 rows, the last row the CLI's own <synthetic> note.
assert.deepEqual(shared.transcriptTokens('claude', claudeLines), { context: { used: 162334, window: 1_000_000 }, sessionTokens: 24496 })
const sidechain = JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'msg_sub', model: 'claude-sonnet-5', usage: { input_tokens: 9e5, output_tokens: 9e5 } } })
assert.deepEqual(shared.transcriptTokens('claude', [...claudeLines, sidechain, '{"type":"assistant","mess']), shared.transcriptTokens('claude', claudeLines), 'a subagent row and a half-written line change nothing')
// Codex: the last token_count with info; the rate-limit-only update after it is not one.
assert.deepEqual(shared.transcriptTokens('codex', fixture('review-tokens-codex.jsonl').split('\n')), { context: { used: 44229, window: 258400 }, sessionTokens: 48436 })
assert.deepEqual(shared.transcriptTokens('claude', ['not json', '{"type":"user"}']), {}, 'nothing countable is nothing, never a zero')
assert.deepEqual(shared.transcriptTokens('codex', []), {})
assert.equal(shared.contextWindowFor('claude-sonnet-5', 90_000), 200_000)
assert.equal(shared.contextWindowFor('claude-sonnet-5', 250_000), 1_000_000, 'past 200k is the big window whatever the name says')
assert.equal(shared.contextWindowFor('claude-opus-4-8[1m]', 1), 1_000_000)
assert.equal(shared.contextWindowFor('claude-opus-5-5', 1), 1_000_000)
assert.equal(shared.contextWindowFor('claude-opus-4-8', 1), 200_000)
assert.equal(shared.contextWindowFor(undefined, 1), 200_000)
// The colour follows the percent the label shows: 49.5% reads "50% full" and is amber,
// 80.4% reads "80% full" and is amber, never red.
assert.equal(shared.contextLevel({ used: 98_999, window: 200_000 }), 'ok')
assert.equal(shared.contextLevel({ used: 99_000, window: 200_000 }), 'warn')
assert.equal(shared.contextLevel({ used: 160_999, window: 200_000 }), 'warn')
assert.equal(shared.contextPercent({ used: 160_999, window: 200_000 }), 80)
assert.equal(shared.contextLevel({ used: 161_000, window: 200_000 }), 'danger')
for (let used = 90_000; used <= 170_000; used += 250) {
  const c = { used, window: 200_000 }
  assert.equal(shared.contextLevel(c) === 'danger', shared.contextPercent(c) > 80, `${used}: red only past "80% full"`)
  assert.equal(shared.contextLevel(c) === 'ok', shared.contextPercent(c) < 50, `${used}: green only under "50% full"`)
}
assert.equal(shared.contextWords({ context: { used: 142_000, window: 200_000 }, sessionTokens: 3_400_000 }), '142k of 200k context used (71%) · 3.4M tokens this session')
assert.equal(shared.contextWords({}), '')

// Recorded: the card number off the desk as `pf list` counts it, the numbers off the chat's
// own transcript, and everything in the saved JSON.
const projects = join(temp, '.claude', 'projects', temp.replace(/[^A-Za-z0-9]/g, '-'))
mkdirSync(projects, { recursive: true })
writeFileSync(join(projects, 'chat_ctx_1.jsonl'), fixture('review-tokens-claude.jsonl'))
let deskNow = [{ id: 'pane_other' }, { id: 'pane_ctx' }]
api.setReviewDesk(() => deskNow)
const claudeNative = { title: 'Remember Use Colors', provider: 'claude', cwd: temp, nativeSessionId: 'chat_ctx_1' }
const longReply = `## Batch 2 **done**\n<script>alert(1)</script>\n\`\`\`sh\n# a comment, not a heading\n\`\`\`\n${'Every line of this reply has to reach the page. '.repeat(150)}\nLAST LINE`
assert.ok(longReply.length > 6000)
const ctxInput = { ...input, id: 'ctx_1', sessionId: 'pane_ctx', nativeSessionId: 'chat_ctx_1', report: longReply }
const ctx = api.recordReview(ctxInput, claudeNative)
assert.equal(ctx.paneNumber, 2)
assert.equal(ctx.app, 'paneforge')
assert.deepEqual(ctx.context, { used: 162334, window: 1_000_000 })
assert.equal(ctx.sessionTokens, 24496)
const saved = JSON.parse(readFileSync(join(temp, 'reviews', 'ctx_1.json'), 'utf8'))
assert.deepEqual([saved.paneNumber, saved.app, saved.context, saved.sessionTokens], [2, 'paneforge', { used: 162334, window: 1_000_000 }, 24496])
// The page: number and title first, the context line, and the WHOLE reply, escaped.
const html = readFileSync(ctx.reportPath, 'utf8')
assert.match(html, /<h1><span class="num">2<\/span> Remember Use Colors<\/h1>/)
assert.match(html, /162k of 1M context used \(16%\) · 24k tokens this session/)
assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>'), 'the reply is escaped')
assert.ok(html.includes('<h2>Batch 2 <strong>done</strong></h2>'), 'headings and bold keep their meaning')
assert.ok(html.includes('<pre><code class="language-sh"># a comment, not a heading\n</code></pre>'), 'a # inside a code block stays as written')
const shown = html.slice(html.indexOf('<div class="report">'), html.indexOf('</div>')).replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
assert.equal(shown.split('Every line of this reply has to reach the page.').length - 1, 150, 'all repeated content in a 6,000+ character reply is retained')
assert.ok(shown.startsWith('Batch 2 done') && shown.includes('<script>alert(1)</script>') && shown.includes('# a comment, not a heading') && shown.includes('LAST LINE'), 'headings, literal HTML, fenced code and the end of the reply are retained')
// A retry after the card moved is the same report, not a conflict.
deskNow = [{ id: 'pane_ctx' }]
assert.equal(api.recordReview(ctxInput, claudeNative).paneNumber, 2)
// A red chat says what to do about it.
writeFileSync(join(projects, 'chat_full.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 5, cache_read_input_tokens: 170_000, output_tokens: 10 } } }) + '\n')
const full = api.recordReview({ ...input, id: 'ctx_full', sessionId: 'pane_ctx', nativeSessionId: 'chat_full' }, { ...claudeNative, nativeSessionId: 'chat_full' })
assert.match(readFileSync(full.reportPath, 'utf8'), /170k of 200k context used \(85%\).* - clear before the next big job/)

// Absent on failure, never a blocked report: no transcript, an unreadable one, no card.
const gone = api.recordReview({ ...input, id: 'ctx_gone', sessionId: 'pane_gone', nativeSessionId: 'chat_gone' }, { ...claudeNative, nativeSessionId: 'chat_gone' })
assert.deepEqual([gone.paneNumber, gone.context, gone.sessionTokens, gone.app], [undefined, undefined, undefined, 'paneforge'])
mkdirSync(join(projects, 'chat_dir.jsonl'))
const unreadable = api.recordReview({ ...input, id: 'ctx_dir', sessionId: 'pane_ctx', nativeSessionId: 'chat_dir' }, { ...claudeNative, nativeSessionId: 'chat_dir' })
assert.deepEqual([unreadable.paneNumber, unreadable.context, unreadable.sessionTokens], [1, undefined, undefined])
api.setReviewDesk(() => { throw new Error('desk unreadable') })
assert.equal(api.recordReview({ ...input, id: 'ctx_nodesk', sessionId: 'pane_ctx', nativeSessionId: 'chat_ctx_1' }, claudeNative).paneNumber, undefined)
assert.ok(existsSync(join(temp, 'reviews', 'ctx_nodesk.json')))
// A Codex rollout reaches 128MB; its last token_count is the running total, so only the
// last 2MB is read, and the whole file only when that end has no token count.
process.env.CODEX_HOME = join(temp, '.codex')
const rollouts = join(temp, '.codex', 'sessions', '2026', '09', '27')
mkdirSync(rollouts, { recursive: true })
const codexRows = fixture('review-tokens-codex.jsonl').split('\n').filter(Boolean)
const codexTokenRows = codexRows.filter((l) => l.includes('"token_count"'))
const padRow = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4000) }] } })
const pad = (bytes) => {
  const rows = []
  for (let left = bytes; left > 0;) {
    const row = left > padRow.length + 1 + 200 ? padRow : JSON.stringify({ type: 'response_item', pad: 'y'.repeat(Math.max(0, left - 21)) }).slice(0, left - 1)
    rows.push(row)
    left -= row.length + 1
  }
  return rows.join('\n') + '\n'
}
const codexNative = (id) => ({ title: 'Codex chat', provider: 'codex', cwd: temp, nativeSessionId: id })
const meta = (id) => JSON.stringify({ type: 'session_meta', payload: { id, timestamp: '2026-09-27T01:00:00.000Z', cwd: temp } }) + '\n'
const earlyCount = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 7 }, total_token_usage: { input_tokens: 9, output_tokens: 1 }, model_context_window: 258400 } } })
// Long: the fixture's real token rows after 12MB of reply, so the end is all that is read.
const longId = '01a0ba4d-1ca3-7a01-97bd-4cbabdf30001'
writeFileSync(join(rollouts, `rollout-long-${longId}.jsonl`), meta(longId) + earlyCount + '\n' + pad(12 << 20) + codexTokenRows.join('\n') + '\n')
const nodeFs = require('node:fs')
const realReadSync = nodeFs.readSync
let readBytes = 0
nodeFs.readSync = (...a) => { const n = realReadSync(...a); readBytes += n; return n }
let long
try {
  long = api.recordReview({ ...input, id: 'codex_long', sessionId: 'pane_codex', nativeSessionId: longId }, codexNative(longId))
} finally {
  nodeFs.readSync = realReadSync
}
assert.deepEqual([long.context, long.sessionTokens], [{ used: 44229, window: 258400 }, 48436], 'the end of a long rollout has the final numbers')
assert.ok(readBytes < 3 << 20, `a 12MB rollout costs its last 2MB, not all of it (${readBytes} bytes read)`)
// Quiet end: the only token count is 3MB back, and the line cut in half at the 2MB mark
// ends in a whole-looking fake count. The fragment is skipped; the whole file is read.
const quietId = '01a0ba4d-1ca3-7a01-97bd-4cbabdf30002'
const fake = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 99 }, total_token_usage: { input_tokens: 999, output_tokens: 9 }, model_context_window: 258400 } } })
const quietEnd = pad((2 << 20) - fake.length - 1)
const quiet = meta(quietId) + earlyCount + '\n' + pad(3 << 20) + '{"type":"response_item"}' + fake + '\n' + quietEnd
assert.equal(Buffer.byteLength(quiet) - Buffer.byteLength(quiet.slice(0, quiet.lastIndexOf(fake))), 2 << 20, 'the 2MB mark falls on the fake count')
writeFileSync(join(rollouts, `rollout-quiet-${quietId}.jsonl`), quiet)
const quietReview = api.recordReview({ ...input, id: 'codex_quiet', sessionId: 'pane_codex', nativeSessionId: quietId }, codexNative(quietId))
assert.deepEqual([quietReview.context, quietReview.sessionTokens], [{ used: 7, window: 258400 }, 10], 'no count in the end reads the whole rollout, never a fragment')
delete process.env.CODEX_HOME

const oldPage = readFileSync(join(temp, 'reviews', 'done_1.html'), 'utf8')
assert.ok(!oldPage.includes('class="num"') && !oldPage.includes('class="ctx"'), 'a report with none of them draws neither')

// The GuardDeck notice carries the same four, and an `autoclose_` report (claude-config's
// autoclose.mjs sends no nativeSessionId; the app supplies the conversation) hands
// GuardDeck the conversation id `pf continue` reopens, not the pane id.
prod.setReviewDesk(() => [{ id: 'pane_x' }, { id: 'pane_y' }, { id: 'pane_ctx' }])
const auto = { id: 'autoclose_pane_ctx_1790000000', sessionId: 'pane_ctx', kind: 'result', proof: 'measured', evidence: ['180s countdown passed with nobody typing'], report: 'Done.', completedAt: input.completedAt, capturedAt: input.capturedAt, closeSession: true, workPreserved: true, noRemainingWork: true, notify: true }
prod.recordReview(auto, claudeNative)
const autoNotice = JSON.parse(readFileSync(join(temp, '.claude', 'guarddeck', 'notices', `paneforge-review-${auto.id}.json`), 'utf8')).result
assert.deepEqual(
  [autoNotice.sessionId, autoNotice.resumeId, autoNotice.paneNumber, autoNotice.app, autoNotice.context, autoNotice.sessionTokens],
  ['pane_ctx', 'chat_ctx_1', 3, 'paneforge', { used: 162334, window: 1_000_000 }, 24496]
)

rmSync(temp, { recursive: true, force: true })
console.log('review store and close-arm behaviour: ok')
