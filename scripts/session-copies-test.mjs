import { buildSync } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const work = mkdtempSync(join(tmpdir(), 'pf-session-copies-'))
try {
  const outfile = join(work, 'copies.cjs')
  buildSync({ absWorkingDir: root, entryPoints: ['src/renderer/src/components/SessionCopies.tsx'], outfile,
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
    alias: { '@shared': join(root, 'src/shared') } })
  // Resolve React from this checkout even though the temporary bundle is elsewhere.
  const require = createRequire(import.meta.url)
  const Module = require('node:module')
  const loaded = new Module(outfile)
  loaded.filename = outfile
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(require('node:fs').readFileSync(outfile, 'utf8'), outfile)
  const Copies = loaded.exports.default
  const session = { id: 'pane1', cwd: '/projects/taskdriver.ai-a', lane: 'a', title: 'taskdriver.ai' }
  const held = { lane: 'b', dir: '/projects/taskdriver.ai-b', ownerPane: 'pane1', held: true, seen: Date.now(), peer: false }
  const board = { repo: '/projects/taskdriver.ai', lanes: [held] }
  const render = (s = session, boards = [board]) => renderToStaticMarkup(React.createElement(Copies, { session: s, boards, onOpen() {} }))
  const text = html => html.replace(/<[^>]+>/g, '')
  assert.equal(text(render()), 'copy 3', 'opened copy 2 + assigned copy 3 renders only assigned copy')
  assert.match(render(), /Session opened in copy 2/, 'launch folder remains inspectable')
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai-b', lane: 'b' })), 'copy 3', 'same assigned and opened copy is not doubled')
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai', lane: undefined }, [])), 'main copy')
  const assistant = { ...session, cwd: '/projects/assistant', lane: undefined, title: 'assistant' }
  const assistantBoard = { repo: '/projects/assistant', lanes: [{ ...held, lane: 'e', dir: '/projects/assistant-e' }] }
  assert.equal(text(render(assistant, [assistantBoard])), 'copy 6', 'a single visible session retains its actual assigned slot')
  const cross = { repo: '/projects/PaneForge', lanes: [{ ...held, lane: 'd', dir: '/projects/PaneForge-d' }] }
  assert.equal(text(render(assistant, [assistantBoard, cross])), 'copy 6PaneForge copy 5', 'cross-project assignments keep project names and do not overwrite each other')
  assert.equal(text(render(assistant, [cross, assistantBoard])), text(render(assistant, [assistantBoard, cross])), 'board order does not hide assignments')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, peer: true }] }])), 'copy 2', 'remote claims never change a local work folder')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, ownerPane: 'other' }] }])), 'copy 2', 'another session does not change the badge')
  assert.equal(text(render({ ...session, cwd: held.dir, lane: undefined })), 'copy 3', 'restored lane without optional metadata shows its one assigned folder')
  const opened = []
  const tree = Copies({ session, boards: [board], onOpen: p => opened.push(p) })
  let stopped = false
  tree.props.children[0].props.onClick({ stopPropagation() { stopped = true } })
  assert.deepEqual(opened, ['/projects/taskdriver.ai-b'], 'click inspects assigned folder, not launch folder')
  assert.equal(stopped, true)
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, conflicted: true }] }])), 'copy 3 stuck')
  console.log('session copies: 13 checks passed')
} finally { rmSync(work, { recursive: true, force: true }) }
