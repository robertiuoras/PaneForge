import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-taken-test')
mkdirSync(root, { recursive: true })
const out = join(root, 'laneTaken.mjs')
buildSync({ entryPoints: [resolve(here, '../src/shared/laneTaken.ts')], outfile: out, bundle: true, format: 'esm', platform: 'node' })
const { takenFolders, wakeClashes } = await import(pathToFileURL(out).href)

const rows = [
  { cwd: '/p/clients', status: 'exited', asleep: 1_700_000_000_000 },
  { cwd: '/p/clients-a', status: 'exited' },
  { cwd: '/p/assistant', status: 'idle' },
  { cwd: '/p/paneforge', status: 'working' }
]
const taken = takenFolders(rows)
assert.ok(taken.includes('/p/clients'), 'an asleep pane keeps its folder taken')
assert.ok(!taken.includes('/p/clients-a'), 'a pane that exited frees its folder')
assert.deepEqual(taken, ['/p/clients', '/p/assistant', '/p/paneforge'])
// Two panes restored asleep into one folder: waking either must move it, and a pane
// must never clash with its own sleeping self.
const twins = [
  { id: 's1', cwd: '/p/clients', status: 'exited', asleep: 1 },
  { id: 's3', cwd: '/p/clients', status: 'exited', asleep: 1 },
  { id: 's2', cwd: '/p/car', status: 'idle' }
]
assert.equal(wakeClashes(twins, 's3', '/p/clients'), true, 'waking beside another sleeping pane clashes')
assert.equal(wakeClashes(twins.slice(1), 's3', '/p/clients'), false, 'a pane alone in its folder does not clash with itself')
assert.equal(wakeClashes(twins, 's2', '/p/car'), false)
assert.equal(wakeClashes([{ id: 's1', cwd: '/P/Clients', status: 'idle' }], 's3', '/p/clients', (a, b) => a.toLowerCase() === b.toLowerCase()), true, 'same folder, different case')
assert.ok(!takenFolders(twins, 's1').includes('/p/clients') || takenFolders(twins, 's1').length === 2, 'except drops only that pane')
console.log('lane-taken: 8 ok')
