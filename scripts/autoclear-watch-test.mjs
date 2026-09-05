// Executes the shipped watcher policy through its exported tick, with a manager-shaped
// fixture. It deliberately has no pty methods: a context estimate must never cause a
// prompt or clear in a non-Claude session.
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
// Keep the bundle below the repository so Node resolves the installed Electron package.
const out = mkdtempSync(join(root, '.autoclear-watch-'))
const file = join(out, 'watch.mjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/autoclearWatch.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  outfile: file,
  logLevel: 'warning'
})
// The exercised tick receives its config directly, so Electron's app singleton is never
// used. Replace just that runtime import for plain-node execution of the bundled module.
writeFileSync(
  file,
  readFileSync(file, 'utf8').replace(/import \{ app(?: as (\w+))? \} from "electron";/g, (_m, alias) => `const ${alias || 'app'} = { getPath: () => "" };`)
)
const { runAutoClearWatchTick } = await import(pathToFileURL(file).href)

const cfg = { tokens: 150_000, seconds: 15, watchNonClaude: true }
const pane = (id, agent, status = 'idle') => ({ id, agent, status, cwd: '/tmp/project', createdAt: 1 })
const calls = []
const run = (panes) => runAutoClearWatchTick({ list: () => panes }, cfg, (line) => calls.push(line))

run([pane('codex-high', 'codex')])
assert.equal(calls.length, 1)
assert.match(calls[0], /Codex uses native context compaction/)
run([pane('codex-high', 'codex', 'working')])
assert.equal(calls.length, 1, 'busy Codex does not gain a reset path or repeated log')
run([pane('antigravity-high', 'antigravity')])
assert.equal(calls.length, 2)
assert.match(calls[1], /no session-owned handoff proof/)
run([pane('unknown', 'aider'), pane('claude', 'claude')])
assert.equal(calls.length, 2, 'unknown and Claude-hook agents are untouched')
run([pane('codex-draft', 'codex')])
assert.equal(calls.length, 3, 'a Codex pane is skipped before any draft/context inspection')

rmSync(out, { recursive: true, force: true })
console.log('autoclear watch: native policy leaves all non-Claude panes unprompted and unarmed')
