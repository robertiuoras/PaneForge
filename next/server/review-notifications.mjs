import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const atomic = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
};
// GuardDeck accepts only its existing report directory contract. Keep a durable
// copy there, never loosen that consumer's path validation for another app.
export function noticePaths(record, home = homedir()) {
  if (!validId(record?.id)) throw Error('Invalid review notice identity');
  // GuardDeck receipts contain only their notice identity. Bind that identity to
  // the retained result so an old click cannot acknowledge a corrected report.
  const version = createHash('sha256').update(JSON.stringify([
    record.id, record.createdAt, record.nativeSessionId, record.kind,
    record.prompt, record.report, record.proof, record.links, record.evidence,
  ])).digest('hex').slice(0, 16);
  const id = `next_${record.id.slice(0, 80)}_${version}`;
  const root = join(home, '.claude', 'guarddeck');
  return {
    id,
    receipt: join(root, 'result-receipts', `${id}.json`),
    notice: join(root, 'notices', `paneforge-review-${id}.json`),
    report: join(home, 'Library', 'Application Support', 'claude-orchestrator-next', 'reviews', `${id}.html`),
  };
}
export function deliverReviewNotice(record) {
  if (process.platform !== 'darwin' || process.env.PANEFORGE_NOTIFICATIONS !== '1' || record.notify !== true) return false;
  const paths = noticePaths(record);
  if (reviewNoticeReceipt(record)) return false;
  if (!['result', 'decision', 'blocked'].includes(record.kind)) throw Error('Invalid review notice kind');
  // The supervisor owns reportPath; this operation only copies retained HTML.
  const report = readFileSync(record.reportPath);
  atomic(paths.report, report);
  if (!existsSync(paths.notice)) atomic(paths.notice, JSON.stringify({
    id: `paneforge-review-${paths.id}`, actor: 'paneforge',
    title: record.title, detail: record.report.slice(0, 1000),
    result: { id: paths.id, kind: record.kind, lane: record.lane, reportPath: paths.report },
  }));
  return true;
}
export function reviewNoticeReceipt(record) {
  if (record.kind !== 'result') return null;
  const paths = noticePaths(record);
  try {
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'));
    return receipt.id === paths.id && typeof receipt.reviewedAt === 'string' && Number.isFinite(Date.parse(receipt.reviewedAt))
      ? new Date(receipt.reviewedAt).toISOString() : null;
  } catch { return null; }
}
export function acknowledgeReviewNotice(record) {
  if (process.platform !== 'darwin' || process.env.PANEFORGE_NOTIFICATIONS !== '1' || record.kind !== 'result') return;
  const paths = noticePaths(record);
  atomic(paths.receipt, JSON.stringify({ id: paths.id, dismissedAt: new Date().toISOString(), reviewedAt: record.reviewedAt || new Date().toISOString(), opened: false }));
}
