import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const dir = mkdtempSync(join(tmpdir(), 'pf-accounts-'))
const originalExec = childProcess.execFile
let checks = 0
try {
  mkdirSync(join(dir, 'claude-memory', 'claude-config'), { recursive: true })
  writeFileSync(join(dir, 'claude-memory', 'claude-config', 'ai-accounts.mjs'), '')
  const outfile = join(dir, 'accounts.mjs')
  await build({ entryPoints: ['src/main/includedAccounts.ts'], outfile, bundle: true, platform: 'node', format: 'esm', plugins: [{
    name: 'fixture-paths', setup(b) {
      b.onResolve({ filter: /^\.\/(config|which)$/ }, (a) => ({ path: a.path, namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({ contents: a.path === './config'
        ? `export const projectsRoot=()=>${JSON.stringify(dir)}` : 'export const which=()=>"fixture-node"' }))
    }
  }] })
  let live = 'one@example.test'
  let fail = false
  let mismatch = false
  let malformed = false
  let uses = 0
  childProcess.execFile = (_bin, args, options, callback) => {
    assert.equal(options.windowsHide, true)
    if (fail) return callback(new Error('SECRET FAILURE'), 'SECRET OUTPUT')
    if (malformed) return callback(null, 'SECRET invalid JSON')
    if (args[1] === 'use') { uses++; if (!mismatch) live = args[3]; return callback(null, 'unused helper output') }
    callback(null, JSON.stringify({
      claude: { live: null, saved: [] },
      codex: { live, tokens: 'SECRET', saved: ['one@example.test', 'two@example.test'].map(email => ({ email, plan: 'pro', auth: 'SECRET' })) }
    }))
  }
  syncBuiltinESMExports()
  const { includedAccounts } = await import(pathToFileURL(outfile).href)
  const status = await includedAccounts('local')
  assert.equal(JSON.stringify(status).includes('SECRET'), false); checks++
  const changed = await includedAccounts('local', { provider: 'codex', email: 'two@example.test' })
  assert.equal(changed.codex.live, 'two@example.test'); checks++
  assert.equal(uses, 1); checks++
  await assert.rejects(includedAccounts('local', { provider: 'codex', email: 'absent@example.test' }), /no longer available/); checks++
  await assert.rejects(includedAccounts('local', { provider: 'codex', email: 'one@example.test; echo SECRET' }), /Invalid saved account/); checks++
  await assert.rejects(includedAccounts('bad'), /Unknown computer/); checks++
  assert.equal(uses, 1); checks++
  mismatch = true
  await assert.rejects(includedAccounts('local', { provider: 'codex', email: 'one@example.test' }), /not confirmed/); checks++
  malformed = true
  await assert.rejects(includedAccounts('local'), (error) => error.message === 'Account status is unavailable'); checks++
  malformed = false
  fail = true
  await assert.rejects(includedAccounts('local'), (error) => !error.message.includes('SECRET')); checks++
  console.log(`${checks}/${checks} included-account checks passed`)
} finally {
  childProcess.execFile = originalExec
  syncBuiltinESMExports()
  rmSync(dir, { recursive: true, force: true })
}
