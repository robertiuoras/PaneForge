#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

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
  return Function(`${method}; return closeAfterResult`)()
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

mkdirSync(join(temp, 'history'), { recursive: true })
writeFileSync(join(temp, 'history', 'old_1.log'), 'retained')
const old = api.listReviews([{ id: 'old_1', title: 'Old', cwd: temp, agent: 'claude', startedAt: 1, endedAt: 2, bytes: 0, askLines: ['original ask'], resumeId: 'chat_1' }]).find(r => r.kind === 'closed')
assert.equal(old.prompt, 'original ask')
assert.equal(old.proof, 'unverified')
assert.equal(old.completedAt, undefined)

const closeAfterResult = closeAfterResultFromSource()
const reportedAt = Date.now()
const safeMeta = { status: 'idle', lastKeyboard: reportedAt, drafting: false, ask: undefined, owedPrompt: false, handingOff: false }
for (const [patch, reason] of [
  [{ status: 'busy' }, /busy/], [{ job: 'job' }, /busy/], [{ drafting: true }, /draft/],
  [{ ask: { text: 'answer' } }, /question/], [{ owedPrompt: true }, /queued prompt/],
  [{ handingOff: true }, /handoff/], [{ lastKeyboard: reportedAt + 1 }, /newer user input/]
]) {
  const manager = fakeManager({ ...safeMeta, ...patch })
  assert.match(closeAfterResult.call(manager, 'pane_1', reportedAt).reason, reason)
  assert.deepEqual(manager.kills, [])
}
const busyManager = fakeManager(safeMeta, Date.now() + 1)
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
assert.equal(prod.recordReview({ ...input, id: 'notice_1', notify: true }, native).noticeSentAt, sent.noticeSentAt)

rmSync(temp, { recursive: true, force: true })
console.log('review store and close-arm behaviour: ok')
