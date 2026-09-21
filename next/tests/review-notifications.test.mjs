import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { noticePaths, deliverReviewNotice, reviewNoticeReceipt, acknowledgeReviewNotice } from '../server/review-notifications.mjs';

test('GuardDeck paths are namespaced and reject path traversal', () => {
  const paths = noticePaths({ id: 'turn_123' }, '/fixture');
  assert.match(paths.id, /^next_turn_123_[a-f0-9]{16}$/);
  assert.equal(paths.report, join('/fixture', 'Library', 'Application Support', 'claude-orchestrator-next', 'reviews', `${paths.id}.html`));
  assert.throws(() => noticePaths({ id: '../escape' }));
});
test('isolated notices persist once; informational review receipts cannot clear decisions', { skip: process.platform !== 'darwin' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'next-notice-'));
  const oldHome = process.env.HOME, oldEnabled = process.env.PANEFORGE_NOTIFICATIONS;
  process.env.HOME = home;
  process.env.PANEFORGE_NOTIFICATIONS = '1';
  try {
    const record = { id: 'turn_test', kind: 'result', notify: true, title: 'Build done', report: 'Verified source test', lane: 'b', reportPath: join(home, 'source.html') };
    writeFileSync(record.reportPath, '<html>Retained report</html>');
    const paths = noticePaths(record);
    assert.equal(deliverReviewNotice({ ...record, notify: false }), false);
    assert.equal(existsSync(paths.notice), false);
    assert.equal(deliverReviewNotice(record), true);
    const first = readFileSync(paths.notice, 'utf8');
    assert.equal(JSON.parse(first).result.reportPath, paths.report);
    assert.equal(readFileSync(paths.report, 'utf8'), '<html>Retained report</html>');
    assert.equal(deliverReviewNotice(record), true);
    assert.equal(readFileSync(paths.notice, 'utf8'), first);
    mkdirSync(dirname(paths.receipt), { recursive: true });
    writeFileSync(paths.receipt, JSON.stringify({ id: 'wrong', reviewedAt: new Date().toISOString() }));
    assert.equal(reviewNoticeReceipt(record), null);
    acknowledgeReviewNotice(record);
    assert.ok(reviewNoticeReceipt(record));
    assert.equal(reviewNoticeReceipt({ ...record, kind: 'decision' }), null);
    assert.equal(deliverReviewNotice(record), false);
    const blocked = { ...record, id:'blocked_test', kind:'blocked', report:'Interrupted task' };
    assert.equal(deliverReviewNotice(blocked), true);
    const blockedPaths = noticePaths(blocked);
    const completion = { ...record, id:'late_completion', report:'Task finished' };
    assert.equal(deliverReviewNotice(completion), true);
    writeFileSync(blocked.reportPath, '<html>Superseded interruption</html>');
    const resolved = { ...blocked, resolvedAt:new Date().toISOString(), resolvedBy:completion.id };
    assert.equal(deliverReviewNotice(resolved), true);
    const superseded = JSON.parse(readFileSync(blockedPaths.receipt, 'utf8'));
    assert.equal(superseded.id, blockedPaths.id);assert.equal(superseded.opened,false);
    assert.equal(superseded.reviewedAt,undefined);
    assert.equal(readFileSync(blockedPaths.report,'utf8'),'<html>Superseded interruption</html>');
    assert.equal(reviewNoticeReceipt(resolved),null);
    assert.equal(existsSync(noticePaths(completion).receipt),false);
    assert.equal(reviewNoticeReceipt(completion),null);
    assert.equal(deliverReviewNotice(resolved),true);
    assert.deepEqual(JSON.parse(readFileSync(blockedPaths.receipt,'utf8')),superseded);
    const corrected = { ...record, report: 'A corrected result needs another review' };
    assert.notEqual(noticePaths(corrected).id, paths.id);
    assert.equal(reviewNoticeReceipt(corrected), null);
    assert.equal(deliverReviewNotice(corrected), true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldEnabled === undefined) delete process.env.PANEFORGE_NOTIFICATIONS; else process.env.PANEFORGE_NOTIFICATIONS = oldEnabled;
    rmSync(home, { recursive: true, force: true });
  }
});
