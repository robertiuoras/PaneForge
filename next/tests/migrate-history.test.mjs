import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateHistory } from '../scripts/migrate-history.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paneforge-migrate-'))
  const source = join(root, 'old-user-data')
  const target = join(root, 'next-data')
  mkdirSync(join(source, 'history'), { recursive: true })
  writeFileSync(join(source, 'config.json'), JSON.stringify({ providerKeys: { codex: 'must-not-migrate' } }))
  writeFileSync(join(source, 'history', 'pane_1.json'), JSON.stringify({ id: 'pane_1', resumeId: 'native-123', cwd: '/work/a', extra: { keep: true } }))
  writeFileSync(join(source, 'history', 'pane_1.log'), Buffer.from('raw\u001b[31m terminal\n'))
  return { root, source, target }
}

test('dry run discovers raw records without writing a target', () => {
  const f = fixture()
  try {
    const report = migrateHistory({ source: f.source, target: f.target })
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.counts.discovered, 1)
    assert.equal(report.counts.readOnlyIdentityUnverified, 1)
    assert.equal(report.sourceState.config, 'not migrated: may contain credentials')
    assert.equal(report.records[0].legacyPaneId, 'pane_1')
    assert.equal(report.records[0].nativeSessionId, 'native-123')
    assert.equal(report.records[0].readOnly, true)
    assert.equal(report.stagingPath, null)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('apply copies exact raw data, excludes config, verifies hashes, and is idempotent', () => {
  const f = fixture()
  try {
    const first = migrateHistory({ source: f.source, target: f.target, apply: true })
    assert.equal(first.counts.imported, 1)
    const record = first.records[0]
    const staged = join(first.stagingPath, 'records', record.migrationKey)
    assert.deepEqual(readFileSync(join(staged, 'metadata.json')), readFileSync(join(f.source, 'history', 'pane_1.json')))
    assert.deepEqual(readFileSync(join(staged, 'transcript.log')), readFileSync(join(f.source, 'history', 'pane_1.log')))
    assert.equal(first.activation, 'not performed; explicit cutover authorization is required')
    assert.equal(migrateHistory({ source: f.source, target: f.target, apply: true }).counts.alreadyPresent, 1)
    assert.equal(readFileSync(join(f.source, 'config.json'), 'utf8').includes('must-not-migrate'), true)
    assert.throws(() => readFileSync(join(first.stagingPath, 'config.json')))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('corrupt metadata is reported while orphan and large logs are preserved read-only', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.source, 'history', 'broken.json'), '{not json')
    const orphan = Buffer.from('orphan\u001b[31m transcript')
    const large = Buffer.alloc(9 * 1024 * 1024, 0x61)
    writeFileSync(join(f.source, 'history', 'orphan.log'), orphan)
    writeFileSync(join(f.source, 'history', 'large.json'), JSON.stringify({ id: 'large' }))
    writeFileSync(join(f.source, 'history', 'large.log'), large)
    const report = migrateHistory({ source: f.source, target: f.target })
    assert.equal(report.counts.discovered, 3)
    assert.equal(report.counts.unreadable, 1)
    assert.equal(report.records.some((r) => r.sourceId === 'broken'), false)
    const orphanRecord = report.records.find((r) => r.sourceId === 'orphan')
    assert.equal(orphanRecord.sourceKind, 'paneforge-history-orphan-log')
    assert.equal(orphanRecord.nativeSessionId, null)
    assert.equal(orphanRecord.metadata, null)
    const largeRecord = report.records.find((r) => r.sourceId === 'large')
    assert.equal(largeRecord.log.bytes, large.length)
    const applied = migrateHistory({ source: f.source, target: f.target, apply: true })
    const orphanStage = join(applied.stagingPath, 'records', orphanRecord.migrationKey, 'transcript.log')
    const largeStage = join(applied.stagingPath, 'records', largeRecord.migrationKey, 'transcript.log')
    assert.deepEqual(readFileSync(orphanStage), orphan)
    assert.equal(statSync(largeStage).size, large.length)
    assert.equal(migrateHistory({ source: f.source, target: f.target, apply: true }).counts.alreadyPresent, 3)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('requires an explicit target directory', () => {
  const f = fixture()
  try { assert.throws(() => migrateHistory({ source: f.source }), /--target is required/) }
  finally { rmSync(f.root, { recursive: true, force: true }) }
})
