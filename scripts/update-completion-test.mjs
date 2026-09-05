// Execute the shipped IPC callback with controlled updater/version results.
// No installer or CLI is launched by this test.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync, transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const from = source.indexOf("ipcMain.handle('agents:update'")
assert.ok(from >= 0)
const code = transformSync(source.slice(from, source.indexOf('\n})', from) + 3), { loader: 'ts' }).code
const bundled = buildSync({ entryPoints: [join(root, 'src/shared/codexCatalogue.ts')], bundle: true, format: 'esm', write: false })
const { versionOf, isOutdated } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
let checks = 0
async function run(over = {}) {
  const opts = { id: 'codex', code: 0, found: true, fresh: '0.153.3', before: '0.146.0', latest: '0.153.3', ...over }
  const events = [], installing = new Set()
  let handler, probes = 0
  const bindings = {
    ipcMain: { handle: (_name, callback) => { handler = callback } }, installing,
    specFor: (id) => ({ id, bin: id, label: id === 'codex' ? 'Codex' : 'Claude' }),
    updateCommand: () => 'fixture update',
    send: (_name, event) => events.push(event),
    codexInstalledVersion: () => opts.before,
    runOnce: async (_command, say) => { if (opts.locked) say('EBUSY: locked'); return opts.code },
    onPath: () => opts.found,
    execFile: (_bin, args, settings, done) => {
      probes++
      assert.deepEqual(args, ['--version'])
      assert.ok(settings.timeout > 0 && settings.timeout <= 8000)
      queueMicrotask(() => done(opts.queryError ? new Error('probe failed') : null, `codex-cli ${opts.fresh}`))
    },
    versionOf, isOutdated, codexLatest: () => opts.latest,
    refreshPath() {}, forgetCodexVersion() {}, invalidateAgents() {}
  }
  new Function(...Object.keys(bindings), code)(...Object.values(bindings))
  await handler(null, opts.id)
  assert.equal(installing.size, 0)
  assert.equal(events.filter((e) => e.done).length, 1)
  checks++
  return { ...events.at(-1), probes }
}
let result = await run({ code: 1 })
assert.equal(result.ok, false)
assert.equal(result.probes, 0)
assert.match(result.chunk, /exited with code 1.*existing binary is still on PATH/)
result = await run({ id: 'claude', code: 1 })
assert.equal(result.ok, false, 'non-Codex failure must also remain a failure')
assert.doesNotMatch(result.chunk, /up to date/)
result = await run({ fresh: '0.150.0' })
assert.equal(result.ok, false)
assert.match(result.chunk, /still behind/)
result = await run()
assert.equal(result.ok, true)
assert.equal(result.probes, 1)
result = await run({ before: '0.153.3' })
assert.equal(result.ok, true, 'already-current update is a successful no-op')
result = await run({ queryError: true })
assert.equal(result.ok, false)
assert.match(result.chunk, /version could not be verified/)
result = await run({ latest: '' })
assert.equal(result.ok, false)
assert.match(result.chunk, /latest release is unknown/)
assert.doesNotMatch(result.chunk, /up to date/)
result = await run({ locked: true })
assert.equal(result.ok, false)
assert.equal(result.probes, 0)
result = await run({ found: false })
assert.equal(result.ok, false)
assert.match(result.chunk, /no longer on PATH/)
result = await run({ id: 'claude' })
assert.equal(result.ok, true)
console.log(`update completion: ${checks} behavioral cases passed`)
