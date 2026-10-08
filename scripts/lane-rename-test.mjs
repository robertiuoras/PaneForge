// Proof: the lane ledger write survives a Windows file held open for a moment.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, existsSync, utimesSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameSafe, sweepStaleTmp } from './lane-rename.mjs'

const box = () => mkdtempSync(join(tmpdir(), 'lane-rename-'))
const fail = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code })

test('a transient EPERM is retried and the rename lands', () => {
  const d = box(); const tmp = join(d, 'paneforge-lanes.json.1.tmp'); const to = join(d, 'paneforge-lanes.json')
  writeFileSync(tmp, 'new'); let calls = 0
  renameSafe(tmp, to, { pause() {}, rename(a, b) { if (++calls < 3) throw fail('EPERM'); return require_rename(a, b) } })
  assert.equal(calls, 3); assert.equal(readFileSync(to, 'utf8'), 'new'); assert.equal(existsSync(tmp), false)
  rmSync(d, { recursive: true })
})

test('a permanent failure leaves no tmp file and rethrows', () => {
  const d = box(); const tmp = join(d, 'paneforge-lanes.json.2.tmp'); writeFileSync(tmp, 'x')
  assert.throws(() => renameSafe(tmp, join(d, 'a'), { pause() {}, rename() { throw fail('EBUSY') } }), /EBUSY/)
  assert.deepEqual(readdirSync(d), [])
  const t2 = join(d, 'b.tmp'); writeFileSync(t2, 'x')
  assert.throws(() => renameSafe(t2, join(d, 'a'), { pause() {}, rename() { throw fail('ENOENT') } }), /ENOENT/)
  assert.deepEqual(readdirSync(d), [])
  rmSync(d, { recursive: true })
})

test('stale tmp litter is removed, live and recent ones kept', () => {
  const d = box(); const target = join(d, 'paneforge-lanes.json')
  for (const n of ['paneforge-lanes.json.111.tmp', 'paneforge-lanes.json.222.tmp', 'paneforge-lanes.json.333.tmp', 'paneforge-lanes.json', 'other.json.111.tmp']) writeFileSync(join(d, n), 'x')
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(join(d, 'paneforge-lanes.json.222.tmp'), old, old)
  const n = sweepStaleTmp(target, { isAlive: (pid) => pid !== 111 })
  assert.equal(n, 2)
  assert.deepEqual(readdirSync(d).sort(), ['other.json.111.tmp', 'paneforge-lanes.json', 'paneforge-lanes.json.333.tmp'])
  rmSync(d, { recursive: true })
})
import { renameSync as require_rename } from 'node:fs'
