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
    assert.deepEqual(listed.items[0], { id: `imported_${key}`, title: 'Preserved Pane', provider: 'codex', model: 'gpt-6-astra', nativeSessionId: 'native-1', startedAt: 4, endedAt: 8, sourceKind: 'paneforge-history', readOnly: true, resumable: false, detailId: `imported_${key}`, transcript: { available: true, bytes: 18 }, report: { runId: 'run_a', available: true } })
    const detail = readImportedHistoryDetail({ dataDir: f.dataDir, id: listed.items[0].id, maxBytes: 6 })
    assert.equal(detail.transcript.text, 'first\n')
    assert.equal(detail.transcript.truncated, true)
    assert.equal(JSON.stringify(detail).includes(f.dataDir), false)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})

test('rejects malformed manifests, missing files, symlinks, and duplicate stable IDs safely', () => {
  const f = fixture()
  try {
    const duplicate = join(f.dataDir, 'migration-staging', 'run_b', 'records', key)
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'manifest.json'), '{not json')
    const badKey = 'd'.repeat(64)
    const bad = join(f.dataDir, 'migration-staging', 'run_a', 'records', badKey)
    mkdirSync(bad, { recursive: true })
    symlinkSync('/etc/hosts', join(bad, 'manifest.json'))
    const listed = listImportedHistory({ dataDir: f.dataDir })
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].id, `imported_${key}`)
    assert.equal(listed.malformed.length, 2)
    assert.equal(readImportedHistoryDetail({ dataDir: f.dataDir, id: 'imported_bad' }), null)
  } finally { rmSync(f.dataDir, { recursive: true, force: true }) }
})
