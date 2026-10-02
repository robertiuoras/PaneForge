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
  const render = (s = session, boards = [board]) => renderToStaticMarkup(React.createElement(Copies, { session: s, boards }))
  const text = html => html.replace(/<[^>]+>/g, '')
  const P = (project, copy) => project + (copy ?? '')
  assert.equal(text(render()), P('taskdriver.ai', 'copy 3'), 'opened copy 2 + assigned copy 3 renders the project and the assigned copy')
  assert.match(render(), /Session opened in taskdriver.ai copy 2/, 'launch folder remains inspectable')
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai-b', lane: 'b' })), P('taskdriver.ai', 'copy 3'), 'same assigned and opened copy is not doubled')
  // The PROJECT is always drawn, whatever the card is called (Robert 2026-09-23: "what
  // happens if session renamed then i dont know what project im in").
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai', lane: undefined }, [])), 'taskdriver.ai', 'a lone project folder is its name alone')
  assert.equal(text(render({ ...session, title: 'echo rail', cwd: '/projects/taskdriver.ai', lane: undefined }, [])), 'taskdriver.ai', 'a renamed card still says its project')
  assert.equal(text(render({ ...session, title: 'fix the sidebar', cwd: '/projects/PaneForge-c', lane: 'c' }, [])), P('PaneForge', 'copy 4'), 'a renamed card in a copy says project and copy')
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai', lane: undefined }, [{ ...board, lanes: [{ ...held, ownerPane: 'other' }] }])), P('taskdriver.ai', 'main copy'), 'the main folder of a project with copies says so')
  const assistant = { ...session, cwd: '/projects/assistant', lane: undefined, title: 'assistant' }
  const assistantBoard = { repo: '/projects/assistant', lanes: [{ ...held, lane: 'e', dir: '/projects/assistant-e' }] }
  assert.equal(text(render(assistant, [assistantBoard])), P('assistant', 'copy 6'), 'the hook-assigned copy wins over the folder the pane opened in')
  const cross = { repo: '/projects/PaneForge', lanes: [{ ...held, lane: 'd', dir: '/projects/PaneForge-d' }] }
  assert.equal(text(render(assistant, [assistantBoard, cross])), P('assistant', 'copy 6'), 'a card wears one work folder, whatever else the chat holds')
  assert.match(render(assistant, [assistantBoard, cross]), /also holding a work folder in/, '...and the others are named in its tooltip')
  assert.match(render(assistant, [assistantBoard, cross]), /PaneForge copy 5/, '...by project and copy number')
  assert.equal(text(render(assistant, [cross, assistantBoard])), text(render(assistant, [assistantBoard, cross])), 'board order does not change what is drawn')
  assert.doesNotMatch(render(assistant, [assistantBoard]), /also holding a work folder in/, 'a chat holding one folder says nothing extra')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, peer: true }] }])), P('taskdriver.ai', 'copy 2'), 'remote claims never change a local work folder')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, ownerPane: 'other' }] }])), P('taskdriver.ai', 'copy 2'), 'another session does not change the line')
  assert.equal(text(render({ ...session, cwd: held.dir, lane: undefined })), P('taskdriver.ai', 'copy 3'), 'restored lane without optional metadata shows its one assigned folder')
  assert.doesNotMatch(render(), /<button/, 'plain text: the copy dialog it opened is gone')
  assert.doesNotMatch(text(render()), /lane/, 'never the word lane on screen')
  const stuck = render(session, [{ ...board, lanes: [{ ...held, conflicted: true }] }])
  assert.equal(text(stuck), P('taskdriver.ai', 'copy 3'))
  assert.match(stuck, /class="row-lane stuck"/, 'a stuck copy is marked')
  assert.match(stuck, /lane-dot/, '...with its dot')
  assert.match(stuck, /Stuck: its changes clash/, '...and says why on hover')
  console.log('session copies: 21 checks passed')
} finally { rmSync(work, { recursive: true, force: true }) }
