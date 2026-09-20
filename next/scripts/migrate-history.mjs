#!/usr/bin/env node
/**
 * Additive Stage 4 importer for PaneForge's on-disk history.
 *
 * It deliberately writes a separate, byte-for-byte staging snapshot.  It does not
 * rewrite sessions.json, point Next at the result, or copy config.json (which may
 * contain provider credentials).  Activation and resume verification remain
 * separate, explicitly-authorised steps.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPORT_VERSION = 1
const COPY_CHUNK_BYTES = 1024 * 1024

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function fileHash(file) {
  const digest = createHash('sha256')
  const descriptor = openSync(file, 'r')
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  try {
    for (let bytes = readSync(descriptor, chunk); bytes > 0; bytes = readSync(descriptor, chunk)) digest.update(chunk.subarray(0, bytes))
  } finally { closeSync(descriptor) }
  return digest.digest('hex')
}

function copyWithHash(source, target) {
  const digest = createHash('sha256')
  const input = openSync(source, 'r')
  const output = openSync(target, 'w', 0o600)
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  try {
    for (let bytes = readSync(input, chunk); bytes > 0; bytes = readSync(input, chunk)) {
      digest.update(chunk.subarray(0, bytes))
      let offset = 0
      while (offset < bytes) offset += writeSync(output, chunk, offset, bytes - offset)
    }
  } finally { closeSync(input); closeSync(output) }
  return digest.digest('hex')
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
function humanReport(report) {
  return [
    'PaneForge Next migration report',
    `mode: ${report.mode}`,
    `source records discovered: ${report.counts.discovered}`,
    `records imported: ${report.counts.imported}`,
    `records already present: ${report.counts.alreadyPresent}`,
    `read-only records with unverified native identity: ${report.counts.readOnlyIdentityUnverified}`,
    `conflicts requiring a choice: ${report.counts.conflicts}`,
    `unreadable or corrupt records: ${report.counts.unreadable}`,
    `source path: ${report.source}`,
    `backup path: ${report.backupPath ?? 'none (dry run)'}`,
    `staging path: ${report.stagingPath ?? 'none (dry run)'}`,
    `source fingerprint: ${report.sourceFingerprint}`,
    `destination hash: ${report.destinationHash ?? 'not written'}`,
    `rollback pointer: ${report.rollbackPointer ?? 'not changed'}`,
    `activation: ${report.activation}`
  ].join('\n') + '\n'
}

function parseArgs(argv) {
  const args = { apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') args.apply = true
    else if (arg === '--source' || arg === '--target') {
      if (!argv[i + 1]) throw new Error(`${arg} requires a directory`)
      args[arg.slice(2)] = resolve(argv[++i])
    } else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function safeFile(file) {
  try { return lstatSync(file).isFile() ? statSync(file) : null } catch { return null }
}

function discover(source) {
  const history = join(source, 'history')
  const report = {
    source,
    records: [],
    unreadable: [],
    skipped: [],
    sourceState: {
      config: existsSync(join(source, 'config.json')) ? 'not migrated: may contain credentials' : 'absent',
      desk: ['desk.json', 'desk.exit.json', 'desk.prev.json', 'desk.recover'].filter((name) => existsSync(join(source, name)))
    }
  }
  if (!existsSync(history)) {
    report.unreadable.push({ sourceKind: 'history', reason: 'history directory is absent' })
    return report
  }
  let files
  try { files = readdirSync(history).sort() } catch (error) {
    report.unreadable.push({ sourceKind: 'history', reason: `cannot enumerate history: ${error.message}` })
    return report
  }
  const metadata = new Map()
  const logs = new Map()
  for (const name of files) {
    const match = /^([A-Za-z0-9_-]+)\.(json|log)$/.exec(name)
    if (!match) { report.skipped.push({ path: join(history, name), reason: 'unrecognised history filename' }); continue }
    const [, id, suffix] = match
    const path = join(history, name)
    const details = safeFile(path)
    if (!details) { report.unreadable.push({ sourceKind: `history.${suffix}`, sourceId: id, path, reason: 'not a regular readable file' }); continue }
    ;(suffix === 'json' ? metadata : logs).set(id, { path, bytes: details.size })
  }
  for (const [id, meta] of metadata) {
    let parsed
    try { parsed = JSON.parse(readFileSync(meta.path, 'utf8')) } catch (error) {
      report.unreadable.push({ sourceKind: 'history.metadata', sourceId: id, path: meta.path, reason: `invalid JSON: ${error.message}` })
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      report.unreadable.push({ sourceKind: 'history.metadata', sourceId: id, path: meta.path, reason: 'metadata is not an object' })
      continue
    }
    const log = logs.get(id)
    const metadataHash = fileHash(meta.path)
    const logHash = log ? fileHash(log.path) : null
    const sourceHash = hash(`history\0${id}\0${metadataHash}\0${logHash ?? ''}`)
    const migrationKey = hash(`paneforge-next-history-v1\0${id}\0${sourceHash}`)
    const identityVerified = false
    report.records.push({
      sourceKind: 'paneforge-history', sourceId: id, migrationKey, sourceHash,
      metadata: { path: meta.path, sha256: metadataHash, bytes: meta.bytes },
      log: log && { path: log.path, sha256: logHash, bytes: log.bytes },
      legacyPaneId: typeof parsed.id === 'string' ? parsed.id : id,
      nativeSessionId: typeof parsed.resumeId === 'string' ? parsed.resumeId : null,
      identityVerified,
      readOnly: true,
      continuation: 'unavailable: native provider identity and transcript evidence were not verified',
      metadataIdMatchesFilename: parsed.id === undefined || parsed.id === id
    })
    logs.delete(id)
  }
  for (const [id, log] of logs) {
    const logHash = fileHash(log.path)
    const sourceHash = hash(`history-orphan-log\0${id}\0${logHash}`)
    report.records.push({
      sourceKind: 'paneforge-history-orphan-log', sourceId: id,
      migrationKey: hash(`paneforge-next-history-v1\0orphan-log\0${id}\0${sourceHash}`), sourceHash,
      metadata: null, log: { path: log.path, sha256: logHash, bytes: log.bytes },
      legacyPaneId: null, nativeSessionId: null, identityVerified: false, readOnly: true,
      continuation: 'unavailable: orphan transcript has no metadata or verified native provider identity',
      metadataIdMatchesFilename: null
    })
  }
  return report
}

function destination(target, runId) { return join(target, 'migration-staging', runId) }

function writeRecord(record, dest) {
  const dir = join(dest, 'records', record.migrationKey)
  const manifest = join(dir, 'manifest.json')
  if (existsSync(manifest)) {
    const was = JSON.parse(readFileSync(manifest, 'utf8'))
    if (was.sourceHash === record.sourceHash) return 'alreadyPresent'
    return 'conflict'
  }
  mkdirSync(dir, { recursive: true })
  const metadataHash = record.metadata && copyWithHash(record.metadata.path, join(dir, 'metadata.json'))
  const logHash = record.log && copyWithHash(record.log.path, join(dir, 'transcript.log'))
  const stagedMetadata = record.metadata && JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))
  const verification = {
    metadata: !record.metadata || metadataHash === record.metadata.sha256,
    log: !record.log || logHash === record.log.sha256,
    legacyPaneId: !record.metadata || (stagedMetadata.id === undefined ? record.legacyPaneId === record.sourceId : stagedMetadata.id === record.legacyPaneId),
    nativeSessionId: !record.metadata || (stagedMetadata.resumeId ?? null) === record.nativeSessionId
  }
  if (!verification.metadata || !verification.log || !verification.legacyPaneId || !verification.nativeSessionId) throw new Error(`verification failed for ${record.sourceId}`)
  writeFileSync(manifest, json({ ...record, metadata: { ...record.metadata, path: undefined }, log: record.log && { ...record.log, path: undefined }, verification }))
  return 'imported'
}

export function migrateHistory({ source, target, apply = false }) {
  if (!source) throw new Error('--source is required')
  if (!target) throw new Error('--target is required, even for a dry run')
  const discovered = discover(resolve(source))
  const sourceFingerprint = hash(json(discovered.records.map(({ migrationKey, sourceHash }) => ({ migrationKey, sourceHash }))))
  const runId = `paneforge-history-v1-${sourceFingerprint.slice(0, 16)}`
  const report = {
    version: REPORT_VERSION, mode: apply ? 'apply' : 'dry-run', createdAt: new Date().toISOString(),
    source: discovered.source, target: resolve(target), runId, sourceFingerprint,
    sourceState: discovered.sourceState, records: discovered.records,
    counts: { discovered: discovered.records.length, imported: 0, alreadyPresent: 0, readOnlyIdentityUnverified: discovered.records.length, conflicts: 0, unreadable: discovered.unreadable.length },
    unreadable: discovered.unreadable, skipped: discovered.skipped,
    backupPath: apply ? join(resolve(target), 'migration-backups', runId) : null,
    stagingPath: apply ? destination(resolve(target), runId) : null,
    rollbackPointer: null,
    activation: 'not performed; explicit cutover authorization is required'
  }
  if (!apply) return report
  const backup = report.backupPath
  const staging = report.stagingPath
  mkdirSync(backup, { recursive: true })
  // The backup is an exact source snapshot for every importable raw file.
  for (const record of discovered.records) {
    const b = join(backup, 'history', record.sourceId)
    mkdirSync(b, { recursive: true })
    const metadataHash = record.metadata && copyWithHash(record.metadata.path, join(b, 'metadata.json'))
    const logHash = record.log && copyWithHash(record.log.path, join(b, 'transcript.log'))
    if ((record.metadata && metadataHash !== record.metadata.sha256) || (record.log && logHash !== record.log.sha256)) {
      throw new Error(`backup hash verification failed for ${record.sourceId}`)
    }
  }
  for (const record of discovered.records) {
    const result = writeRecord(record, staging)
    report.counts[result] += 1
  }
  report.destinationHash = hash(json(discovered.records.map((record) => ({ migrationKey: record.migrationKey, sourceHash: record.sourceHash }))))
  writeFileSync(join(staging, 'import-report.json'), json(report))
  writeFileSync(join(staging, 'import-report.txt'), humanReport(report))
  writeFileSync(join(backup, 'manifest.json'), json({ version: REPORT_VERSION, source: report.source, records: discovered.records.map((r) => ({ sourceId: r.sourceId, sourceHash: r.sourceHash, metadata: r.metadata, log: r.log })) }))
  return report
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('Usage: node scripts/migrate-history.mjs --source OLD_USER_DATA --target NEXT_DATA_DIR [--apply]\n')
    return
  }
  const report = migrateHistory(args)
  process.stdout.write(json(report))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
