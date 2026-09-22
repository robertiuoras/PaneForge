import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listImportedHistory, readImportedHistoryDetail } from '../server/imported-history.mjs'

const key = 'a'.repeat(64)
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'paneforge-imported-history-'))
  const record = join(dataDir, 'migration-staging', 'run_a', 'records', key)
  mkdirSync(record, { recursive: true })
  writeFileSync(join(record, 'metadata.json'), JSON.stringify({ id: 'legacy-pane', title: 'Preserved Pane', agent: 'codex', model: 'gpt-6-astra', resumeId: 'native-1', startedAt: 4, endedAt: 8 }))
  writeFileSync(join(record, 'transcript.log'), 'first\nsecond\nthird')
  writeFileSync(join(record, 'manifest.json'), JSON.stringify({ migrationKey: key, sourceHash: 'b'.repeat(64), sourceKind: 'paneforge-history', readOnly: true, nativeSessionId: 'native-1', metadata: { bytes: statSync(join(record, 'metadata.json')).size }, log: { bytes: statSync(join(record, 'transcript.log')).size, sha256: 'c'.repeat(64) } }))
  writeFileSync(join(dataDir, 'migration-staging', 'run_a', 'import-report.json'), '{}')
  return { dataDir, record }
}

test('lists stable read-only staged records and returns bounded transcript detail', () => {
  const f = fixture()
  try {
    const listed = listImportedHistory({ dataDir: f.dataDir })
    assert.deepEqual(listed.malformed, [])
    assert.equal(listed.total, 1)
    assert.equal(listed.truncated, false)
    assert.deepEqual(listed.items[0], { id: `imported_${key}`, title: 'Preserved Pane', provider: 'codex', model: 'gpt-6-astra', nativeSessionId: 'native-1', startedAt: 4, endedAt: 8, sourceKind: 'paneforge-history', readOnly: true, resumable: false, detailId: `imported_${key}`, transcript: { available: true, bytes: 18 }, report: { runId: 'run_a', available: true } })
    const detail = readImportedHistoryDetail({ dataDir: f.dataDir, id: listed.items[0].id, maxBytes: 6 })
    assert.equal(detail.transcript.text, 'first\n')
    assert.equal(detail.transcript.truncated, true)
    assert.equal(JSON.stringify(detail).includes(f.dataDir), false)
    const secondKey = 'e'.repeat(64)
    const orphan = join(f.dataDir, 'migration-staging', 'run_a', 'records', secondKey)
    mkdirSync(orphan)
    writeFileSync(join(orphan, 'transcript.log'), 'orphan')
    writeFileSync(join(orphan, 'manifest.json'), JSON.stringify({ migrationKey: secondKey, sourceHash: 'f'.repeat(64), sourceKind: 'paneforge-history-orphan-log', readOnly: true, nativeSessionId: null, log: { bytes: 6, sha256: 'a'.repeat(64) } }))
    const limited = listImportedHistory({ dataDir: f.dataDir, limit: 1 })
    assert.equal(limited.total, 2)
    assert.equal(limited.truncated, true)
    assert.equal(limited.items.length, 1)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})

test('rejects malformed manifests, missing files, directory links, and duplicate stable IDs safely', () => {
  const f = fixture()
  try {
    const duplicate = join(f.dataDir, 'migration-staging', 'run_b', 'records', key)
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'manifest.json'), '{not json')
    const recordsLink = join(f.dataDir, 'migration-staging', 'run_c', 'records')
    mkdirSync(join(f.dataDir, 'migration-staging', 'run_c'), { recursive: true })
    symlinkSync(join(f.dataDir, 'migration-staging', 'run_a', 'records'), recordsLink, 'junction')
    const listed = listImportedHistory({ dataDir: f.dataDir })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].id, `imported_${key}`)
    assert.equal(listed.malformed.length, 2)
    assert.equal(readImportedHistoryDetail({ dataDir: f.dataDir, id: 'imported_bad' }), null)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})

test('rejects a file-symlinked manifest when file symlinks are supported', t => {
  const f = fixture()
  try {
    const badKey = 'd'.repeat(64)
    const bad = join(f.dataDir, 'migration-staging', 'run_a', 'records', badKey)
    const target = join(f.dataDir, 'linked-manifest-target')
    mkdirSync(bad, { recursive: true })
    writeFileSync(target, '{}')
    try { symlinkSync(target, join(bad, 'manifest.json'), 'file') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('file symlinks are unavailable for this user')
      throw error
    }
    const listed = listImportedHistory({ dataDir: f.dataDir })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.malformed.length, 1)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})

test('refuses a linked staging root', () => {
  const f = fixture()
  const linkedData = mkdtempSync(join(tmpdir(), 'paneforge-imported-history-link-'))
  try {
    symlinkSync(join(f.dataDir, 'migration-staging'), join(linkedData, 'migration-staging'), 'junction')
    const linked = listImportedHistory({ dataDir: linkedData })
    assert.equal(linked.items.length, 0)
    assert.equal(linked.malformed[0], 'migration staging is not a real directory')
  } finally { rmSync(f.dataDir, { recursive: true, force: true }); rmSync(linkedData, { recursive: true, force: true }) }
})

test('does not follow a transcript swapped for a file symlink when supported', t => {
  const f = fixture()
  try {
    const target = join(f.dataDir, 'linked-transcript-target')
    writeFileSync(target, 'untrusted transcript')
    rmSync(join(f.record, 'transcript.log'))
    try { symlinkSync(target, join(f.record, 'transcript.log'), 'file') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('file symlinks are unavailable for this user')
      throw error
    }
    assert.equal(readImportedHistoryDetail({ dataDir: f.dataDir, id: `imported_${key}` }), null)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})
