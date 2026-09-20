import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const KEY = /^[a-f0-9]{64}$/
const NAME = /^[A-Za-z0-9_-]{1,160}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 100
const DEFAULT_TRANSCRIPT_BYTES = 120000
const MAX_TRANSCRIPT_BYTES = 512000

function regular(path, max = Infinity) {
  try { const details = lstatSync(path); return details.isFile() && details.size <= max ? statSync(path) : null } catch { return null }
}

function string(value, max = 1000) { return typeof value === 'string' && value.length <= max ? value : null }
function timestamp(value) { return Number.isFinite(value) ? value : null }
function opaqueId(key) { return `imported_${key}` }

function manifestRecord(root, runId, key) {
  const dir = join(root, runId, 'records', key)
  const manifestPath = join(dir, 'manifest.json')
  if (!regular(manifestPath, MAX_MANIFEST_BYTES)) return { malformed: 'manifest is missing or not a regular bounded file' }
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return { malformed: 'manifest is not valid JSON' } }
  if (!manifest || typeof manifest !== 'object' || manifest.migrationKey !== key || !KEY.test(manifest.sourceHash || '') || manifest.readOnly !== true || !['paneforge-history', 'paneforge-history-orphan-log'].includes(manifest.sourceKind)) return { malformed: 'manifest fields are invalid' }
  const orphan = manifest.sourceKind === 'paneforge-history-orphan-log'
  const metadataPath = join(dir, 'metadata.json')
  const transcriptPath = join(dir, 'transcript.log')
  const metadataDetails = regular(metadataPath, MAX_MANIFEST_BYTES)
  const transcriptDetails = regular(transcriptPath)
  if ((!orphan && !metadataDetails) || (manifest.log && !transcriptDetails) || (!manifest.log && transcriptDetails)) return { malformed: 'staged files do not match the manifest' }
  if (manifest.metadata && (!metadataDetails || manifest.metadata.bytes !== metadataDetails.size)) return { malformed: 'metadata bytes do not match the manifest' }
  if (manifest.log && (manifest.log.bytes !== transcriptDetails.size || !KEY.test(manifest.log.sha256 || ''))) return { malformed: 'transcript bytes or hash are invalid' }
  let metadata = null
  if (metadataDetails) {
    try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) } catch { return { malformed: 'staged metadata is not valid JSON' } }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (string(metadata.resumeId, 300) ?? null) !== (string(manifest.nativeSessionId, 300) ?? null)) return { malformed: 'metadata native identity does not match the manifest' }
  }
  const title = metadata ? string(metadata.title) : null
  const provider = metadata ? string(metadata.agent, 200) : null
  const model = metadata ? string(metadata.model, 200) : null
  return { record: {
    id: opaqueId(key), title, provider, model,
    nativeSessionId: string(manifest.nativeSessionId, 300),
    startedAt: metadata ? timestamp(metadata.startedAt) : null,
    endedAt: metadata ? timestamp(metadata.endedAt) : null,
    sourceKind: manifest.sourceKind, readOnly: true, resumable: false, detailId: opaqueId(key),
    transcript: { available: Boolean(transcriptDetails), bytes: transcriptDetails?.size ?? 0 },
    report: { runId, available: regular(join(root, runId, 'import-report.json'), MAX_MANIFEST_BYTES) !== null },
    _transcriptPath: transcriptDetails ? transcriptPath : null
  } }
}

function scan(dataDir) {
  const root = join(resolve(dataDir), 'migration-staging')
  const records = new Map()
  const malformed = []
  if (!existsSync(root)) return { records, malformed }
  let runs
  try { runs = readdirSync(root).filter((name) => NAME.test(name) && lstatSync(join(root, name)).isDirectory()).sort() } catch { return { records, malformed: ['migration staging is unreadable'] } }
  for (const runId of runs) {
    const recordRoot = join(root, runId, 'records')
    let keys
    try { keys = readdirSync(recordRoot).filter((key) => KEY.test(key) && lstatSync(join(recordRoot, key)).isDirectory()).sort() } catch { continue }
    for (const key of keys) {
      const result = manifestRecord(root, runId, key)
      if (result.malformed) { malformed.push({ runId, id: opaqueId(key), reason: result.malformed }); continue }
      if (!records.has(result.record.id)) records.set(result.record.id, result.record)
    }
  }
  return { records, malformed }
}

function publicRecord(record) { const { _transcriptPath, ...value } = record; return value }

export function listImportedHistory({ dataDir, query = '', limit = DEFAULT_LIMIT } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required')
  if (typeof query !== 'string' || query.length > 300) throw new Error('History query is invalid')
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('History limit is invalid')
  const needle = query.trim().toLowerCase()
  const { records, malformed } = scan(dataDir)
  const items = [...records.values()].filter((record) => !needle || [record.title, record.provider, record.model, record.nativeSessionId].filter(Boolean).join(' ').toLowerCase().includes(needle)).sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0) || a.id.localeCompare(b.id)).slice(0, limit).map(publicRecord)
  return { items, malformed }
}

export function readImportedHistoryDetail({ dataDir, id, maxBytes = DEFAULT_TRANSCRIPT_BYTES } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required')
  if (typeof id !== 'string' || !/^imported_[a-f0-9]{64}$/.test(id)) return null
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript limit is invalid')
  const record = scan(dataDir).records.get(id)
  if (!record) return null
  const transcript = { ...record.transcript, text: '', truncated: false }
  if (record._transcriptPath) {
    const descriptor = openSync(record._transcriptPath, 'r')
    const bytes = Math.min(maxBytes, transcript.bytes)
    const buffer = Buffer.allocUnsafe(bytes)
    let read = 0
    try { while (read < bytes) { const chunk = readSync(descriptor, buffer, read, bytes - read); if (!chunk) break; read += chunk } } finally { closeSync(descriptor) }
    transcript.text = buffer.subarray(0, read).toString('utf8')
    transcript.truncated = transcript.bytes > read
  }
  return { ...publicRecord(record), transcript }
}
