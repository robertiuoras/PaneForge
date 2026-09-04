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
const { takenFolders } = await import(pathToFileURL(out).href)

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
console.log('lane-taken: 3 ok')
