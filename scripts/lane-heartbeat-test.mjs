// Per-process panes files cannot overwrite a peer and must remain conservative whenever an
// inventory cannot be trusted. This uses a real child PID for the sleep/staleness case.
//
//   node scripts/lane-heartbeat-test.mjs

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const work = mkdtempSync(join(tmpdir(), 'pf-lane-heartbeat-'))
const repo = join(work, 'repo')
const git = join(repo, '.git')
const dir = join(git, 'paneforge-panes')
mkdirSync(git, { recursive: true })

const compiled = join(work, 'laneBoard.cjs')
buildSync({ entryPoints: [join(root, 'src/main/laneBoard.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const heartbeat = (chats) => require(compiled).heartbeat(repo, chats)
const old = Date.now() - 6 * 60 * 1000

function child() {
  return new Promise((resolveChild, reject) => {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    kid.on('error', reject)
    kid.on('spawn', () => resolveChild(kid))
  })
}

try {
  assert.equal(heartbeat(['first']), null, 'directory establishment is conservative on its first heartbeat')
  assert.deepEqual(heartbeat(['first']), new Set(['first']), 'the next heartbeat reads the established per-process file')

  const legacy = join(git, 'paneforge-panes.json')
  writeFileSync(legacy, JSON.stringify({ 'legacy-peer': { at: Date.now(), chats: ['legacy-chat'] } }))
  assert(heartbeat(['ours']).has('legacy-chat'), 'a live legacy inventory remains readable during rollout')
  const mirrored = JSON.parse(readFileSync(legacy, 'utf8'))
  assert(mirrored['legacy-peer']?.chats.includes('legacy-chat'), 'legacy publish retains its existing peer')
  assert(mirrored[`pf-${process.pid}`]?.chats.includes('ours'), 'legacy publish includes this per-process heartbeat')

  writeFileSync(legacy, '{bad', 'utf8')
  assert.equal(heartbeat(['ours']), null, 'malformed legacy inventory fails closed')
  writeFileSync(legacy, JSON.stringify({}), 'utf8')

  writeFileSync(join(dir, 'pf-not-a-pid.json'), JSON.stringify({ at: Date.now(), chats: [] }))
  assert.equal(heartbeat(['ours']), null, 'a malformed per-process filename fails closed')
  rmSync(join(dir, 'pf-not-a-pid.json'))
  writeFileSync(join(dir, 'pf-444.json'), '{bad', 'utf8')
  assert.equal(heartbeat(['ours']), null, 'a malformed per-process beat fails closed')
  rmSync(join(dir, 'pf-444.json'))

  writeFileSync(join(dir, 'pf-interrupted.tmp'), '{partial', 'utf8')
  assert(heartbeat(['ours']).has('ours'), 'an interrupted temp file does not strand a future writer')

  const legacyLive = await child()
  writeFileSync(legacy, JSON.stringify({ [`pf-${legacyLive.pid}`]: { at: old, chats: ['legacy-sleeping'] } }))
  assert(heartbeat(['ours']).has('legacy-sleeping'), 'a stale legacy beat keeps a process-confirmed live peer')
  legacyLive.kill()
  await new Promise((done) => legacyLive.once('close', done))
  assert(!heartbeat(['ours']).has('legacy-sleeping'), 'a stale legacy beat expires after its process exits')
  writeFileSync(legacy, JSON.stringify({}), 'utf8')

  const live = await child()
  writeFileSync(join(dir, `pf-${live.pid}.json`), JSON.stringify({ at: old, chats: ['sleeping-chat'] }))
  assert(heartbeat(['ours']).has('sleeping-chat'), 'a stale timestamp keeps a process-confirmed live peer')
  live.kill()
  await new Promise((done) => live.once('close', done))
  assert(!heartbeat(['ours']).has('sleeping-chat'), 'a stale beat is ignored after its process exits')
  console.log('lane heartbeat: legacy, malformed, interrupted, and live-process checks passed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
