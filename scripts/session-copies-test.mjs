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
  // The main folder of a project the card's name already says is not worth a word
  // (Robert 2026-09-23: cards too cluttered); a card named for something else still says it.
  assert.equal(text(render({ ...session, cwd: '/projects/taskdriver.ai', lane: undefined }, [])), '', 'main folder of the named project draws nothing')
  assert.equal(text(render({ ...session, title: 'echo rail', cwd: '/projects/taskdriver.ai', lane: undefined }, [])), 'taskdriver.ai', 'a card named for something else says its project')
  const assistant = { ...session, cwd: '/projects/assistant', lane: undefined, title: 'assistant' }
  const assistantBoard = { repo: '/projects/assistant', lanes: [{ ...held, lane: 'e', dir: '/projects/assistant-e' }] }
  assert.equal(text(render(assistant, [assistantBoard])), 'copy 6', 'a single visible session retains its actual assigned slot')
  const cross = { repo: '/projects/PaneForge', lanes: [{ ...held, lane: 'd', dir: '/projects/PaneForge-d' }] }
  // ONE chip per card. A chat that has visited other projects holds a work folder in each,
  // and a chip apiece wrapped the card onto extra rows until three cards filled the sidebar
  // (Robert, 2026-09-17). The other holds move into the tooltip, where they cost no height.
  assert.equal(text(render(assistant, [assistantBoard, cross])), 'copy 6', 'a card wears one work folder, whatever else the chat holds')
  assert.match(render(assistant, [assistantBoard, cross]), /also holding a work folder in/, '...and the others are named in its tooltip')
  assert.match(render(assistant, [assistantBoard, cross]), /PaneForge copy 5/, '...by project and copy number')
  assert.equal(text(render(assistant, [cross, assistantBoard])), text(render(assistant, [assistantBoard, cross])), 'board order does not change what is drawn')
  assert.doesNotMatch(render(assistant, [assistantBoard]), /also holding a work folder in/, 'a chat holding one folder says nothing extra')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, peer: true }] }])), 'copy 2', 'remote claims never change a local work folder')
  assert.equal(text(render(session, [{ ...board, lanes: [{ ...held, ownerPane: 'other' }] }])), 'copy 2', 'another session does not change the badge')
  assert.equal(text(render({ ...session, cwd: held.dir, lane: undefined })), 'copy 3', 'restored lane without optional metadata shows its one assigned folder')
  const opened = []
  const tree = Copies({ session, boards: [board], onOpen: p => opened.push(p) })
  let stopped = false
  tree.props.children[0].props.onClick({ stopPropagation() { stopped = true } })
  assert.deepEqual(opened, ['/projects/taskdriver.ai-b'], 'click inspects assigned folder, not launch folder')
  assert.equal(stopped, true)
  // Stuck is the dot's colour and the hover's word, not a word after the label.
  const stuck = render(session, [{ ...board, lanes: [{ ...held, conflicted: true }] }])
  assert.equal(text(stuck), 'copy 3')
  assert.match(stuck, /class="row-lane lane-chip stuck"/, 'a stuck copy is marked')
  assert.match(stuck, /lane-dot/, '...with its dot')
  assert.match(stuck, /Stuck: its changes clash/, '...and says why on hover')
  console.log('session copies: 20 checks passed')
} finally { rmSync(work, { recursive: true, force: true }) }
