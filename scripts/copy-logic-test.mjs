import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const root = resolve(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'pf-copy-logic-'))
const require = createRequire(import.meta.url)
globalThis.window = { api: {} }
function load(file, extra = '') {
  const outfile = join(dir, file.split('/').pop() + '.cjs')
  buildSync({ stdin: { contents: readFileSync(join(root, file), 'utf8') + extra, resolveDir: join(root, file, '..'), loader: 'tsx' }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], alias: { '@shared': join(root, 'src/shared') } })
  const Module = require('node:module'), loaded = new Module(outfile)
  loaded.filename = outfile; loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(readFileSync(outfile, 'utf8'), outfile)
  return loaded.exports
}
try {
  const { laneOwner, default: Strip } = load('src/renderer/src/components/LaneStrip.tsx')
  const asleep = { id: 'sleep', status: 'exited', asleep: true, cwd: '/p/repo-a' }
  const lane = { lane: 'a', dir: asleep.cwd, ownerPane: asleep.id, held: true, seen: Date.now() }
  assert.equal(laneOwner(lane, [asleep]), asleep, 'sleeping pane retains its copy ownership')
  assert.equal(laneOwner(lane, [{ ...asleep, asleep: false }]), undefined, 'closed pane does not retain visible ownership')
  const html = renderToStaticMarkup(React.createElement(Strip, { boards: [{ repo: '/p/repo', lanes: [lane] }], sessions: [asleep] }))
  assert.equal(html, '', 'sleeping pane is not counted again under Other copies')
  const { CopyRow } = load('src/renderer/src/components/LaneDialog.tsx', '\nexport { CopyRow };')
  const row = renderToStaticMarkup(React.createElement(CopyRow, { copy: { dir: '/p/repo-a', slot: 'a', self: false, trunk: false, work: null }, onFocus() {} }))
  assert.match(row, /could not be inspected/i, 'a failed inspection never claims an empty copy')
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  // To the end of that one declaration, not to the next landmark further down the file:
  // slicing as far as `ipcMain.handle('lanes:board'` swallowed whatever was written
  // between them, and the first thing that ever was - a typed arrow feeding the copy
  // timeline - made `new Function` a SyntaxError about a file this test does not name.
  const from = main.indexOf('const lanePanes =')
  const expr = main.slice(from, main.indexOf('\n\n', from))
  const lanePanes = new Function('manager', 'resumeIdFor', expr.replace(': LanePane[]', '') + '; return lanePanes')({ list: () => [asleep, { ...asleep, id: 'closed', asleep: false }] }, id => id)
  assert.deepEqual(lanePanes().map(p => p.id), ['sleep'], 'backend supplies sleeping panes to ownership matching')
  console.log('copy logic: 5 checks passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
