import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// Codex switches between a chat's subagents on Alt+Left / Alt+Right. xterm.js sends
// Ctrl+Left (ESC[1;5D) for Alt+Left everywhere but a Mac, which Codex ignores.
const helper = readFileSync(new URL('../src/shared/codexKeys.ts', import.meta.url), 'utf8')
const { codexAltArrow } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(helper, { loader: 'ts', format: 'esm' }).code).toString('base64'))
const key = (k, mods = {}) => ({ key: k, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...mods })
assert.equal(codexAltArrow('codex', key('ArrowLeft'), false), '\x1b[1;3D', 'PC Codex pane: Alt+Left reaches Codex as Alt+Left')
assert.equal(codexAltArrow('codex', key('ArrowRight'), false), '\x1b[1;3C', 'PC Codex pane: Alt+Right reaches Codex as Alt+Right')
assert.equal(codexAltArrow('codex', key('ArrowLeft'), true), undefined, 'Mac: xterm already sends ESC b, which Codex reads')
assert.equal(codexAltArrow('claude', key('ArrowLeft'), false), undefined, 'other agents keep the word jump')
assert.equal(codexAltArrow(undefined, key('ArrowLeft'), false), undefined, 'a shell keeps the word jump')
assert.equal(codexAltArrow('codex', key('ArrowLeft', { shiftKey: true }), false), undefined, 'Alt+Shift+Left is not the switch')
assert.equal(codexAltArrow('codex', key('ArrowLeft', { ctrlKey: true }), false), undefined, 'Ctrl+Alt+Left is not the switch')
assert.equal(codexAltArrow('codex', key('ArrowUp'), false), undefined, 'only left and right')
assert.equal(codexAltArrow('codex', key('ArrowLeft', { altKey: false }), false), undefined, 'plain Left is untouched')

// The pane must send it BEFORE the handler hands every Alt key back to xterm, or xterm's
// ESC[1;5D still goes out.
const pane = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const handler = pane.slice(pane.indexOf('t.attachCustomKeyEventHandler('))
const call = handler.indexOf('codexAltArrow(agentRef.current, e, isMac)')
const altBail = handler.search(/e\.altKey\) return true/)
assert(call > 0, 'TerminalPane key handler calls codexAltArrow')
assert(altBail > 0 && call < altBail, 'codexAltArrow runs before the Alt early return')
console.log('Codex Alt+Left/Right: PC Codex panes send the subagent switch; Mac, shells and other agents unchanged')
